# Agents and judges

Back to the [README](../README.md).

The agent is the default export of a module: `({ message, context, signal }) =>
{ reply, toolCalls }`. Map your stack's result into that shape:

```js
export default async function agent({ message, context, signal }) {
  const res = await runSupportAgent({ message, customerId: context.customerId, signal });
  return { reply: res.text, toolCalls: res.toolUses.map((t) => ({ name: t.name, args: t.input })) };
}
```

If your model reports token counts, also return `usage: { inputTokens, outputTokens }`. The report keeps
them per case and the summary adds them up, next to the judge's own tokens. There is no price table.

```bash
ANTHROPIC_API_KEY=... node bin/eval.js -s ./my-scenarios.json -a ./my-agent.js --judge anthropic --timeout 60000
```

| `--judge` | Environment |
|---|---|
| `mock` (default) | none; does not read the rubric |
| `anthropic` | `ANTHROPIC_API_KEY`, optional `JUDGE_MODEL` (default `claude-sonnet-5-5`) and `JUDGE_EFFORT` (sent only when set) |
| `openai` | `OPENAI_API_KEY`, `JUDGE_MODEL`, optional `OPENAI_BASE_URL` for any OpenAI-compatible endpoint |
| `none` | rules only |

Exit codes: 0 gate passed, 1 gate failed, 2 usage or setup error. Other flags
(`--retries`, `--trials`, `--timeout`, `--min-pass-rate`, `--out`, `--md`) are in
`node bin/eval.js --help`.

`examples/llm-agent/agent.js` is a Claude tool-use agent for the same shop and
scenarios. It calls the API, so it needs a key and is billed. It uses the
judge's default model, `claude-sonnet-5-5`; set `AGENT_MODEL` to change it:

```bash
ANTHROPIC_API_KEY=... npm run eval -- -a examples/llm-agent/agent.js --judge anthropic --timeout 60000
```

CLI: `npx -y github:Binarysite/agent-eval-harness#v0.3.1 -s ... -a ...`. Library: import
from a clone (`./agent-eval-harness/src/index.js`) or pin the tag as a dev dependency,
`"agent-eval-harness": "github:Binarysite/agent-eval-harness#v0.3.1"`. The package is
not on the npm registry (`"private": true` only blocks publishing).

JavaScript (ESM) with JSDoc; the public types in `index.d.ts` are hand-written and checked by tsc in CI.

```js
import { loadScenarios, runSuite, summarize, createMockJudge } from 'agent-eval-harness';
const results = await runSuite(await loadScenarios('scenarios.json'), { agent, judge: createMockJudge() });
if (!summarize(results, { minPassRate: 0.9 }).gate.pass) process.exitCode = 1;
```

What is retried and what is not, and why, is in [DESIGN.md](DESIGN.md).
