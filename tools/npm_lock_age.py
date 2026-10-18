#!/usr/bin/env python3
"""npm_lock_age.py LOCKFILE... [options]: refuse npm package versions younger than 14 days in a lockfile.

Why: `min-release-age=14` in .npmrc only constrains npm's RESOLVER (npm >= 11.19). `npm ci` installs whatever the
lockfile says, so a young version that got into package-lock.json installs fine. Measured 2026-10-14: `npm ci`
installed a locked young version with the rule on. The lockfile diff is therefore the real gate, and this is it.

Python standard library only; runs no npm. For every registry package in a package-lock.json (lockfileVersion 2 or 3)
it needs the registry's publish time for that exact version (registry `time[version]`, which never changes, so answers
are cached forever in a JSON file, default <user cache dir>/squatch-npm-lock-age/ages.json, keyed name@ver plus the lockfile's
integrity: a cache entry whose integrity differs is ignored).

  --base REF   only check entries that are new or changed against REF's copy of the same lockfile (a PR check: old
               entries that predate this rule are not re-judged). Without it every entry is checked.
  --cache-only never touch the network (entries missing from the cache are AGE_UNKNOWN).

Exit 0 = every checked version is old enough or excepted. Exit 1 = refused, one line per finding:
[TOO_YOUNG] [AGE_UNKNOWN] [SOURCE] [EXCEPTIONS] [MIN_DAYS]. Unknown age is refused, never allowed.

Exceptions (small, explicit, expiring): tools/npm-lock-age-exceptions.toml, or --exceptions FILE:
  [[allow_young]]
  name = "undici"; version = "7.99.1"; integrity = "sha512-..."
  reason = "GHSA-xxxx fix"; approver = "owner"; expires = "2026-11-01"
Every field is required; approver must be exactly "owner" (same rule as the Rust gate's crate_age.py); an entry only
matches its exact name, version and integrity, and only until `expires`. Add one only after the owner's review.
"""
import argparse
import concurrent.futures as cf
import dataclasses
import datetime as dt
import json
import os
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MIN_DAYS_FLOOR = 14
REGISTRY = "https://registry.npmjs.org"
UA = "squatch-npm-lock-age/1"
BACKOFF = 1.0   # seconds; tests set 0
EXC_FIELDS = ("name", "version", "integrity", "reason", "approver", "expires")
HERE = Path(__file__).resolve().parent
DEFAULT_EXC = HERE / "npm-lock-age-exceptions.toml"


def parse_ts(s: str) -> dt.datetime:
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def name_of(path: str, entry: dict) -> str:
    return entry.get("name") or path.rsplit("node_modules/", 1)[-1]


def lock_packages(text: str, registry: str = REGISTRY) -> tuple[dict, list[str]]:
    """({(name, ver): integrity} for registry packages, [problems]). Git, tarball and file sources are refused."""
    doc = json.loads(text)
    pkgs = doc.get("packages")
    if pkgs is None:
        return {}, ["lockfileVersion 1 has no `packages` map; regenerate with npm >= 11"]
    reg, bad = {}, []
    for path, e in pkgs.items():
        if path == "" or e.get("link") or "node_modules/" not in path:
            continue  # the root, a workspace link, or a workspace member directory
        name, ver = name_of(path, e), e.get("version", "?")
        res = e.get("resolved", "")
        if not res.startswith(registry + "/"):
            bad.append(f"{name} {ver}: resolved {res or '(none)'!r} is not {registry} (no publish time to check)")
        elif not e.get("integrity"):
            bad.append(f"{name} {ver}: registry package without an integrity hash")
        else:
            reg[(name, ver)] = e["integrity"]
    return reg, bad


