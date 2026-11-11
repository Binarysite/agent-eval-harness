#!/usr/bin/env node
// Grade a labelled set with a judge, k times per reply, and report how often the
// judge agrees with the labels. See docs/CALIBRATION.md.
//
//   node scripts/calibrate.mjs --judge mock
//   OPENAI_BASE_URL=https://api.deepseek.com JUDGE_MODEL=deepseek-chat OPENAI_API_KEY=... \
//     node scripts/calibrate.mjs --judge openai --price-in 0.30 --price-out 1.20 --max-usd 0.25
//
// Prices are USD per million tokens and come from the caller: the harness keeps no
// price table. The cost is input tokens times --price-in plus output tokens times
// --price-out, so pass the highest rate that can apply to get an upper bound.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createAnthropicJudge, createMockJudge, createOpenAICompatibleJudge, gitSha, loadScenarios,
} from '../src/index.js';
import { calibrationMetrics, runCalibration } from '../src/calibration.js';

const { values: args } = parseArgs({
  options: {
    labels: { type: 'string', default: 'examples/sticker-shop/calibration.json' },
    scenarios: { type: 'string', default: 'examples/sticker-shop/scenarios.json' },
    judge: { type: 'string', default: 'mock' },
    trials: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '60000' },
    'price-in': { type: 'string' },
    'price-out': { type: 'string' },
    'max-usd': { type: 'string', default: '1' },
    out: { type: 'string' },
  },
});

const JUDGES = { mock: createMockJudge, openai: createOpenAICompatibleJudge, anthropic: createAnthropicJudge };
if (!Object.hasOwn(JUDGES, args.judge)) throw new Error(`--judge must be one of ${Object.keys(JUDGES).join(', ')}`);
const number = (name, value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number >= 0`);
  return n;
};
const priced = args.judge !== 'mock';
if (priced && (args['price-in'] === undefined || args['price-out'] === undefined)) {
  throw new Error('--price-in and --price-out (USD per million tokens) are required for a billed judge');
}
const price = priced ? { inputPerMTok: number('price-in', args['price-in']), outputPerMTok: number('price-out', args['price-out']) } : null;
const costOf = (u) => (price ? (u.inputTokens * price.inputPerMTok + u.outputTokens * price.outputPerMTok) / 1e6 : 0);

const judge = JUDGES[args.judge]();
const labelsRaw = await readFile(args.labels);
const { cases: labelled } = JSON.parse(String(labelsRaw));
const scenarios = await loadScenarios(args.scenarios);
const trials = Number(args.trials);
const maxCostUsd = number('max-usd', args['max-usd']);

const started = Date.now();
let done = 0;
const total = labelled.length * trials;
const run = await runCalibration(labelled, scenarios, {
  judge,
  trials,
  concurrency: Number(args.concurrency),
  timeoutMs: Number(args.timeout),
  maxCostUsd,
  costOf,
  onVerdict: () => {
    done += 1;
    if (process.stderr.isTTY) process.stderr.write(`\r[${done}/${total}]`);
  },
});
if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

const metrics = {
  all: calibrationMetrics(run.cases),
  unambiguous: calibrationMetrics(run.cases.filter((c) => !c.ambiguous)),
};
const verdictCount = metrics.all.verdicts.total;
const served = [...new Set(run.cases.flatMap((c) => c.verdicts.map((v) => v.servedModel)).filter(Boolean))];
const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    judge: args.judge,
    judgeModel: judge.model ?? null,
    servedModels: served,
    baseUrl: args.judge === 'openai' ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') : null,
    trials,
    labels: args.labels,
    labelsSha256: createHash('sha256').update(labelsRaw).digest('hex'),
    scenarios: args.scenarios,
    scenariosSha256: createHash('sha256').update(await readFile(args.scenarios)).digest('hex'),
    gitSha: gitSha(),
    durationMs: Date.now() - started,
    price,
    maxCostUsd,
  },
  usage: run.usage,
  costUsd: run.costUsd,
  costPer100VerdictsUsd: verdictCount ? (run.costUsd / verdictCount) * 100 : null,
  skippedVerdicts: run.skipped,
  metrics,
  cases: run.cases,
};

const p = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const k = (x) => (x === null ? 'n/a' : x.toFixed(3));
const line = (name, m) => `${name.padEnd(12)} TPR ${p(m.majority.tpr)}  FPR ${p(m.majority.fpr)}  kappa ${k(m.majority.kappa)}`
  + `  (per trial: TPR ${p(m.perTrial.tpr)}  FPR ${p(m.perTrial.fpr)}  kappa ${k(m.perTrial.kappa)})`;
console.log([
  `judge ${args.judge}${judge.model ? ` ${judge.model}` : ''}${served.length ? ` (served by ${served.join(', ')})` : ''}`
    + `  ${labelled.length} replies x ${trials} trials`,
  line('all', metrics.all),
  line('unambiguous', metrics.unambiguous),
  `undecided verdicts ${metrics.all.verdicts.undecided} of ${verdictCount}; majority undecided ${metrics.all.majority.undecided}`,
  `self-consistency: unanimous ${p(metrics.all.selfConsistency?.unanimous ?? null)}`
    + `, mean pairwise agreement ${p(metrics.all.selfConsistency?.meanPairwiseAgreement ?? null)}`,
  `rules alone catch ${p(metrics.all.rulesAlone.badCaught)} of bad replies; rules + judge catch ${p(metrics.all.pipeline.badCaught)}`
    + ` and pass ${p(metrics.all.pipeline.goodPassed)} of good ones`,
  `tokens ${run.usage.inputTokens} in, ${run.usage.outputTokens} out; cost USD ${run.costUsd.toFixed(4)}`
    + `${run.skipped ? `; ${run.skipped} verdicts skipped at the USD ${maxCostUsd} cap` : ''}`,
].join('\n'));

if (args.out) {
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${args.out}`);
}
