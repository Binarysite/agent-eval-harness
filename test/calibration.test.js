import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationMetrics, cohensKappa, majorityVerdict, runCalibration } from '../src/calibration.js';
import { createMockJudge, loadScenarios } from '../src/index.js';
import agent from '../examples/sticker-shop/agent.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bank = await loadScenarios(join(root, 'examples/sticker-shop/scenarios.json'));
const { cases: labelled } = JSON.parse(await readFile(join(root, 'examples/sticker-shop/calibration.json'), 'utf8'));

test('cohensKappa matches hand-computed values', () => {
  // po = 0.7, pe = 0.5 -> kappa 0.4
  assert.equal(cohensKappa({ tp: 20, fn: 5, fp: 10, tn: 15 }).toFixed(4), '0.4000');
  assert.equal(cohensKappa({ tp: 10, fn: 0, fp: 0, tn: 10 }), 1);
  assert.equal(cohensKappa({ tp: 0, fn: 0, fp: 0, tn: 0 }), null);
  assert.equal(cohensKappa({ tp: 10, fn: 0, fp: 0, tn: 0 }), null, 'one class only: chance agreement is total');
});

test('majorityVerdict needs a strict majority of decided verdicts', () => {
  const v = (...xs) => xs.map((pass) => ({ pass }));
  assert.equal(majorityVerdict(v(true, true, false)), true);
  assert.equal(majorityVerdict(v(false, false, true, null, null)), null);
  assert.equal(majorityVerdict(v(false, false, false, true, null)), false);
  assert.equal(majorityVerdict(v(true, false)), null);
});

test('calibrationMetrics counts a bad reply caught as a true positive', () => {
  const c = (label, rulesPass, ...passes) => ({ id: 'x', scenario: 's', label, rulesPass, output: { reply: '', toolCalls: [] }, verdicts: passes.map((pass) => ({ pass, reason: '' })) });
  const m = calibrationMetrics([
    c('fail', true, false, false, false), // caught
    c('fail', true, true, true, false), // missed, flaky
    c('fail', false, true, true, true), // missed by the judge, caught by a rule
    c('pass', true, true, true, true),
    c('pass', true, false, true, null), // a tie: no majority
  ]);
  assert.deepEqual(m.labels, { pass: 2, fail: 3 });
  assert.deepEqual(m.verdicts, { total: 15, undecided: 1 });
  assert.deepEqual(m.majority.confusion, { tp: 1, fn: 2, fp: 0, tn: 1 });
  assert.equal(m.majority.undecided, 1, 'false, true, null is a tie');
  assert.equal(m.majority.tpr, 1 / 3);
  assert.equal(m.majority.fpr, 0);
  assert.deepEqual(m.perTrial.confusion, { tp: 4, fn: 5, fp: 1, tn: 4 });
  assert.equal(m.selfConsistency.unanimous, 3 / 5);
  assert.equal(m.rulesAlone.badCaught, 1 / 3);
  assert.equal(m.pipeline.badCaught, 2 / 3);
  assert.equal(m.pipeline.goodPassed, 1 / 2, 'a case without a passing majority does not pass');
});

test('the labelled set: 48 replies, the healthy ones still match the agent, every bad one is labelled fail', async () => {
  assert.equal(labelled.length, 48);
  assert.equal(new Set(labelled.map((c) => c.id)).size, 48);
  const healthy = labelled.filter((c) => c.id.startsWith('good-'));
  assert.equal(healthy.length, 24);
  for (const c of healthy) {
    const s = bank.find((x) => x.id === c.scenario);
    const out = await agent({ message: s.message, context: s.context ?? {} });
    assert.deepEqual(c.output, { reply: out.reply, toolCalls: out.toolCalls }, `${c.id} drifted from the agent`);
  }
  assert.ok(labelled.filter((c) => c.id.startsWith('bad-')).every((c) => c.label === 'fail'));
});

test('runCalibration grades every reply k times through the judge, and the rules are recorded, not applied', async () => {
  let calls = 0;
  const judge = async ({ scenario }) => {
    calls += 1;
    assert.equal(scenario.expect, undefined, 'the judge sees the rubric, not the rules');
    return { pass: true, reason: 'ok', usage: { inputTokens: 100, outputTokens: 10 }, servedModel: 'm-1' };
  };
  const run = await runCalibration(labelled.slice(0, 3), bank, { judge, trials: 2 });
  assert.equal(calls, 6);
  assert.deepEqual(run.usage, { inputTokens: 600, outputTokens: 60 });
  assert.equal(run.cases[0].verdicts[0].servedModel, 'm-1');
  assert.ok(run.cases.every((c) => c.verdicts.length === 2));
  assert.equal(typeof run.cases[0].rulesPass, 'boolean');
});

test('runCalibration stops starting verdicts at the cost cap', async () => {
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { pass: false, reason: '', usage: { inputTokens: 1_000_000, outputTokens: 0 } };
  };
  const run = await runCalibration(labelled.slice(0, 5), bank, {
    judge, trials: 2, concurrency: 1, maxCostUsd: 2, costOf: (u) => u.inputTokens / 1e6,
  });
  assert.equal(calls, 2);
  assert.equal(run.skipped, 8);
  assert.equal(run.costUsd, 2);
});

test('runCalibration rejects unknown scenarios, bad labels and a missing judge', async () => {
  const one = { id: 'x', scenario: 'nope', label: 'pass', output: { reply: '', toolCalls: [] } };
  await assert.rejects(runCalibration([one], bank, { judge: async () => ({ pass: true, reason: '' }) }), /unknown scenario "nope"/);
  await assert.rejects(runCalibration([{ ...one, scenario: 'os-01', label: 'ok' }], bank, { judge: async () => ({ pass: true, reason: '' }) }), /label must be/);
  await assert.rejects(runCalibration([], bank, {}), TypeError);
  await assert.rejects(runCalibration([], bank, { judge: async () => ({ pass: true, reason: '' }), trials: 0 }), RangeError);
});

test('the mock judge, which does not read rubrics, catches almost none of the bad replies', async () => {
  const run = await runCalibration(labelled, bank, { judge: createMockJudge(), trials: 1 });
  const m = calibrationMetrics(run.cases);
  assert.equal(m.labels.fail, 25);
  assert.equal(m.majority.confusion.tp, 1, 'only the "I promise" reply trips its banned words');
  assert.equal(m.rulesAlone.badCaught, 1 / 25, 'the rules catch the literal leak and nothing else');
});
