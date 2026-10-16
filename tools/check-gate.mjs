// Pass/fail gate shared by the headless browser checks (browser-check,
// live-check). A check that measured nothing must not pass: the report passes
// only when no stage threw, at least one assertion ran, and every assertion
// held. Each assertion keeps what was measured and the limit it was held to,
// so the JSON says why it failed, not just that it did.
//
//   const g = gate(R);
//   g.stage('play');                       // names the stage for R.error
//   g.check('quanta within 2%', err <= 0.02, err, '<= 0.02');
//   ... catch (e) { g.fail(e); } finally { const code = g.finish(); ... process.exitCode = code; }

export function gate(R) {
  R.checks = [];
  let stage = 'start';
  return {
    stage(name) { stage = name; },
    check(name, ok, measured, limit) {
      const pass = ok === true;
      R.checks.push({ name, pass, measured: measured ?? null, limit });
      return pass;
    },
    fail(e) {
      R.error = { stage, message: String(e?.message ?? e).split('\n')[0] };
    },
    /** Sets R.pass and R.failed, prints every failure to stderr, returns the exit code. */
    finish() {
      const failed = R.checks.filter((c) => !c.pass);
      R.pass = !R.error && R.checks.length > 0 && failed.length === 0;
      R.failed = failed.map((c) => c.name);
      if (R.error) console.error(`ERROR in stage "${R.error.stage}": ${R.error.message}`);
      if (!R.error && !R.checks.length) console.error('FAIL: no assertion ran');
      for (const c of failed) console.error(`FAIL ${c.name}: measured ${JSON.stringify(c.measured)}, limit ${c.limit}`);
      console.error(R.pass ? `PASS: ${R.checks.length} assertions` : `FAILED: ${failed.length} of ${R.checks.length} assertions${R.error ? ', plus a stage error' : ''}`);
      return R.pass ? 0 : 1;
    },
  };
}

export const finite = (...xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));
