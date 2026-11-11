# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A hung agent could exceed the concurrency limit. A timed-out call that was not retried
  returned at once while the agent kept running, so the next trial or case started next to
  it: with an agent ignoring the abort, `--trials 3` had 3 calls in flight for one case and
  `--concurrency 1` with 4 cases had 4. A timed-out call is now always waited for, up to one
  more timeout; one still running after that is reported as stuck. A hung case can now take
  up to twice `--timeout`.
- A blank numeric flag read as 0: `Number('')` and `Number(' ')` are 0, so
  `--min-pass-rate "$UNSET"` silently gated at 0. Numeric flags now reject a blank value,
  and the action treats a whitespace-only `min-pass-rate` as unset.
- `-o ""` or an unwritable `--out` file ran the whole, possibly billed, suite and then
  exited 0 without a report. A blank path, or a file that cannot be opened for writing, now
  fails before the run for both `--out` and `--md` (exit 2); the check leaves no empty file
  behind. A report that cannot be written after the run now exits 2 instead of 0 or 1.
- `excludes` and `includesAny` missed phrases split by invisible characters outside a short
  hand-kept list (a left-to-right mark, a bidi override, tag characters, U+034F, U+FE0F,
  U+180E, U+2062, U+3164) or by a line break or a double space. Both sides now drop every
  `Default_Ignorable_Code_Point` after NFKC and fold any run of whitespace to one space.
- With `--judge mock` (the CLI and action default) every rubric went ungraded without a word
  before `RESULT: PASS`. The console and the Markdown summary now warn, for example
  `23 rubric(s) not graded: judge mock or none, or the judge failed`.

### Documentation

- The judge is described as measured, not calibrated: rules plus `deepseek-reasoner` caught
  25 of 25 bad replies (`deepseek-chat` 24 of 25) after a fix made in response to the same
  labelled set. The LLM-agent run report now says its judge predates that fix and saw tool
  calls, not their results.

## [0.4.0] - 2026-11-11

### Added

- Judge calibration: 48 labelled sticker-shop replies (`examples/sticker-shop/calibration.json`),
  `scripts/calibrate.mjs`, and `runCalibration` / `calibrationMetrics`: TPR, FPR and Cohen's
  kappa against the labels, self-consistency across trials, rules vs judge, cost per 100
  verdicts, with a hard cost cap. See `docs/CALIBRATION.md`.
- Published DeepSeek runs: the calibration (`deepseek-reasoner`: 25 of 25 bad replies caught,
  1 of 23 good ones failed, kappa 0.958), the example LLM agent at `--trials 5`, and a first
  judge run from 2026-10-10. Reports and raw JSON in `reports/`.
- Tool calls may carry `result`; the judge sees it and the rules ignore it. The calibration
  showed why: without it, a reply that misquoted a lookup passed 5 of 5.
- A 95% Wilson interval next to every pass rate, and `compare` says whether a change is
  within noise.
- `schema/scenarios.schema.json`, generated from the validator (`npm run schema`). A bank may
  be `{ "$schema", "scenarios" }`.
- The Anthropic judge asks for a structured verdict (`output_config.format`), defaults to
  `effort: low` and allows 16,000 output tokens.
- Verdicts record `servedModel`; `--retry-on-timeout`; `ANTHROPIC_BASE_URL` for the example
  agent.

### Changed

- A harness timeout is no longer retried by default (see Fixed).
- `compare` shows a different commit as an info line, not a warning.
- The starter agent is `examples/starter/agent.mjs`.
- Shared helpers live in `src/util.js`; imports point one way.

### Fixed

- A timed-out call overlapped its retry: 50 ms timeout, 2 retries and a 120 ms agent meant
  three billed calls in flight for one case. Calls for one case now never overlap.
- A bad `--out` path failed after the run, discarding it and turning exit 1 into exit 2. It
  now fails before the first call.
- `summarize()` accepted `minPassRate: NaN`, which passed every gate.
- `excludes` missed phrases split by zero-width characters or written in fullwidth letters.
- `toolArgs` accepted an empty argument object, which matched any call.
- `parseVerdict` failed on a brace in the judge's reasoning before the verdict.

### Security

- Provider error bodies are no longer copied into thrown errors (they can echo a masked key).
- Redaction also covers `xai-`, `AIza`, GitHub tokens and `Bearer` tokens.

