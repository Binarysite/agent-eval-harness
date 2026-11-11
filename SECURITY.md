# Security policy

## Supported versions

Only the latest minor release gets fixes. Today that is the most recent tag on the
[releases page](https://github.com/Binarysite/agent-eval-harness/releases).

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a vulnerability**.
That creates a private advisory that only the maintainer can read.

Include the version or commit, the command you ran, what you expected and what happened.
Use invented data: do not attach real customer messages, real replies or real keys.

This is a one-person project, so there is no bug bounty and no guaranteed response time. A
confirmed issue gets a fix and a mention in the [changelog](CHANGELOG.md).

## Data flow

The harness has no runtime dependencies and sends nothing anywhere by itself. What leaves
your machine depends on the agent and the judge you choose:

- **`--judge mock` and `--judge none`** make no network calls.
- **`--judge anthropic` and `--judge openai`** send the scenario's message, its rubric, the
  agent's reply and the tools it called, with their arguments, to the provider you
  configured (`OPENAI_BASE_URL` can point at any compatible endpoint, including your own).
- **Your agent** receives `{ message, context, signal }` and does whatever it does. The
  bundled `examples/llm-agent/agent.js` sends the message to the Anthropic API.
- **API keys** are read from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and
  are never written to the report. `src/http.js` removes the key, and anything shaped like
  `sk-...`, from the error text a failed call puts in the console or the report.
- **Reports** (`--out`, default `reports/eval-report.json`) keep every reply and tool call
  in full. Treat a report from a real agent as sensitive: do not commit it or upload it as a
  public artifact. `reports/` is in `.gitignore`.
- **The Markdown summary** (`--md`) leaves out replies and the judge's reason. It does quote
  the first failed rule of each failed case, and that text can carry words from the agent: an
  error it threw, the arguments of a tool call, or the phrases your scenario forbids. Strings
  shaped like `sk-...` are redacted, other key formats (Bearer tokens, GitHub or AWS keys) are
  not, and links, bare URLs, emails, @mentions, images and code are escaped so none renders live, but
  the words stay. On a public repository
  the job summary is public, so keep real customer data out of scenarios you run there.

Scenario banks, agent modules and `args` are code and input you provide: the harness
imports your agent module and runs it with your privileges, so run only agents you trust.

## Known limits

- **`excludes` does not fold look-alike letters.** It drops invisible characters, applies
  NFKC and folds whitespace, so zero-width characters, bidi overrides, fullwidth letters or
  a joiner between a letter and its accent do not hide a forbidden phrase. Letters from
  another script that look the same are a different text: `rеfund` with a Cyrillic `е`
  (U+0435) does not match `refund`. Folding confusables (Unicode TR39) needs a data table
  this dependency-free harness does not ship. Pair each critical `excludes` with a rubric
  for an LLM judge, and treat `excludes` as a guard against accidents, not against an
  agent or a prompt injection trying to slip a phrase past it.