def base_text(lock: Path, base: str) -> str | None:
    """The lockfile as it is at REF, or None when REF does not have it (a new lockfile: check everything)."""
    top = subprocess.run(["git", "-C", str(lock.parent), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if top.returncode:
        return None
    rel = os.path.relpath(lock.resolve(), Path(top.stdout.strip()).resolve())
    out = subprocess.run(["git", "-C", str(lock.parent), "show", f"{base}:{rel}"], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def _exception(i: int, e: dict, path: Path, now: dt.datetime):
    """(key, entry) for a valid unexpired entry; (None, problem) for a bad one; (None, None) for an expired one."""
    miss = [k for k in EXC_FIELDS if not str(e.get(k, "")).strip()]
    if miss:
        return None, f"{path} allow_young[{i}]: missing {', '.join(miss)}"
    if str(e["approver"]).strip().lower() != "owner":
        return None, f"{path} allow_young[{i}]: approver must be 'owner' (got {e['approver']!r})"
    try:
        exp = parse_ts(str(e["expires"]) + ("T00:00:00Z" if len(str(e["expires"])) == 10 else ""))
    except ValueError:
        return None, f"{path} allow_young[{i}]: expires {e['expires']!r} is not a date"
    if exp <= now:
        return None, None  # expired: the entry no longer excuses anything
    return (e["name"], e["version"], e["integrity"]), e


def load_exceptions(path: Path | None, now: dt.datetime) -> tuple[dict, list[str]]:
    if path is None or not path.is_file():
        return {}, []
    try:
        doc = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as e:
        return {}, [f"{path}: invalid TOML: {e}"]
    out, problems = {}, []
    for i, e in enumerate(doc.get("allow_young", [])):
        key, val = _exception(i, e, path, now)
        if key:
            out[key] = val
        elif val:
            problems.append(val)
    return out, problems


def fetch_time(name: str, ver: str, registry: str) -> str | None:
    url = f"{registry}/{urllib.parse.quote(name, safe='@')}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r).get("time", {}).get(ver)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(BACKOFF * 2 ** attempt)
        except (urllib.error.URLError, TimeoutError, ValueError):
            time.sleep(BACKOFF * 2 ** attempt)
    return None


def load_cache(p: Path) -> dict:
    try:
        return json.loads(p.read_text()) if p.is_file() else {}
    except ValueError:
        return {}


@dataclasses.dataclass
class Opts:
    cache_path: Path
    exceptions: Path | None = None
    min_days: int = MIN_DAYS_FLOOR
    now: dt.datetime = dataclasses.field(default_factory=lambda: dt.datetime.now(dt.timezone.utc))
    cache_only: bool = False
    registry: str = REGISTRY
    base: str | None = None
    workers: int = 8


def old_entries(lock: Path, o: Opts) -> tuple[dict, set]:
    """({(name, ver): integrity}, {"name ver" with a bad source}) the lockfile already had at --base (empty without
    --base or when the lockfile is new)."""
    bt = base_text(lock, o.base) if o.base else None
    try:
        reg, bad = lock_packages(bt, o.registry) if bt is not None else ({}, [])
    except ValueError:
        return {}, set()
    return reg, {b.split(": ", 1)[0] for b in bad}


def wanted(locks: list[Path], o: Opts) -> tuple[dict, list[str]]:
    """({(name, ver, integrity): lockfile} to judge, findings for unreadable lockfiles and foreign sources)."""
    want, findings = {}, []
    for lock in locks:
        try:
            reg, bad = lock_packages(lock.read_text(), o.registry)
        except (OSError, ValueError) as e:
            findings.append(f"[SOURCE] {lock}: unreadable lockfile: {e}")
            continue
        old, old_bad = old_entries(lock, o)
        findings += [f"[SOURCE] {lock}: {b}" for b in bad if b.split(": ", 1)[0] not in old_bad]
        for (n, v), integ in reg.items():
            if old.get((n, v)) != integ:   # new, or the same version with different bytes
                want.setdefault((n, v, integ), str(lock))
    return want, findings


def fill_cache(want: dict, o: Opts) -> dict:
    cache = load_cache(o.cache_path)
    todo = [k for k in sorted(want) if cache.get(f"{k[0]}@{k[1]}", {}).get("integrity") != k[2]
            or not cache.get(f"{k[0]}@{k[1]}", {}).get("published")]
    if todo and not o.cache_only:
        with cf.ThreadPoolExecutor(o.workers) as ex:
            for k, t in zip(todo, ex.map(lambda k: fetch_time(k[0], k[1], o.registry), todo)):
                if t:
                    cache[f"{k[0]}@{k[1]}"] = {"published": t, "integrity": k[2]}
        o.cache_path.parent.mkdir(parents=True, exist_ok=True)
        o.cache_path.write_text(json.dumps(cache, indent=1, sort_keys=True))
    return cache


def judge(item: tuple, e: dict | None, exc: dict, o: Opts, log) -> str | None:
    name, ver, integ, lock = item
    if not e or e.get("integrity") != integ:
        why = "no cached publish time" if o.cache_only else "the registry gave no publish time"
        return f"[AGE_UNKNOWN] {lock}: {name} {ver}: {why} (unknown age is refused)"
    try:
        age = o.now - parse_ts(e["published"])
    except ValueError:
        return f"[AGE_UNKNOWN] {lock}: {name} {ver}: time {e['published']!r} is not ISO 8601"
    if age < dt.timedelta(0):
        return f"[AGE_UNKNOWN] {lock}: {name} {ver}: published in the future"
    if age >= dt.timedelta(days=o.min_days):
        return None
    x = exc.get((name, ver, integ))
    if x:
        log(f"excepted: {name} {ver} is {age.days} days old; {x['reason']} "
            f"(approver {x['approver']}, expires {x['expires']})")
        return None
    return (f"[TOO_YOUNG] {lock}: {name} {ver}: published {age.days} days ago "
            f"({e['published']}); minimum is {o.min_days} days")


def check(locks: list[Path], o: Opts, log=print) -> list[str]:
    if o.min_days < MIN_DAYS_FLOOR:
        return [f"[MIN_DAYS] minimum age {o.min_days} is below the floor of {MIN_DAYS_FLOOR} days"]
    exc, eprob = load_exceptions(o.exceptions, o.now)
    want, findings = wanted(locks, o)
    cache = fill_cache(want, o)
    findings = [f"[EXCEPTIONS] {p}" for p in eprob] + findings
    for (name, ver, integ), lock in sorted(want.items()):
        f = judge((name, ver, integ, lock), cache.get(f"{name}@{ver}"), exc, o, log)
        if f:
            findings.append(f)
    return findings


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("locks", type=Path, nargs="+")
    ap.add_argument("--min-days", type=int, default=MIN_DAYS_FLOOR)
    ap.add_argument("--base", default=None, help="git ref: check only entries new or changed against it")
    ap.add_argument("--cache", type=Path, default=Path(os.environ.get(
        "NPM_LOCK_AGE_CACHE", Path.home() / ".cache" / "squatch-npm-lock-age" / "ages.json")))
    ap.add_argument("--exceptions", type=Path, default=DEFAULT_EXC)
    ap.add_argument("--cache-only", action="store_true")
    ap.add_argument("--now", default=None, help="ISO time (tests only)")
    ap.add_argument("--registry", default=os.environ.get("NPM_LOCK_AGE_REGISTRY", REGISTRY))
    a = ap.parse_args(argv)
    now = parse_ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    opts = Opts(a.cache, a.exceptions, a.min_days, now, a.cache_only, a.registry.rstrip("/"), a.base)
    out = check(a.locks, opts, log=lambda m: print(m, file=sys.stderr))
    for line in out:
        print(line)
    if out:
        print(f"npm_lock_age: REFUSED ({len(out)} finding(s))", file=sys.stderr)
        return 1
    print("npm_lock_age: ok", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