## [0.3.1] - 2026-10-10

### Added

- `examples/starter`: a three-scenario bank and an agent stub to copy for your own agent,
  covered by a test.
- CI runs the tests with a coverage floor.

### Changed

- The README leads with the gate, and the reference material moved to `docs/SCENARIOS.md`
  and `docs/AGENTS-AND-JUDGES.md`.
- The README links the tools that work with the harness, and the action example is pinned to
  the v0.3.0 commit.
- The install examples now point at the v0.3.1 tag.

### Tests

- A test fails when the output blocks in the README drift from a real run.

## [0.3.0] - 2026-10-09

### Added

- `--md <file>` appends a Markdown summary of the run (gate, totals, the cases that did not
  pass with their first failed rule, and the run provenance) to a file, for example
  `--md "$GITHUB_STEP_SUMMARY"`. Replies and the judge's reason are left out of it, and the
  text that remains is redacted and escaped, so links, bare URLs, emails and @mentions from
  the agent do not render live. A `--md` path whose folder cannot be created
  fails before the run (exit 2); a summary that cannot be appended after the run is a
  warning, not a different exit code.
- `action.yml`: a composite GitHub Action that runs the gate and writes that summary to the
  job page. It takes multi-line `args`, refuses a Node older than 22 with a clear message, and
  a CI job exercises it on every push.
- `SECURITY.md`: supported versions, private reporting and where data goes.
- `CONTRIBUTING.md`: the checks CI runs, the scope and how changes are made.
- A bug report form for GitHub issues.
- Dependabot keeps the pinned GitHub Actions current, weekly.

## [0.2.0] - 2026-10-09

### Added

- Token usage: an agent can return `usage: { inputTokens, outputTokens }`, the bundled judges
  and the example agent read it from the API, and the case results, the summary and the
  console record it. There is no price table, so no cost.
- Type declarations checked in CI: `test-types/conform.ts` fails the type check when
  `index.d.ts` and `src/index.js` disagree, and `typecheck:types` checks the declarations
  alone with `--strict`.
- The README shows how to install from GitHub and what CI checks.

### Changed

- The example LLM agent defaults to the judge's model; `AGENT_MODEL` changes it.
- The Anthropic judge sends `effort` only when it is configured (`JUDGE_EFFORT`).
- `compare` also warns when the two runs selected different cases or trials.
- CI pins third-party actions by commit, stops a job after 10 minutes, no longer keeps the
  checkout token, and audits runtime dependencies at high severity.

### Fixed

- Invalid options, unknown scenario fields and unknown categories are rejected before the
  run; usage errors exit 2 with a pointer to `--help`.
- A judge reply that cannot be parsed quotes the first 80 characters of what the judge said.
- Reports record agent and scenario paths relative to the working directory.
- The case counter goes to stderr and only when it is a terminal.

## [0.1.0] - 2026-10-08

### Added

- Rule checks (`tools`, `noTools`, `anyTool`, `handoff`, `toolArgs`, `includesAny`,
  `excludes`), scenario loading and validation, and an optional LLM judge (Anthropic and
  OpenAI-compatible, over `fetch`) next to a deterministic mock judge.
- Critical-case gating: one critical failure fails the run whatever the pass rate. A critical
  case needs at least one deterministic rule, so one that passed on its rubric alone with the
  mock judge or no judge fails the gate.
- The agent receives only `{ message, context, signal }`, never the scenario's `expect` or
  `rubric`.
- `--trials k` runs each case k times and marks mixed results as flaky; a critical case must
  pass k of k.
- Run provenance in every report: judge and agent models, the SHA-256 of the scenario bank and
  the git commit. `compare` diffs two reports case by case and warns when the setups differ.
- Retries for infrastructure failures only, with exponential backoff, full jitter and
  `Retry-After`.
- A sticker-shop example with a healthy agent, a regressed agent and 24 scenarios, a Claude
  tool-use example agent, and CI with a dependency-free lint, `npm audit` and a regression step
  that requires exactly exit 1.

[Unreleased]: https://github.com/Binarysite/agent-eval-harness/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Binarysite/agent-eval-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Binarysite/agent-eval-harness/releases/tag/v0.1.0
