# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A timed-out call no longer overlaps its retry. The harness cannot stop an agent that ignores
  its abort signal, so an immediate retry ran next to it: a 50 ms timeout, two retries and a
  120 ms agent put three billed calls in flight for one case. A timeout is now not retried by
  default; `--retry-on-timeout` (`retryOnTimeout`) retries it once the call has settled.
- A bad `--out` path fails before the run (exit 2) instead of after it, when it discarded a
  finished run and turned a failed gate (exit 1) into a setup error (exit 2).
- `summarize()` rejects a `minPassRate` that is not a number from 0 to 1. `NaN` used to pass
  every gate.
- `excludes` and `includesAny` normalize the reply and the phrase (NFKC, no zero-width
  characters or soft hyphens, lowercase), so "pro\u200Bduction" or fullwidth letters no longer
  slip past a forbidden phrase.
- `toolArgs` rejects an empty argument object, which matched any call to the tool.
- Key redaction also covers `xai-`, `AIza`, `ghp_` and `github_pat_` keys and any `Bearer`
  token.

### Changed

- The starter agent is `examples/starter/agent.mjs`, so it runs as ES module code without a
  `package.json`, and the README downloads it from the same tag it runs.
- The README is shorter, and a test checks that its pinned actions match the CI and that
  every tag it and the docs mention is the same.
- `compare` prints a different commit as an info line (`commits: abc -> def`) instead of a
  warning, and returns it in `notes`: comparing two commits is what it is for.
- Shared helpers moved to `src/util.js`, so `report`, `markdown` and `compare` no longer
  import from `runner`, `http` and `report`.

### Added

- A tool call may carry `result`, what the tool returned. The judge sees it (cut to 1000
  characters) and is told that facts in the reply must match it; the rules ignore it. Both
  example agents report their results. The calibration found the gap: a reply that misquoted
  a lookup passed both DeepSeek judges 5 of 5 times when they saw only the call.
- Published runs on the real DeepSeek API: a calibration of `deepseek-chat` and
  `deepseek-reasoner` on the 48 labelled replies, 5 trials each (`reports/calibration/`), and
  the example LLM agent on `deepseek-chat` over the 24 scenarios, 5 trials
  (`reports/llm-agent-run/`), and the calibration re-run once the judge sees tool results
  (`deepseek-reasoner`: 25 of 25 bad replies caught, 1 of 23 good ones failed, kappa 0.958).
  The README limits cite them.
- Judge calibration: `examples/sticker-shop/calibration.json` (48 labelled replies: the
  healthy agent's 24 and 24 bad ones, most of which get past the rules),
  `scripts/calibrate.mjs`, and `runCalibration` / `calibrationMetrics` in the library. It
  reports TPR, FPR and Cohen's kappa against the labels, per trial and by majority,
  self-consistency across trials, what the rules alone catch, and cost per 100 verdicts from
  prices you pass. See `docs/CALIBRATION.md`.
- The example LLM agent reads `ANTHROPIC_BASE_URL`, so it runs against any endpoint that
  speaks the Messages API.
- Judge verdicts record `servedModel`, the model the API says answered, since an alias can
  map to a different model than the one requested.
- `schema/scenarios.schema.json`, a JSON Schema (draft 2020-12) of a scenario bank, generated
  from the validator's own rule and field tables by `npm run schema`; a test fails when it is
  stale and checks that it rejects what the validator rejects. A bank may now be an object
  with `scenarios` and `$schema`, so an editor finds the schema; the examples use that form.
  Ajv is a dev dependency for that test only; there are still no runtime dependencies.
- The summary carries a 95% Wilson interval of the pass rate (`passRateInterval`), printed next
  to it in the console and the Markdown summary. `compare` says whether a pass-rate change is
  within noise (the two intervals overlap) or beyond it. The gate still compares the rate itself.
- The Anthropic judge asks for a structured verdict (`output_config.format`, a JSON schema of
  `{ pass: boolean, reason: string }`), defaults to `effort: low` and allows 16,000 output
  tokens, so thinking no longer uses up the budget before the verdict. `effort: null` and
  `structured: false` turn either off for a model that does not take them.
- `parseVerdict` falls back to the last balanced `{...}` that is a verdict, so a brace in the
  judge's reasoning before the JSON (`Considering {the rubric}: {"pass": true}`) still parses.
- A published run of the real LLM judge (`openai` judge, `deepseek-chat`) over the 24 sticker-shop
  scenarios, with the report in `reports/real-judge-run/`: 23 of 24 verdicts matched the expected
  pass, 4849 tokens in and 673 out. The README limits section now cites it.

### Security

- Provider error bodies are no longer copied into thrown errors (they can echo a masked key).

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

[Unreleased]: https://github.com/Binarysite/agent-eval-harness/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Binarysite/agent-eval-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Binarysite/agent-eval-harness/releases/tag/v0.1.0
