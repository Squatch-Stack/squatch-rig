"""Tests for tools/npm_lock_age.py: a local fake registry, a throwaway git repo, no network.
Run: python3 -m unittest discover -s tools/test -v"""
import contextlib
import datetime as dt
import http.server
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import npm_lock_age as m  # noqa: E402

m.BACKOFF = 0
NOW = "2026-10-14T12:00:00Z"
TIMES = {"old": "2026-08-01T00:00:00.000Z", "young": "2026-10-10T00:00:00.000Z",
         "edge13": "2026-10-01T13:00:00.000Z", "edge14": "2026-09-30T11:00:00.000Z"}
HITS: list[str] = []


class Registry(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        name = self.path[1:].lower().replace("%2f", "/")
        pkg = name.split("/")[-1]
        if pkg not in TIMES and pkg != "scoped":
            self.send_response(404); self.end_headers(); return
        t = TIMES.get(pkg, TIMES["old"])
        body = json.dumps({"time": {"1.0.0": t}}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


def lock(pkgs: dict, registry: str) -> str:
    out = {"": {"name": "x", "version": "1.0.0"}}
    for path, extra in pkgs.items():
        out[path] = {"version": "1.0.0", "integrity": "sha512-" + path[-3:], **extra}
        out[path].setdefault("resolved", f"{registry}/{path.rsplit('node_modules/', 1)[-1]}/-/x-1.0.0.tgz")
    return json.dumps({"lockfileVersion": 3, "packages": out})


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Registry)
        cls.reg = f"http://127.0.0.1:{cls.srv.server_port}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cache = self.tmp / "cache.json"
        HITS.clear()

    def run_check(self, text, exc=None, base=None, **kw):
        lf = self.tmp / "package-lock.json"
        lf.write_text(text)
        o = m.Opts(self.cache, exc, kw.pop("min_days", 14), m.parse_ts(NOW), kw.pop("cache_only", False), self.reg, base)
        return m.check([lf], o, log=lambda s: None)


class Age(Base):
    def test_old_passes(self):
        self.assertEqual(self.run_check(lock({"node_modules/old": {}}, self.reg)), [])

    def test_young_refused(self):
        f = self.run_check(lock({"node_modules/young": {}}, self.reg))
        self.assertEqual(len(f), 1)
        self.assertIn("[TOO_YOUNG]", f[0])
        self.assertIn("young 1.0.0", f[0])

    def test_boundary_14_days(self):
        self.assertEqual(len(self.run_check(lock({"node_modules/edge13": {}}, self.reg))), 1)   # 13d23h
        self.assertEqual(self.run_check(lock({"node_modules/edge14": {}}, self.reg)), [])       # 14d01h

    def test_scoped_package_uses_encoded_url(self):
        self.assertEqual(self.run_check(lock({"node_modules/@a/scoped": {}}, self.reg)), [])
        self.assertTrue(any("@a%2fscoped" in h.lower() for h in HITS), HITS)

    def test_nested_dependency_name(self):
        f = self.run_check(lock({"node_modules/old/node_modules/young": {}}, self.reg))
        self.assertIn("young 1.0.0", f[0])

    def test_unknown_package_is_refused(self):
        f = self.run_check(lock({"node_modules/ghost": {}}, self.reg))
        self.assertIn("[AGE_UNKNOWN]", f[0])

    def test_registry_down_is_refused_not_passed(self):
        lf = self.tmp / "package-lock.json"
        lf.write_text(lock({"node_modules/old": {}}, "http://127.0.0.1:9"))
        f = m.check([lf], m.Opts(self.cache, None, 14, m.parse_ts(NOW), False, "http://127.0.0.1:9"), log=print)
        self.assertIn("[AGE_UNKNOWN]", f[0])

    def test_min_days_floor(self):
        self.assertIn("[MIN_DAYS]", self.run_check(lock({}, self.reg), min_days=1)[0])

    def test_git_and_tarball_sources_refused(self):
        for res in ("git+https://github.com/a/b.git#abc", "https://evil.example/x.tgz", ""):
            f = self.run_check(lock({"node_modules/old": {"resolved": res}}, self.reg))
            self.assertIn("[SOURCE]", f[0], res)

    def test_workspace_link_and_root_ignored(self):
        t = lock({"node_modules/w": {"link": True, "resolved": "w"}, "w": {}}, self.reg)
        self.assertEqual(self.run_check(t), [])

    def test_lockfile_v1_refused(self):
        f = self.run_check(json.dumps({"lockfileVersion": 1, "dependencies": {}}))
        self.assertTrue(any("lockfileVersion 1" in x for x in f), f)


class Cache(Base):
    def test_cache_hit_skips_network(self):
        t = lock({"node_modules/old": {}}, self.reg)
        self.run_check(t)
        n = len(HITS)
        self.run_check(t)
        self.assertEqual(len(HITS), n)
        self.assertEqual(self.run_check(t, cache_only=True), [])

    def test_cache_only_without_entry_refused(self):
        f = self.run_check(lock({"node_modules/old": {}}, self.reg), cache_only=True)
        self.assertIn("[AGE_UNKNOWN]", f[0])

    def test_cache_entry_with_other_integrity_is_ignored(self):
        self.cache.write_text(json.dumps({"young@1.0.0": {"published": TIMES["old"], "integrity": "sha512-other"}}))
        f = self.run_check(lock({"node_modules/young": {}}, self.reg))   # integrity 'sha512-ung' != cached
        self.assertIn("[TOO_YOUNG]", f[0])


class Exceptions(Base):
    def exc(self, **over):
        e = {"name": "young", "version": "1.0.0", "integrity": "sha512-ung", "reason": "GHSA-test",
             "approver": "owner", "expires": "2026-10-20"} | over
        p = self.tmp / "exc.toml"
        p.write_text("[[allow_young]]\n" + "".join(f'{k} = "{v}"\n' for k, v in e.items()))
        return p

    t = lambda self: lock({"node_modules/young": {}}, self.reg)  # noqa: E731

    def test_valid_exception_allows(self):
        self.assertEqual(self.run_check(self.t(), self.exc()), [])

    def test_wrong_approver_refused(self):
        f = self.run_check(self.t(), self.exc(approver="agent"))
        self.assertTrue(any("[EXCEPTIONS]" in x for x in f) and any("[TOO_YOUNG]" in x for x in f), f)

    def test_expired_exception_no_longer_allows(self):
        self.assertIn("[TOO_YOUNG]", self.run_check(self.t(), self.exc(expires="2026-10-14"))[0])

    def test_other_integrity_not_excused(self):
        self.assertIn("[TOO_YOUNG]", self.run_check(self.t(), self.exc(integrity="sha512-zzz"))[0])

    def test_other_version_not_excused(self):
        self.assertIn("[TOO_YOUNG]", self.run_check(self.t(), self.exc(version="2.0.0"))[0])

    def test_missing_field_reported(self):
        f = self.run_check(self.t(), self.exc(reason=""))
        self.assertTrue(any("missing reason" in x for x in f), f)

    def test_shipped_exceptions_file_is_empty_and_valid(self):
        ex, prob = m.load_exceptions(m.DEFAULT_EXC, m.parse_ts(NOW))
        self.assertEqual((ex, prob), ({}, []))


class Base_(Base):
    def git(self, *a):
        subprocess.run(["git", "-C", str(self.tmp), "-c", "user.name=t", "-c", "user.email=t" + chr(64) + "example.invalid", *a],
                       check=True, capture_output=True)

    def test_base_only_judges_new_entries(self):
        self.git("init", "-q", "-b", "main")
        (self.tmp / "package-lock.json").write_text(lock({"node_modules/young": {}}, self.reg))
        self.git("add", "package-lock.json"); self.git("commit", "-qm", "base")
        # unchanged young entry predates the rule: not re-judged; a newly added one is
        t = lock({"node_modules/young": {}, "node_modules/edge13": {}}, self.reg)
        f = self.run_check(t, base="HEAD")
        self.assertEqual(len(f), 1)
        self.assertIn("edge13", f[0])

    def test_base_same_version_new_integrity_is_rejudged(self):
        self.git("init", "-q", "-b", "main")
        (self.tmp / "package-lock.json").write_text(lock({"node_modules/young": {}}, self.reg))
        self.git("add", "package-lock.json"); self.git("commit", "-qm", "base")
        f = self.run_check(lock({"node_modules/young": {"integrity": "sha512-NEW"}}, self.reg), base="HEAD")
        self.assertIn("[TOO_YOUNG]", f[0])

    def test_base_foreign_source_only_flagged_when_new(self):
        self.git("init", "-q", "-b", "main")
        git_dep = {"resolved": "git+https://github.com/a/b.git#abc"}
        (self.tmp / "package-lock.json").write_text(lock({"node_modules/old": git_dep}, self.reg))
        self.git("add", "package-lock.json"); self.git("commit", "-qm", "base")
        self.assertEqual(self.run_check(lock({"node_modules/old": git_dep}, self.reg), base="HEAD"), [])
        f = self.run_check(lock({"node_modules/old": git_dep, "node_modules/edge14": git_dep}, self.reg), base="HEAD")
        self.assertEqual(len(f), 1)
        self.assertIn("edge14", f[0])

    def test_base_missing_lockfile_checks_everything(self):
        self.git("init", "-q", "-b", "main")
        (self.tmp / "other").write_text("x"); self.git("add", "other"); self.git("commit", "-qm", "base")
        f = self.run_check(lock({"node_modules/young": {}}, self.reg), base="HEAD")
        self.assertIn("[TOO_YOUNG]", f[0])


class Cli(Base):
    def test_exit_codes(self):
        lf = self.tmp / "package-lock.json"
        env = ["--cache", str(self.cache), "--registry", self.reg, "--now", NOW, "--exceptions", str(self.tmp / "none")]
        lf.write_text(lock({"node_modules/old": {}}, self.reg))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(m.main([str(lf), *env]), 0)
            lf.write_text(lock({"node_modules/young": {}}, self.reg))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.main([str(lf), *env]), 1)


class RealLockfiles(unittest.TestCase):
    def test_repo_lockfiles_parse_and_use_registry_only(self):
        root = Path(__file__).resolve().parents[2]
        locks = [p for p in root.rglob("package-lock.json") if "node_modules" not in p.parts and ".git" not in p.parts]
        self.assertGreaterEqual(len(locks), 1)   # the hub has 8+; every repo this copy lives in has at least one
        for p in locks:
            reg, bad = m.lock_packages(p.read_text())
            self.assertEqual(bad, [], str(p))
            self.assertTrue(reg, str(p))


if __name__ == "__main__":
    unittest.main()
