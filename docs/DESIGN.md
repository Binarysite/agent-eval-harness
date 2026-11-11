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
policy: a network error, an abort, a 429 or a 5xx is retried
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
`retryable: false` on an error that would repeat.

**A timed-out call is not retried unless you ask, and is waited for.** A
timeout aborts the signal, but it cannot stop code that ignores the signal, so a
retry started at once would run next to the call it replaces: with a 50 ms
timeout, two retries and a 120 ms agent, three calls for one case were in flight
together, each billed. The same happened between cases: with `--concurrency 1`
and four hung cases, four calls were in flight. So a timed-out call is always
waited for, up to one more `--timeout`, before the case retries, ends or hands
its slot to the next trial or case; a call still running after that is reported
as stuck and not retried, and only then can calls overlap. A timeout ends the
case as `error` by default; with `--retry-on-timeout` (`retryOnTimeout`) it is
retried once the call has settled. A hung case therefore takes up to twice
`--timeout`. Raise `--timeout` (default 10 s) for a real tool loop
or an LLM judge.
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
bank's `scenariosSha256` and the `gitSha`. `compare` warns when the models or
the bank differ, because a status change between two setups may come from the
setup, and prints a different commit as an info line, since comparing two
commits is what it is for.
Keys are read from the environment only and never written to the report.

**The CI summary is append-only and leaves the replies out.** `--md` appends to the
file because a job summary collects the output of several steps, and it lists only
the first failed rule per case, with no replies and no judge reasons: on a public
repository the page is public, and the JSON report already holds them. What remains
is redacted, cut and escaped, since it can still carry words from the agent.

**Output paths are checked before the first call.** For both `--out` and `--md`, a
blank path, a folder that cannot be created, a path that is a folder, or a file that
cannot be opened for writing fails before the run (exit 2), so a bad path costs no
billed calls. The check opens the file for appending, which never truncates it, and
removes it again if it did not exist, so a run that stops early leaves no empty file.
A report that still cannot be written after the run exits 2 whatever the gate said,
since a CI step must not pass without the report it promised. A Markdown summary
that cannot be appended after the run is only an error message: the gate keeps its
exit code. Numeric flags reject a blank value, because `Number('')` is 0 and an unset
shell variable in `--min-pass-rate "$RATE"` would otherwise gate at 0.

**The action runs the gate and nothing else.** It is a composite action with no
install step, because there is nothing to install, and it does not upload the JSON
report, since that holds every reply in full. Inputs reach the script through
environment variables, never through its text, so a value cannot inject shell.

**Zero runtime dependencies.** Node 22+, `node:test` for tests, `fetch` for the
optional LLM judges. TypeScript is a dev dependency only. `npm run typecheck`
checks, in non-strict mode, the JSDoc in `src` and `bin` and that the
implementation matches the hand-written declarations in `index.d.ts`.
`npm run typecheck:types` checks `index.d.ts` on its own with `--strict`.
CI runs both. Generating the declarations from the JSDoc instead
(`tsc --declaration --emitDeclarationOnly --allowJs`) was tried: it gives 11
files with 38 `any` where `index.d.ts` has none, because the internal helpers
are loosely typed. The hand-written file stays the contract, and the conform
check keeps the code honest to it.

## Known limits

