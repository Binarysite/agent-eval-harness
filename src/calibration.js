import { checkExpectations } from './expectations.js';
import { mapLimit, runCase } from './runner.js';

/**
 * Judge calibration: how often a judge agrees with labels on replies whose
 * right verdict is known. A pass rate from a judge never measured against labels
 * is a signal to read; with these numbers it comes with a measured error rate on
 * that labelled set, which says nothing certain about another bank or model.
 *
 * The positive class is a bad reply (label `fail`), because catching those is
 * the judge's job: TPR is the share of bad replies the judge failed, FPR the
 * share of good replies it failed.
 *
 * @typedef {import('./scenarios.js').Scenario} Scenario
 * @typedef {import('./expectations.js').AgentOutput} AgentOutput
 * @typedef {{ inputTokens: number, outputTokens: number }} Usage
 * @typedef {object} LabelledCase
 * @property {string} id
 * @property {string} scenario       id of the scenario whose message and rubric the judge sees
 * @property {'pass' | 'fail'} label
 * @property {AgentOutput} output     the reply and tool calls being graded
 * @property {string} [kind]
 * @property {boolean} [ambiguous]    a second reader could reasonably flip the label
 * @property {string} [note]
 * @typedef {{ pass: boolean | null, reason: string, servedModel?: string, usage?: Usage }} TrialVerdict
 * @typedef {LabelledCase & { rulesPass: boolean, verdicts: TrialVerdict[] }} CalibratedCase
 */

const ratio = (a, b) => (b ? a / b : null);

/** Cohen's kappa of a 2x2 confusion matrix; null when chance agreement is total. */
export function cohensKappa({ tp, fn, fp, tn }) {
  const n = tp + fn + fp + tn;
  if (!n) return null;
  const observed = (tp + tn) / n;
  const chance = ((tp + fp) * (tp + fn) + (tn + fn) * (tn + fp)) / (n * n);
  return chance === 1 ? null : (observed - chance) / (1 - chance);
}

/** Rates of a confusion matrix, bad reply = positive. */
function rates(confusion) {
  const { tp, fn, fp, tn } = confusion;
  return {
    confusion,
    tpr: ratio(tp, tp + fn),
    fpr: ratio(fp, fp + tn),
    accuracy: ratio(tp + tn, tp + fn + fp + tn),
    kappa: cohensKappa(confusion),
  };
}

/** Add one judged verdict to a confusion matrix; undecided verdicts are not counted. */
function tally(confusion, label, pass) {
  if (pass === null) return;
  const judgedBad = pass === false;
  if (label === 'fail') confusion[judgedBad ? 'tp' : 'fn'] += 1;
  else confusion[judgedBad ? 'fp' : 'tn'] += 1;
}

/** The verdict most trials gave; null on a tie or when most were undecided. */
export function majorityVerdict(verdicts) {
  const yes = verdicts.filter((v) => v.pass === true).length;
  const no = verdicts.filter((v) => v.pass === false).length;
  const needed = Math.floor(verdicts.length / 2) + 1;
  if (yes >= needed) return true;
  if (no >= needed) return false;
  return null;
}

/**
 * Agreement with the labels, per trial and by majority, self-consistency
 * across trials, and what the scenario rules alone and the full pipeline
 * (rules, then the judge's majority) would have done.
 * @param {CalibratedCase[]} cases
 */
