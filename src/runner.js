import { setTimeout as sleep } from 'node:timers/promises';
import { checkExpectations } from './expectations.js';

/**
 * @typedef {import('./scenarios.js').Scenario} Scenario
 * @typedef {import('./expectations.js').AgentOutput} AgentOutput
 * @typedef {{ inputTokens: number, outputTokens: number }} Usage
 * @typedef {{ agent?: Usage, judge?: Usage }} UsageByRole
 */

/**
 * The agent under test. It receives one user message and returns what it said
 * plus the tools it called. Everything else (model, prompt, tool execution) is
 * the agent's business, so the harness works with any stack.
 * It never sees expect or rubric: an agent that can read the answers would
 * grade itself.
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is
 * not retried. Set `retryable: false` on an error that would repeat (a refusal).
 * A retry calls the agent again from scratch, tool calls included.
 * Return `usage` when the model reports token counts; the report records them.
 * @callback Agent
 * @param {{ message: string, context: Record<string, unknown>, signal: AbortSignal }} input
 * @returns {Promise<{ reply: string, toolCalls?: Array<{ name: string, args?: object } | string>, usage?: Usage }>}
 */

/**
 * A judge grades one output against the scenario rubric.
 * `pass: null` means the judge could not decide (bad JSON, refusal, outage).
 * `graded: false` means it did not read the rubric (the mock judge); omitted means it did.
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is not retried.
 * `usage`, when present, is moved from the verdict to the case result.
 * @callback Judge
 * @param {{ scenario: Scenario, output: AgentOutput, signal: AbortSignal }} input
 * @returns {Promise<{ pass: boolean | null, reason: string, graded?: boolean, usage?: Usage }>}
 */

/**
 * @typedef {object} CaseResult
 * @property {string} id
 * @property {string} category
 * @property {boolean} critical
 * @property {'pass' | 'fail' | 'error'} status
 * @property {number} attempts
 * @property {number} durationMs
 * @property {AgentOutput | null} output
 * @property {import('./expectations.js').CheckResult[]} checks
 * @property {{ pass: boolean | null, reason: string, graded: boolean, attempts: number } | null} verdict
 *   `graded: false` when no judge read the rubric (mock judge, or no judge at all)
 * @property {string} [error]
 * @property {UsageByRole} [usage]  tokens the agent and the judge reported, summed over trials;
 *   absent when neither reported any
 * @property {{ run: number, passed: number }} [trials]  set by runSuite
 * @property {boolean} [flaky]  set by runSuite: the trials did not all end the same way
 */

/**
 * @typedef {object} RunOptions
 * @property {Agent} agent
 * @property {Judge} [judge]
 * @property {number} [concurrency]  cases in flight at once (default 4)
 * @property {number} [trials]       times each case runs (default 1); see combineTrials
 * @property {number} [retries]      retries per call on infrastructure failures (default 1)
 * @property {number} [timeoutMs]    per call timeout for agent and judge (default 10000)
 * @property {number} [retryDelayMs] base of the exponential backoff between retries (default 500)
 * @property {string} [handoffTool]  tool name the `handoff` rule looks for
 * @property {(r: CaseResult) => void} [onResult]
 */

/**
 * Defaults shared by runCase, runSuite and the CLI, so the library and the
 * command line cannot drift apart.
 * @type {Readonly<{ concurrency: number, trials: number, retries: number, timeoutMs: number, retryDelayMs: number }>}
 */
export const RUN_DEFAULTS = Object.freeze({
  concurrency: 4, trials: 1, retries: 1, timeoutMs: 10_000, retryDelayMs: 500,
});

// setTimeout fires at once for anything longer than this.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Reject options that would make the run misbehave instead of fail: a NaN
 * concurrency starts no worker, a NaN retry count retries forever.
 * @param {string} fn
 * @param {{ agent?: unknown, retries?: number, timeoutMs?: number, retryDelayMs?: number }} opts
 */
