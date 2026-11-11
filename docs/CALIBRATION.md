# Calibrating a judge

Back to the [README](../README.md).

A judge pass rate means little until you know how often the judge is wrong. Calibration
grades replies whose right verdict is known, several times each, and reports how often the
judge agrees with the labels.

## The labelled set

`examples/sticker-shop/calibration.json` holds 48 replies to the 24 sticker-shop scenarios:

- **24 healthy replies**, exactly what `examples/sticker-shop/agent.js` says (a test fails if
  the agent changes and the set does not). Read one by one against their rubric, 23 are
  labelled `pass` and one `fail`: in `sd-01` the agent's draft states that the packs ship
  internationally in 7 to 14 days, facts the seller never gave. Three `pass` labels are
  marked `ambiguous` (`rf-01`, `rf-02`, `sd-02`), with the reason in their `note`.
- **24 bad replies**, labelled `fail`: the regressed agent's leak, five paraphrased leaks
  ("a town by the river"), seven made-up facts, seven promises the agent cannot keep, two
  off-scope answers and two wrong answers. All but the first get past the scenario's rules:
  they are the cases only a judge can catch.

One labeller wrote the labels; no second labeller checked them, so label noise is not
measured. The `ambiguous` flag is the honest substitute: the report gives every number for
all 48 replies and for the 45 unambiguous ones.

## What is measured

The positive class is a **bad reply**, because catching those is the judge's job.

| Number | Meaning |
|---|---|
| TPR | bad replies the judge failed, out of bad replies |
| FPR | good replies the judge failed, out of good replies |
| Cohen's kappa | agreement with the labels beyond chance (1 perfect, 0 chance) |
| per trial | every verdict counted on its own |
| majority | the verdict most of the k trials gave; a tie is undecided |
| unanimous | share of replies whose k verdicts were all the same |
| mean pairwise agreement | for each reply, the share of trial pairs that agree, averaged |
| rules alone / rules + judge | what the scenario's `expect` rules catch, and what the harness would do (rules, then the judge's majority) |
| cost per 100 verdicts | from the tokens the API reported and the prices you pass |

The judge sees each reply through `runCase`, the same path as a real run (timeouts,
retries, verdict normalization). The scenario's rules are left out of the judged copy, so
the judge grades every reply, and whether the rules would have caught it is recorded next
to the verdicts.

## Running it

```bash
node scripts/calibrate.mjs --judge mock      # free, offline baseline
OPENAI_BASE_URL=https://api.deepseek.com JUDGE_MODEL=deepseek-chat OPENAI_API_KEY=... \
  node scripts/calibrate.mjs --judge openai --trials 5 \
  --price-in 0.30 --price-out 1.20 --max-usd 0.25 --out reports/calibration/my-run.json
```

The harness keeps no price table, so a billed judge needs `--price-in` and `--price-out`
(USD per million tokens). Pass the highest rate that can apply and the cost is an upper
bound. `--max-usd` stops starting verdicts once the cost so far reaches it; verdicts already
in flight finish, so the overshoot is at most `--concurrency` verdicts. Your own set works
the same way: `--labels` and `--scenarios`, with a `cases` array shaped like the example's.
From code, `runCalibration` and `calibrationMetrics` are exported.

The report records the requested model and `servedModels`, the model each response said
answered. They can differ: a provider alias maps to whatever model the provider serves that
day, which is exactly what a calibration has to pin down.
