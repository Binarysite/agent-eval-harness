# Real judge run, 2026-10-10

One run of the LLM judge over the 24 scenarios of `examples/sticker-shop` with the healthy
rule-based agent (`examples/sticker-shop/agent.js`). The agent makes no model calls; only the judge does.

| | |
|---|---|
| Date | 2026-10-10 (17:47 UTC) |
| Judge | `openai` (OpenAI-compatible), `JUDGE_MODEL=deepseek-chat`, `OPENAI_BASE_URL=https://api.deepseek.com` |
| Harness commit | d4321354eb32a501e7b31cfb64a0f70e228e20f6 |
| Scenarios sha256 | 255ad547c2013482ee9cdc96f7b9e9ecbd0ecea53ba5a7138e9af73f67d1e68a |
| Cases graded by the judge | 24 of 24 (every rule passed first) |
| Judge tokens | 4849 in, 673 out |
| Cost | under USD 0.01. `deepseek-chat` is not on DeepSeek's pricing page today; at the highest rate listed there (USD 1.20 per MTok out, 0.30 per MTok in) these tokens come to USD 0.0023 |
| Raw report | [deepseek-chat-2026-10-10.json](deepseek-chat-2026-10-10.json) |

## Result

Gate: PASS (23 of 24, 95.8%, bar 90%). Critical 8 of 8.

There are no human labels. Taking "the healthy agent should pass every scenario" as the
expected outcome, the judge agreed on **23 of 24**. The one disagreement:

- `sd-02` (seller draft): the judge failed it, saying the draft adds "this weekend only" and
  "before Sunday night", terms the seller did not give. The reply was: "Our holiday stickers
  are 20% off this weekend only. Grab yours before Sunday night!". The rubric allows no added
  terms, and "before Sunday night" is an added deadline, so this may be a correct catch
  rather than a judge error. Nobody has labeled it either way.

## Not run

An Anthropic judge run (planned with `claude-haiku-5-5`) was not done: no Anthropic API key
was available in the approved key stores. One scenario bank, one agent, one judge model and
one trial: a single sample, not a calibration.