export function calibrationMetrics(cases) {
  const perTrial = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const majority = { tp: 0, fn: 0, fp: 0, tn: 0 };
  let verdicts = 0;
  let undecided = 0;
  let majorityUndecided = 0;
  let unanimous = 0;
  let pairShare = 0;
  let multiTrial = 0;
  const bad = cases.filter((c) => c.label === 'fail');
  const good = cases.filter((c) => c.label === 'pass');

  for (const c of cases) {
    for (const v of c.verdicts) {
      verdicts += 1;
      if (v.pass === null) undecided += 1;
      tally(perTrial, c.label, v.pass);
    }
    const m = majorityVerdict(c.verdicts);
    if (m === null) majorityUndecided += 1;
    tally(majority, c.label, m);
    const n = c.verdicts.length;
    if (n > 1) {
      multiTrial += 1;
      const values = c.verdicts.map((v) => v.pass);
      if (values.every((x) => x === values[0])) unanimous += 1;
      let agree = 0;
      for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) if (values[i] === values[j]) agree += 1;
      pairShare += agree / ((n * (n - 1)) / 2);
    }
  }

  // The harness passes a case only when every rule passed and the judge said yes.
  const pipelinePasses = (c) => c.rulesPass && majorityVerdict(c.verdicts) === true;
  return {
    cases: cases.length,
    labels: { pass: good.length, fail: bad.length },
    verdicts: { total: verdicts, undecided },
    perTrial: rates(perTrial),
    majority: { ...rates(majority), undecided: majorityUndecided },
    selfConsistency: multiTrial
      ? { unanimous: unanimous / multiTrial, meanPairwiseAgreement: pairShare / multiTrial }
      : null,
    rulesAlone: {
      badCaught: ratio(bad.filter((c) => !c.rulesPass).length, bad.length),
      goodBlocked: ratio(good.filter((c) => !c.rulesPass).length, good.length),
    },
    pipeline: {
      badCaught: ratio(bad.filter((c) => !pipelinePasses(c)).length, bad.length),
      goodPassed: ratio(good.filter(pipelinePasses).length, good.length),
    },
  };
}

/**
 * Grade every labelled reply `trials` times with `judge`, through the same
 * runCase path a real run takes (timeouts, retries, verdict normalization).
 * The rules are left out of the judged scenario so the judge sees every reply;
 * whether the rules would have caught it is recorded as `rulesPass`.
 * Stops starting new verdicts once `costOf` of the usage so far reaches
 * `maxCostUsd`; verdicts already in flight still finish, so the overshoot is
 * at most `concurrency` verdicts.
 * @param {LabelledCase[]} labelled
 * @param {Scenario[]} scenarios
 * @param {{ judge: import('./runner.js').Judge, trials?: number, concurrency?: number, timeoutMs?: number,
 *   retries?: number, retryDelayMs?: number, maxCostUsd?: number, costOf?: (usage: Usage) => number,
 *   onVerdict?: (c: LabelledCase, v: TrialVerdict) => void }} opts
 * @returns {Promise<{ cases: CalibratedCase[], usage: Usage, costUsd: number, skipped: number }>}
 */
export async function runCalibration(labelled, scenarios, {
  judge, trials = 5, concurrency = 4, timeoutMs, retries, retryDelayMs,
  maxCostUsd = Infinity, costOf = () => 0, onVerdict,
}) {
  if (typeof judge !== 'function') throw new TypeError('runCalibration needs a judge function');
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('trials must be a positive integer');
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  for (const c of labelled) {
    if (!byId.has(c.scenario)) throw new Error(`${c.id}: unknown scenario "${c.scenario}"`);
    if (c.label !== 'pass' && c.label !== 'fail') throw new Error(`${c.id}: label must be "pass" or "fail"`);
  }
  const usage = { inputTokens: 0, outputTokens: 0 };
  let skipped = 0;
  const jobs = labelled.flatMap((c) => Array.from({ length: trials }, () => c));
  const verdicts = new Map(labelled.map((c) => [c, []]));

  await mapLimit(jobs, concurrency, async (c) => {
    if (costOf(usage) >= maxCostUsd) {
      skipped += 1;
      return;
    }
    const { expect: _rules, ...rubricOnly } = byId.get(c.scenario);
    const result = await runCase(rubricOnly, {
      agent: async () => c.output, judge, timeoutMs, retries, retryDelayMs,
    });
    const judgeUsage = result.usage?.judge;
    if (judgeUsage) {
      usage.inputTokens += judgeUsage.inputTokens;
      usage.outputTokens += judgeUsage.outputTokens;
    }
    const { pass, reason, servedModel } = /** @type {TrialVerdict} */ (result.verdict);
    const v = { pass, reason, ...(servedModel && { servedModel }), ...(judgeUsage && { usage: judgeUsage }) };
    verdicts.get(c).push(v);
    onVerdict?.(c, v);
  });

  const cases = labelled.map((c) => {
    const scenario = byId.get(c.scenario);
    const checks = checkExpectations(scenario.expect ?? {}, c.output);
    return { ...c, rulesPass: checks.every((check) => check.pass), verdicts: verdicts.get(c) };
  });
  return { cases, usage, costUsd: costOf(usage), skipped };
}