function assertCaseOptions(
  fn,
  {
    agent,
    retries = RUN_DEFAULTS.retries,
    timeoutMs = RUN_DEFAULTS.timeoutMs,
    retryDelayMs = RUN_DEFAULTS.retryDelayMs,
  },
) {
  if (typeof agent !== 'function') throw new TypeError(`${fn} needs an agent function`);
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer');
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be a number above 0 and at most ${MAX_TIMEOUT_MS}`);
  }
  if (!(Number.isFinite(retryDelayMs) && retryDelayMs >= 0)) throw new RangeError('retryDelayMs must be a number >= 0');
}

/** Run `fn` with an AbortSignal and reject if it takes longer than `ms`. */
export async function withTimeout(fn, ms, label = 'call') {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { name: 'TimeoutError' }));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Map with at most `limit` promises in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Accept `toolCalls` as objects or bare names; reject anything else loudly. */
export function normalizeOutput(raw) {
  if (!raw || typeof raw.reply !== 'string') throw new Error('agent must return { reply: string, toolCalls?: [] }');
  const calls = raw.toolCalls ?? [];
  if (!Array.isArray(calls)) throw new Error('agent toolCalls must be an array');
  const toolCalls = calls.map((c, i) => {
    if (typeof c === 'string') return { name: c, args: {} };
    if (!c || typeof c.name !== 'string') {
      throw new Error(`agent toolCalls[${i}] must be a tool name or { name, args }`);
    }
    return { name: c.name, args: c.args ?? {} };
  });
  return { reply: raw.reply, toolCalls };
}

/**
 * Token counts are optional, but a malformed one is a broken contract, not a zero.
 * @param {unknown} raw
 * @param {string} who
 * @returns {Usage | undefined}
 */
export function readUsage(raw, who) {
  if (raw === undefined || raw === null) return undefined;
  const count = (n) => Number.isInteger(n) && n >= 0;
  const u = /** @type {any} */ (raw);
  if (!count(u.inputTokens) || !count(u.outputTokens)) {
    throw new Error(`${who} usage must be { inputTokens: number, outputTokens: number }`);
  }
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

/**
 * Add up token counts per role. Returns undefined when nothing reported any,
 * so a run without usage shows no token line at all.
 * @param {Array<UsageByRole | undefined>} list
 * @returns {UsageByRole | undefined}
 */
export function sumUsage(list) {
  let total;
  for (const usage of list) {
    for (const role of /** @type {const} */ (['agent', 'judge'])) {
      if (!usage?.[role]) continue;
      total ??= {};
      const t = (total[role] ??= { inputTokens: 0, outputTokens: 0 });
      t.inputTokens += usage[role].inputTokens;
      t.outputTokens += usage[role].outputTokens;
    }
  }
  return total;
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * A failure is worth retrying when it is infrastructure: the network, an abort
 * or timeout, a 429 or a 5xx. Anything else (a 4xx, a refusal, max_tokens, a
 * bug in the agent) would fail the same way again, so it is reported at once.
 */
export function isTransient(err) {
  if (err?.retryable === false) return false;
  const status = err?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  // fetch reports network failures as `TypeError: fetch failed` with the code on `cause`.
  return NETWORK_CODES.has(err?.code) || NETWORK_CODES.has(err?.cause?.code)
    || (err instanceof TypeError && err.message === 'fetch failed');
}

const MAX_BACKOFF_MS = 8_000;
// A longer Retry-After would stall the whole run; past this the retry is
// attempted anyway and reported if it fails again.
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * How long to wait before retry number `attempt`: the server's Retry-After
 * when the error carries one (`retryAfterMs`), otherwise exponential backoff
 * with full jitter, so parallel cases that hit the same 429 do not retry in
 * lockstep.
 */
export function retryDelay(err, attempt, baseMs = 500) {
  if (Number.isFinite(err?.retryAfterMs)) return Math.min(Math.max(0, err.retryAfterMs), MAX_RETRY_AFTER_MS);
  return Math.random() * Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1));
}

/** Call `fn` with a timeout, retrying transient failures up to `retries` times. */
async function withRetries(fn, { retries, timeoutMs, retryDelayMs, label }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { value: await withTimeout(fn, timeoutMs, label), attempts };
    } catch (error) {
      if (attempts > retries || !isTransient(error)) return { error, attempts };
      await sleep(retryDelay(error, attempts, retryDelayMs));
    }
  }
}

const INVALID_VERDICT = 'judge returned an invalid verdict, expected { pass: boolean | null, reason: string }';

/**
 * A verdict that is not `{ pass: boolean | null }` becomes undecided, never a pass.
 * Its token usage is split off so the recorded verdict stays a verdict.
 */
function normalizeVerdict(raw) {
  const valid = raw !== null && typeof raw === 'object' && (typeof raw.pass === 'boolean' || raw.pass === null);
  if (!valid) return { verdict: { pass: null, reason: INVALID_VERDICT, graded: false } };
  const { usage: rawUsage, ...rest } = raw;
  let usage;
  try {
    usage = readUsage(rawUsage, 'judge');
  } catch (err) {
    return { verdict: { pass: null, reason: err.message, graded: false } };
  }
  return { verdict: { ...rest, reason: String(raw.reason ?? ''), graded: raw.graded !== false }, usage };
}

/** Recorded when a case has a rubric but the run has no judge. It never decides the status. */
const NOT_GRADED = Object.freeze({ pass: null, reason: 'rubric not graded: no judge', graded: false, attempts: 0 });

/** Ask the judge for a verdict; a judge that keeps failing becomes undecided. */
async function judgeCase(judge, scenario, output, opts) {
  const { value, error, attempts } = await withRetries(
    (signal) => judge({ scenario, output, signal }),
    { ...opts, label: 'judge' },
  );
  const { verdict, usage } = error
    ? { verdict: { pass: null, reason: `error: ${error.message}`, graded: false }, usage: undefined }
    : normalizeVerdict(value);
  return { verdict: { ...verdict, attempts }, usage };
}

/** The `usage` field of a case result, or nothing when no one reported tokens. */
const usageField = (agent, judge) => (agent || judge
  ? { usage: { ...(agent && { agent }), ...(judge && { judge }) } }
  : {});

function caseStatus(rulesPass, verdict) {
  if (!rulesPass || verdict?.pass === false) return 'fail';
  if (verdict && verdict.pass !== true) return 'error';
  return 'pass';
}

/**
 * Evaluate one scenario. Only infrastructure failures are retried (network,
 * abort, timeout, 429, 5xx), with the same policy for agent and judge. A wrong answer
 * or a "no" from the judge is never retried: retrying until green hides the
 * flakiness an eval exists to expose. The judge only runs when every rule
 * passed, so you never pay to grade a case that already failed.
 * @param {Scenario} scenario
 * @param {Omit<RunOptions, 'concurrency' | 'onResult'>} opts
 * @returns {Promise<CaseResult>}
 */
export async function runCase(
  scenario,
  {
    agent,
    judge,
    retries = RUN_DEFAULTS.retries,
    timeoutMs = RUN_DEFAULTS.timeoutMs,
    retryDelayMs = RUN_DEFAULTS.retryDelayMs,
    handoffTool,
  } = /** @type {any} */ ({}),
) {
  assertCaseOptions('runCase', { agent, retries, timeoutMs, retryDelayMs });
  const started = performance.now();
  const base = { id: scenario.id, category: scenario.category, critical: scenario.critical === true };
  const done = (fields) => ({ ...base, ...fields, durationMs: Math.round(performance.now() - started) });

  const { value, error, attempts } = await withRetries(
    (signal) => agent({ message: scenario.message, context: scenario.context ?? {}, signal }),
    { retries, timeoutMs, retryDelayMs, label: 'agent' },
  );
  const failed = { attempts, output: null, checks: [], verdict: null, status: 'error' };
  if (error) return done({ ...failed, error: error.message });

  let output;
  let checks;
  let agentUsage;
  try {
    output = normalizeOutput(value);
    agentUsage = readUsage(value.usage, 'agent');
    checks = checkExpectations(scenario.expect ?? {}, output, { handoffTool });
  } catch (err) {
    return done({ ...failed, error: err.message });
  }

  const rulesPass = checks.every((c) => c.pass);
  const finish = (verdict, status, judgeUsage = undefined) => done({
    attempts, output, checks, verdict, status, ...usageField(agentUsage, judgeUsage),
  });
  if (!rulesPass || !scenario.rubric) return finish(null, caseStatus(rulesPass, null));
  if (!judge) return finish({ ...NOT_GRADED }, 'pass');
  const { verdict, usage } = await judgeCase(judge, scenario, output, { retries, timeoutMs, retryDelayMs });
  return finish(verdict, caseStatus(rulesPass, verdict), usage);
}

/**
 * Fold the trials of one case into one result. A case is flaky when its trials
 * did not all end with the same status. A critical case passes only if every
 * trial passed; any other case needs a strict majority. The output, checks and
 * verdict shown are those of the first trial that agrees with the outcome.
 * Durations and token usage add up over every trial, since every trial ran.
 * @param {CaseResult[]} runs
 * @returns {CaseResult}
 */
export function combineTrials(runs) {
  if (!runs.length) throw new RangeError('combineTrials needs at least one trial');
  const passed = runs.filter((r) => r.status === 'pass').length;
  const needed = runs[0].critical ? runs.length : Math.floor(runs.length / 2) + 1;
  const pass = passed >= needed;
  const { usage: _shownUsage, ...shown } = runs.find((r) => (r.status === 'pass') === pass);
  const usage = sumUsage(runs.map((r) => r.usage));
  return {
    ...shown,
    durationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    ...(usage && { usage }),
    trials: { run: runs.length, passed },
    flaky: new Set(runs.map((r) => r.status)).size > 1,
  };
}

/**
 * Run a scenario bank with bounded concurrency, each case `trials` times in a row.
 * @param {Scenario[]} scenarios
 * @param {RunOptions} opts
 * @returns {Promise<CaseResult[]>}
 */
export async function runSuite(
  scenarios,
  { concurrency = RUN_DEFAULTS.concurrency, trials = RUN_DEFAULTS.trials, onResult, ...opts },
) {
  assertCaseOptions('runSuite', opts);
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('trials must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  return mapLimit(scenarios, concurrency, async (scenario) => {
    const runs = [];
    for (let i = 0; i < trials; i += 1) runs.push(await runCase(scenario, opts));
    const result = combineTrials(runs);
    onResult?.(result);
    return result;
  });
}
