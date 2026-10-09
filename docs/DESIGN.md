# Design notes

Why the harness works the way it does, what it cannot catch, and where the code
lives. The [README](../README.md) covers running it and writing scenarios.

## Design decisions and trade-offs

**Agent evals are not unit tests.** The same input can produce many correct
replies, the model changes under you, and the failures that matter are rare. So
the harness asks two separate questions: did any critical case fail (if yes, the
run fails), and is the overall pass rate above the bar (this catches broad
regressions).

**Rules first, judge second.** Rules are free, deterministic and explain
themselves: "called `issue_refund`" needs no model to verify. The judge covers
what rules cannot, like "asked for the order number instead of guessing". The
judge only runs when every rule passed, so you never pay to grade a reply that
already failed.

**Critical gating instead of weighting.** Weights invite arguments about whether
a leak is worth 5 points or 50. A boolean is easier to reason about: some
behaviors are release blockers, and the bank says which ones. Critical cases
pair a rule (the literal leak) with a rubric (the paraphrased leak). Validation
requires the rule, and a critical case that passes on its rubric alone with the
mock judge or no judge fails the gate, because neither reads the rubric (their
verdicts record `graded: false`).

**Retries for infrastructure, never for answers.** Agent and judge share one
policy: a network error, an abort or timeout, a 429 or a 5xx is retried
(`--retries`, default 1; the result and the verdict record their `attempts`),
after the server's `Retry-After` when the error carries one (`retryAfterMs`,
filled in from the header by the bundled judges and the example agent, capped at
60 s) or else an exponential backoff with full jitter (`retryDelayMs`, default
500 ms, capped at 8 s).
Anything else is not retried because it would fail the same way: any other 4xx
(a bad key, a bad request), an error marked `retryable: false` (a refusal, a
reply cut off at `max_tokens`) or a plain bug in the agent. A wrong answer, or
a "no" from the judge, is never retried: retrying until green hides exactly the
flakiness an eval exists to show.
To get this from your own agent, throw an `Error` with a numeric `status` for
HTTP failures, add `retryAfterMs` if the server sent `Retry-After`, and set
`retryable: false` on an error that would repeat. A timed-out call is retried
and billed again, so raise `--timeout` (default 10 s) for a real tool loop or an
LLM judge.
A retry reruns the whole case from the agent call on, every tool call in it
included, and so does each of `--trials`. Tools with side effects (a refund, an
email, a ticket) must be idempotent or mocks in the eval.

**Trials measure flakiness instead of hiding it.** `--trials k` runs each case k
times. Mixed results mark the case flaky in the summary; a critical case must
pass k of k, any other case a majority.

**An undecided judge is an error, not a pass.** Unparseable JSON, a refusal, a
verdict without a boolean `pass`, or a judge that still fails after its retries
marks the case `error`, which counts against the pass rate and blocks the run if
the case is critical. The summary also warns when nothing in the selection is
critical, or when a case passed with no rule and no real judge (a rubric-only
case run with `--judge mock` or `--judge none`).

**Everything is injected.** The agent is `({ message, context, signal }) =>
{ reply, toolCalls }` and the judge is `({ scenario, output, signal }) =>
{ pass, reason }`. The agent never sees the scenario's `expect` or `rubric`.
The harness knows nothing about models, prompts or vendors, which is what lets
you run the same bank against two models and compare. To write a judge for
another provider, reuse `JUDGE_SYSTEM`, `buildJudgePrompt` and `parseVerdict`.

**Reports carry their provenance.** Each report's `meta` records `judgeModel`,
`agentModel` (when the agent function has a `model` property, else `null`), the
bank's `scenariosSha256` and the `gitSha`, and `compare` warns when any of them
differ, because a status change between two setups may come from the setup.
Keys are read from the environment only and never written to the report.

**Zero runtime dependencies.** Node 22+, `node:test` for tests, `fetch` for the
optional LLM judges. TypeScript is a dev dependency only. `npm run typecheck`
checks, in non-strict mode, the JSDoc in `src` and `bin` and that the
implementation matches the hand-written declarations in `index.d.ts`.
`npm run typecheck:types` checks `index.d.ts` on its own with `--strict`.
CI runs both.

## Known limits

- **LLM judges make mistakes in both directions.** A strict judge produces false
  negatives (a correct reply phrased differently, or "should also have called
  tool X" when it did not need to). A lenient one waves through confident
  nonsense. Read the failing verdicts before trusting a number, pin the judge
  model, and treat a judge or rubric change as an eval change, not a free
  improvement.
- **The judge is not calibrated against human labels.** Nothing here measures
  how often the judge agrees with a person grading the same replies. Until that
  exists, a judge pass rate is a signal to read, not a measured accuracy.
- **There is no public run with a real judge.** CI and every output in the
  README use the deterministic mock judge. `examples/llm-agent/agent.js` with
  `--judge anthropic` works, but its results are not published here.
- **Substring rules are literal.** `excludes` catches "Riverton", not "a town by
  the river". That is why critical cases also carry a rubric. A real model will
  also fail some `includesAny` rules by phrasing a correct answer differently.
- **The mock judge does not read the rubric.** It applies generic heuristics
  (empty reply, too long, "guarantee") so the pipeline runs offline. A mock
  pass means "nothing obviously wrong".
- **Single turn per scenario.** Multi-turn flows can be tested by having your
  agent function replay a scripted history, but the scenario format does not
  model conversations yet.
- **Small banks give coarse rates.** With 24 cases, one case is 4.2 points.
  Look at which cases moved, not only the percentage.
- **Tokens are recorded when the agent or judge reports them; no price table.**
  Each case keeps the input and output tokens its agent and judge reported,
  summed over trials, and the summary adds them up. The bundled judges and the
  example agent read them from the API; your agent returns `usage`. An attempt
  that ends in an error reports nothing, so retried calls are undercounted, and
  cost is left to you. Spend is limited by running the judge only after the
  rules pass, by `--critical` and `--category` runs, by the offline mock judge,
  by the example agent's low effort and by `JUDGE_EFFORT`.
- **Reports keep every reply.** Each result holds the agent's full reply and
  tool calls. With a real agent and real data, treat the report as sensitive:
  do not commit it or upload it as a public CI artifact. CI here uploads only
  the report of the invented sticker shop.
- **A timeout aborts the signal, it cannot stop your code.** An agent that
  ignores `signal` may keep running after the harness has moved on.

## Roadmap

- Calibrate the judge against a set of human-labelled replies and report the
  agreement rate next to the pass rate.
- Publish one run of the example LLM agent graded by a real judge.
- Multi-turn scenarios.

## Layout

```text
bin/eval.js                 CLI
index.d.ts                  hand-written public types (npm run typecheck and typecheck:types)
src/expectations.js         rule checks and their accepted shapes
src/scenarios.js            loading, validation, filters
src/runner.js               retries, timeouts, bounded concurrency, judge call
src/report.js               summary, critical gate, console and JSON output
src/judges/mock.js          deterministic offline judge
src/judges/llm.js           Anthropic and OpenAI-compatible judges over fetch
src/http.js                 shared fetch call and key redaction for judges and example
src/markdown.js             Markdown summary of a run, for a CI job page
src/compare.js              case-by-case diff of two reports
src/provenance.js           models, bank hash and git commit recorded in each report
examples/sticker-shop/      rule-based agent, regressed agent, 24 scenarios
examples/llm-agent/         Claude tool-use agent for the same scenarios
test/                       node:test suite
test-types/conform.ts       fails the type check if index.d.ts and src/index.js disagree
scripts/lint.mjs            dependency-free lint (syntax and whitespace)
```
