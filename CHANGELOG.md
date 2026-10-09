# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--md <file>` appends a Markdown summary of the run (gate, totals, the cases that did not
  pass with their first failed rule, and the run provenance) to a file, for example
  `--md "$GITHUB_STEP_SUMMARY"`. Replies are left out of it.
- `action.yml`: a composite GitHub Action that runs the gate and writes that summary to the
  job page. A CI job exercises it on every push.
- `SECURITY.md`: supported versions, private reporting and where data goes.
- `CONTRIBUTING.md`: the checks CI runs, the scope and how changes are made.

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
- Critical-case gating: one critical failure fails the run whatever the pass rate.
- `--trials k` runs each case k times and marks mixed results as flaky; a critical case must
  pass k of k.
- Run provenance in every report: judge and agent models, the SHA-256 of the scenario bank and
  the git commit. `compare` diffs two reports case by case and warns when the setups differ.
- Retries for infrastructure failures only, with exponential backoff, full jitter and
  `Retry-After`.
- A sticker-shop example with a healthy agent, a regressed agent and 24 scenarios, a Claude
  tool-use example agent, and CI with a dependency-free lint and `npm audit`.

### Changed

- A critical case needs at least one deterministic rule. A critical case that passed on its
  rubric alone with the mock judge or no judge fails the gate.
- The agent receives only `{ message, context, signal }`, never the scenario's `expect` or
  `rubric`.
- The regression step in CI requires exactly exit 1.

[Unreleased]: https://github.com/Binarysite/agent-eval-harness/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Binarysite/agent-eval-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Binarysite/agent-eval-harness/releases/tag/v0.1.0
