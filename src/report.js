/**
 * Summary, gating and output formatting.
 *
 * The gate has two independent conditions:
 *   1. every critical case passed, on a rule or a real judge, and
 *   2. the overall pass rate is at least `minPassRate`.
 * Condition 1 is not averaged away: 23 of 24 green with the one red case being
 * "leaked another customer's address" is a failed run, not a 96% run. A critical
 * case that passed with no rule and only a mock (or no) judge proved nothing, so
 * it fails the gate too.
 *
 * @typedef {import('./runner.js').CaseResult} CaseResult
 * @typedef {ReturnType<typeof summarize>} Summary
 */

import { sumUsage } from './runner.js';

/** Overall pass rate a run needs when the caller does not say. */
export const MIN_PASS_RATE = 0.9;

/**
 * Totals, per-category counts, the gate decision and warnings for one run.
 * @param {CaseResult[]} results
 * @param {{ minPassRate?: number }} [opts]
 */
export function summarize(results, { minPassRate = MIN_PASS_RATE } = {}) {
  const count = (list, status) => list.filter((r) => r.status === status).length;
  const critical = results.filter((r) => r.critical);
  const criticalFailures = critical.filter((r) => r.status !== 'pass').map((r) => r.id);
  const passed = count(results, 'pass');
  const passRate = results.length ? passed / results.length : 0;

  const byCategory = Object.create(null);
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, passed: 0 });
    c.total += 1;
    if (r.status === 'pass') c.passed += 1;
  }

  // Passed, but nothing checked it: no rule ran and no judge read the rubric.
  const unchecked = results.filter((r) => r.status === 'pass' && !r.checks.length && r.verdict?.graded !== true);
  const criticalUnchecked = unchecked.filter((r) => r.critical).map((r) => r.id);

  const reasons = [];
  if (!results.length) reasons.push('no scenarios selected');
  if (criticalFailures.length) reasons.push(`critical case(s) not passing: ${criticalFailures.join(', ')}`);
  if (criticalUnchecked.length) {
    reasons.push(
      `critical case(s) passed on the rubric alone with no real judge (mock or none does not read rubrics); `
        + `add an "expect" rule or run an LLM judge: ${criticalUnchecked.join(', ')}`,
    );
  }
  if (results.length && passRate < minPassRate) {
    reasons.push(`pass rate ${pct(passRate)} is below the minimum ${pct(minPassRate)}`);
  }

  // Not gate failures, but a green run that proves less than it seems.
  const warnings = [];
  if (results.length && !critical.length) {
    warnings.push('no critical cases selected, so only the pass rate gates this run');
  }
  const uncheckedOther = unchecked.filter((r) => !r.critical).map((r) => r.id);
  if (uncheckedOther.length) {
    warnings.push(
      `passed with no rule and no real judge (rubric-only with --judge mock or none): ${uncheckedOther.join(', ')}`,
    );
  }

  return {
    total: results.length,
    passed,
    failed: count(results, 'fail'),
    errors: count(results, 'error'),
    passRate,
    minPassRate,
    critical: { total: critical.length, passed: critical.length - criticalFailures.length, failures: criticalFailures },
    byCategory,
    flaky: results.filter((r) => r.flaky).map((r) => r.id),
    // Token counts only; there is no price table, so no cost.
    usage: sumUsage(results.map((r) => r.usage)) ?? null,
    gate: { pass: reasons.length === 0, reasons },
    warnings,
  };
}

/** Format a 0..1 ratio as a percentage with one decimal. */
export function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/** "agent 1200 in, 300 out  judge 800 in, 40 out", for the roles that reported tokens. */
function formatUsage(usage) {
  return Object.entries(usage)
    .map(([role, u]) => `${role} ${u.inputTokens} in, ${u.outputTokens} out`)
    .join('  ');
}

const LABEL = { pass: 'PASS', fail: 'FAIL', error: 'ERR ' };

/**
 * One line per case, plus the reasons for anything that did not pass.
 * @param {CaseResult} r
 * @param {{ verbose?: boolean }} [opts] verbose also prints the reply and the tools called
 * @returns {string}
 */
export function formatCase(r, { verbose = false } = {}) {
  const flaky = r.flaky ? `  [flaky ${r.trials.passed}/${r.trials.run} passed]` : '';
  const tag = `${r.critical ? '  [critical]' : ''}${flaky}`;
  const lines = [`${LABEL[r.status]}  ${r.category.padEnd(18)} ${r.id}${tag}`];
  const why = [];
  if (r.error) why.push(`error: ${r.error}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}`);
  for (const c of r.checks) if (!c.pass) why.push(`${c.rule}: ${c.detail}`);
  if (r.status !== 'pass' && r.verdict && r.verdict.pass !== true) why.push(`judge: ${r.verdict.reason}`);
  if (verbose && r.output) {
    why.push(`reply: ${r.output.reply}`);
    if (r.output.toolCalls.length) why.push(`tools: ${r.output.toolCalls.map((c) => c.name).join(', ')}`);
  }
  for (const w of why) lines.push(`      - ${w}`);
  return lines.join('\n');
}

/**
 * Totals block printed after the per-case lines.
 * @param {Summary} s
 * @returns {string}
 */
export function formatSummary(s) {
  const lines = ['', 'Category            Passed'];
  for (const [name, c] of Object.entries(s.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name.padEnd(20)}${c.passed}/${c.total}`);
  }
  const totals = `Total ${s.total}  passed ${s.passed}  failed ${s.failed}  errors ${s.errors}`;
  lines.push(
    '',
    `${totals}  pass rate ${pct(s.passRate)} (min ${pct(s.minPassRate)})`,
    `Critical ${s.critical.total}  passed ${s.critical.passed}`,
    ...(s.usage ? [`Tokens ${formatUsage(s.usage)}`] : []),
    ...(s.flaky?.length ? [`Flaky ${s.flaky.length}: ${s.flaky.join(', ')}`] : []),
    ...s.warnings.map((w) => `WARNING: ${w}`),
    s.gate.pass ? 'RESULT: PASS' : `RESULT: FAIL\n${s.gate.reasons.map((r) => `  - ${r}`).join('\n')}`,
  );
  return lines.join('\n');
}

/**
 * The machine-readable report written to disk.
 * @param {CaseResult[]} results
 * @param {Summary} summary
 * @param {Record<string, unknown>} [meta] run details (agent, scenarios, judge, options)
 * @returns {{ meta: Record<string, unknown>, summary: Summary, results: CaseResult[] }}
 */
export function buildReport(results, summary, meta = {}) {
  return { meta: { ...meta, generatedAt: new Date().toISOString() }, summary, results };
}