- **LLM judges make mistakes in both directions.** A strict judge produces false
  negatives (a correct reply phrased differently, or "should also have called
  tool X" when it did not need to). A lenient one waves through confident
  nonsense. Read the failing verdicts before trusting a number, pin the judge
  model, and treat a judge or rubric change as an eval change, not a free
  improvement.
- **The judge is calibrated on one small labelled set.** `docs/CALIBRATION.md`
  and `reports/calibration/` measure two DeepSeek judges against 48 labelled
  replies (one labeller). With 25 bad and 23 good replies, every rate has a wide
  interval, and a different bank or model needs its own calibration.
- **The judge checks facts only against tool results the agent reports.** A
  reply that misquoted a lookup ("arrives Monday" when the lookup said Thursday)
  passed both calibrated judges 5 of 5 times while the judge saw only tool
  calls. A tool call may now carry its `result`, which the judge sees (cut to
  1000 characters) and the rules ignore; an agent that does not report results
  keeps the blind spot.
- **Real runs are few.** CI and every output in the README use the mock judge.
  Published real runs: the 2026-10-10 judge run, the 2026-11-11 calibration and
  the 2026-11-11 LLM-agent run, all on DeepSeek. No Anthropic run is published.
- **Substring rules are literal.** `excludes` catches "Riverton", not "a town by
  the river". That is why critical cases also carry a rubric. A real model will
  also fail some `includesAny` rules by phrasing a correct answer differently.
- **The mock judge does not read the rubric.** It applies generic heuristics
  (empty reply, too long, "guarantee") so the pipeline runs offline. A mock
  pass means "nothing obviously wrong".
- **Single turn per scenario.** Multi-turn flows can be tested by having your
  agent function replay a scripted history (see `examples/starter`, scenario
  `history-01`), but the scenario format does not model conversations yet.
- **Small banks give coarse rates.** With 24 cases, one case is 4.2 points,
  and the 95% Wilson interval of 23 of 24 is 79.8% to 99.3%. The summary
  prints the interval and `compare` labels a change "within noise" when the two
  intervals overlap. That test is conservative: two rates can differ
  significantly with overlapping intervals. Look at which cases moved, not
  only the percentage.
- **Tokens are recorded when the agent or judge reports them; no price table.**
  Each case keeps the input and output tokens its agent and judge reported,
  summed over trials, and the summary adds them up. The bundled judges and the
  example agent read them from the API; your agent returns `usage`. An attempt
  that ends in an error reports nothing, so retried calls are undercounted, and
  cost is left to you. Spend is limited by running the judge only after the
  rules pass, by `--critical` and `--category` runs, by the offline mock judge,
  by the example agent's low effort and by the Anthropic judge's `low` default
  effort (`JUDGE_EFFORT`).
- **Reports keep every reply.** Each result holds the agent's full reply and
  tool calls. With a real agent and real data, treat the report as sensitive:
  do not commit it or upload it as a public CI artifact. CI here uploads only
  the report of the invented sticker shop.
- **A timeout aborts the signal, it cannot stop your code.** An agent that
  ignores `signal` may keep running after the harness has moved on to the next
  case; it is never retried while it runs.

## Roadmap

- A first-class conversation history in the scenario format (today it goes in
  `context`, see `examples/starter`).

## Layout

```text
bin/eval.js                 CLI
index.d.ts                  hand-written public types (npm run typecheck and typecheck:types)
src/expectations.js         rule checks and their accepted shapes
src/scenarios.js            loading, validation, filters
src/schema.js               JSON Schema of a bank, built from the validator's tables
src/runner.js               retries, timeouts, bounded concurrency, judge call
src/report.js               summary, critical gate, console and JSON output
src/judges/mock.js          deterministic offline judge
src/judges/llm.js           Anthropic and OpenAI-compatible judges over fetch
src/http.js                 shared fetch call for the judges and the example agent
src/util.js                 percentages, token sums, key redaction (imported, never importing)
src/markdown.js             Markdown summary of a run, for a CI job page
src/compare.js              case-by-case diff of two reports
src/calibration.js          judge calibration against labelled replies
src/provenance.js           models, bank hash and git commit recorded in each report
examples/sticker-shop/      rule-based agent, regressed agent, 24 scenarios, 48 labelled replies
examples/llm-agent/         Claude tool-use agent for the same scenarios
examples/starter/           three scenarios and an agent stub to start your own bank
schema/scenarios.schema.json generated by npm run schema; test/schema.test.js keeps it current
docs/SCENARIOS.md           how to write scenarios and rules
docs/AGENTS-AND-JUDGES.md   agent contract, judges, flags, library API
docs/CALIBRATION.md         how the judge calibration works and how to run it
test/                       node:test suite
test-types/conform.ts       fails the type check if index.d.ts and src/index.js disagree
scripts/lint.mjs            dependency-free lint (syntax, whitespace, no em dashes)
scripts/build-schema.mjs    writes schema/scenarios.schema.json
scripts/calibrate.mjs       runs a judge over the labelled replies (docs/CALIBRATION.md)
```
