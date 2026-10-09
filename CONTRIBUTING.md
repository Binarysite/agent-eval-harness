# Contributing

This is a small tool with a narrow job: make a release gate for an agent trustworthy and
easy to use.

## Scope

In: rule checks, the critical gate, judges, reports, `compare`, the CLI and the action.
Out, on purpose: a dashboard, hosted datasets, tracing, a price table and runtime
dependencies. For those, an eval platform is the better fit. For anything else, open an
issue first so we agree on the shape before you write code.

## Checks

Node 22 or newer. `npm ci` installs only TypeScript, for the type checks. CI runs these on
Node 22 and 24, so run them before you open a pull request:

```bash
npm ci
npm run lint
npm run typecheck
npm run typecheck:types
npm audit --omit=dev --audit-level=high
npm test
npm run eval              # exits 0
npm run eval:regression   # exits 1, on purpose
```

## Changes

- One test per change, in `test/`, with `node:test`. A bug fix starts with a test that fails.
- Update `index.d.ts` for public API changes, and the README if a command or its output
  changes.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), one change
  per commit.
- Add a line under Unreleased in `CHANGELOG.md` for anything a user would notice.
- Keep it simple: no new dependency, and no abstraction before its second use.
