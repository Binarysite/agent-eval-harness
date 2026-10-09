// Public contracts of agent-eval-harness (src/index.js).
// The JSDoc in src/ is the source of truth; `npm run typecheck` checks both and,
// through test-types/conform.ts, that src/index.js provides what this file declares.

/** A tool call as the harness records it. */
export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

/** What the agent said and the tools it called, after normalization. */
export interface AgentOutput {
  reply: string;
  toolCalls: ToolCall[];
}

/** Token counts one call reported. There is no price table, so no cost. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Tokens per role; a role that reported none is absent. */
export interface UsageByRole {
  agent?: Usage;
  judge?: Usage;
}

/** Rule-based expectations of a scenario. Unknown keys fail validation. */
export interface Expectations {
  tools?: string[];
  noTools?: string[];
  anyTool?: boolean;
  handoff?: boolean;
  toolArgs?: Record<string, Record<string, unknown>>;
  includesAny?: string[];
  excludes?: string[];
}

export interface Scenario {
  /** Stable, unique id (used in reports and diffs). */
  id: string;
  /** Grouping for filters and per-category scores. */
  category: string;
  /** What the user says to the agent. */
  message: string;
  /** A failing critical case fails the whole run. */
  critical?: boolean;
  /** Passed to the agent as-is (user id, role...). */
  context?: Record<string, unknown>;
  expect?: Expectations;
  /** Plain-language criteria for the LLM judge. */
  rubric?: string;
}

export interface AgentInput {
  message: string;
  context: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * The agent under test. It never sees expect or rubric.
 * Throw an Error with a numeric `status` for HTTP failures (429 and 5xx are
 * retried), `retryAfterMs` for Retry-After, and `retryable: false` on an error
 * that would repeat. A retry calls the agent again from scratch.
 * Return `usage` when the model reports token counts.
 */
export type Agent = ((input: AgentInput) => Promise<{
  reply: string;
  toolCalls?: Array<{ name: string; args?: object } | string>;
  usage?: Usage;
}>) & { model?: string };

export interface Verdict {
  /** `null` means the judge could not decide; the case becomes an error. */
  pass: boolean | null;
  reason: string;
  /** `false` when the rubric was not read (the mock judge); omitted means it was. */
  graded?: boolean;
  /** Tokens the judge call used; moved to `CaseResult.usage.judge`. */
  usage?: Usage;
}

export interface JudgeInput {
  scenario: Scenario;
  output: AgentOutput;
  signal: AbortSignal;
}

export type Judge = ((input: JudgeInput) => Promise<Verdict>) & { model?: string };

export interface CheckResult {
  rule: string;
  pass: boolean;
  detail: string;
}

export type CaseStatus = 'pass' | 'fail' | 'error';

export interface CaseResult {
  id: string;
  category: string;
  critical: boolean;
  status: CaseStatus;
  attempts: number;
  durationMs: number;
  output: AgentOutput | null;
  checks: CheckResult[];
  /** Recorded verdict; `graded: false` when no judge read the rubric. */
  verdict: (Verdict & { graded: boolean; attempts: number }) | null;
  error?: string;
  /** Tokens reported by the agent and the judge, summed over trials; absent when none were. */
  usage?: UsageByRole;
  /** Set by runSuite. */
  trials?: { run: number; passed: number };
  /** Set by runSuite: the trials did not all end the same way. */
  flaky?: boolean;
}

export interface RunOptions {
  agent: Agent;
  judge?: Judge;
  /** Cases in flight at once (default 4). */
  concurrency?: number;
  /** Times each case runs (default 1); see combineTrials. */
  trials?: number;
  /** Retries per call on infrastructure failures (default 1). */
  retries?: number;
  /** Per call timeout for agent and judge (default 10000). */
  timeoutMs?: number;
  /** Base of the exponential backoff between retries (default 500). */
  retryDelayMs?: number;
  /** Tool name the `handoff` rule looks for (default `handoff_to_human`). */
  handoffTool?: string;
  onResult?: (result: CaseResult) => void;
}

export type CaseOptions = Omit<RunOptions, 'concurrency' | 'trials' | 'onResult'>;

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  minPassRate: number;
  critical: { total: number; passed: number; failures: string[] };
  byCategory: Record<string, { total: number; passed: number }>;
  flaky: string[];
  /** Token totals; `null` when neither the agent nor the judge reported any. */
  usage: UsageByRole | null;
  gate: { pass: boolean; reasons: string[] };
  warnings: string[];
}

export interface Provenance {
  judgeModel: string | null;
  agentModel: string | null;
  scenariosSha256: string | null;
  gitSha: string | null;
}

export interface Report {
  meta: Record<string, unknown>;
  summary: Summary;
  results: CaseResult[];
}

export interface StatusChange {
  id: string;
  critical: boolean;
  from: string;
  to: string;
}

export interface Comparison {
  changes: StatusChange[];
  /** Changes whose previous status was `pass`, including `pass -> missing`. */
  regressions: StatusChange[];
  passRate: { before: number; after: number };
  warnings: string[];
}

/** The fields compareReports reads from a report. */
export interface ComparableReport {
  meta?: Record<string, unknown>;
  summary: { passRate: number };
  results: Array<{ id: string; status: string; critical: boolean }>;
}

export function checkExpectations(
  expect: Expectations | Record<string, unknown>,
  output: AgentOutput,
  opts?: { handoffTool?: string },
): CheckResult[];

export function loadScenarios(file: string | URL): Promise<Scenario[]>;
export function validateScenarios(bank: unknown): Scenario[];
export function filterScenarios(
  scenarios: Scenario[],
  filter?: { categories?: string[]; criticalOnly?: boolean },
): Scenario[];

export function runSuite(scenarios: Scenario[], opts: RunOptions): Promise<CaseResult[]>;
export function runCase(scenario: Scenario, opts: CaseOptions): Promise<CaseResult>;
/** A critical case passes only if every trial passed; any other case needs a strict majority. */
export function combineTrials(runs: CaseResult[]): CaseResult;

export function runProvenance(run?: {
  agent?: Function;
  judge?: Function;
  scenariosFile?: string | URL;
  cwd?: string;
}): Promise<Provenance>;
export function gitSha(cwd?: string): string | null;

export function summarize(results: CaseResult[], opts?: { minPassRate?: number }): Summary;
export function formatCase(result: CaseResult, opts?: { verbose?: boolean }): string;
export function formatSummary(summary: Summary): string;
export function buildReport(results: CaseResult[], summary: Summary, meta?: Record<string, unknown>): Report;

export function compareReports(
  before: ComparableReport,
  after: ComparableReport,
  labels?: { beforeLabel?: string; afterLabel?: string },
): Comparison;
export function formatComparison(comparison: Comparison): string;

export function createMockJudge(opts?: { maxChars?: number; banned?: string[] }): Judge;
/** Env: ANTHROPIC_API_KEY (required), JUDGE_MODEL and JUDGE_EFFORT (optional; effort is sent only when set). */
export function createAnthropicJudge(opts?: { apiKey?: string; model?: string; effort?: string }): Judge;
/** Env: OPENAI_API_KEY and JUDGE_MODEL (required), OPENAI_BASE_URL (optional). */
export function createOpenAICompatibleJudge(opts?: { apiKey?: string; baseUrl?: string; model?: string }): Judge;
export function buildJudgePrompt(scenario: Scenario, output: AgentOutput): string;
export function parseVerdict(text: string): { pass: boolean | null; reason: string };
export const JUDGE_SYSTEM: string;
