import { redactSecrets } from './http.js';
import { pct } from './report.js';

/**
 * A Markdown summary of one run, for a CI job page (`$GITHUB_STEP_SUMMARY`).
 * It restates the gate, lists the cases that did not pass with their first
 * failed rule, and records what makes two runs comparable (judge, model,
 * scenario bank hash, commit). Replies and the judge's free-text reason are
 * not included: they can hold customer data, and the JSON report has them.
 * The text that remains can still carry words from the agent (an error it
 * threw, tool arguments), so every cell is redacted, cut and escaped.
 *
 * @typedef {import('./report.js').Summary} Summary
 * @typedef {import('./runner.js').CaseResult} CaseResult
 */

const MAX_CELL = 240;

/**
 * Make free text safe inside a table cell: no `sk-...` keys, no pipes, no line breaks, no HTML, no live
 * links, images or code spans, bounded length. A backslash is escaped like the rest, so one
 * at the end of the text cannot swallow the closing pipe.
 */
function cell(text) {
  const flat = redactSecrets(String(text).replace(/\s+/g, ' ').trim());
  const cut = flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 3)}...` : flat;
  return cut.replace(/[\\|[\]!`]/g, '\\$&').replace(/</g, '&lt;')
    // GFM autolinks bare URLs, www addresses and emails. An escaped colon or dot stops the
    // first two; nothing escapes '@', so a zero-width space goes before it.
    .replace(/\b(https?):/gi, '$1\\:')
    .replace(/\bwww\./gi, 'www\\.')
    .replace(/@/g, '\u200b@');
}

/** Why a case did not pass: the error, else the first failed rule. The judge's reason stays in the JSON report. */
function firstFailure(r) {
  if (r.error) return `error: ${r.error}`;
  const check = r.checks.find((c) => !c.pass);
  if (check) return `${check.rule}: ${check.detail}`;
  if (r.verdict && r.verdict.pass !== true) return 'judge: no passing verdict (reason in the JSON report)';
  return r.status;
}

/** A hash or commit shortened to what a person compares by eye. */
const short = (value) => (value ? `\`${String(value).slice(0, 12)}\`` : 'none');

/**
 * @param {{ meta?: Record<string, unknown>, summary: Summary, results: CaseResult[] }} report
 * @returns {string}
 */
export function formatMarkdown({ meta = {}, summary: s, results }) {
  const lines = [
    `## agent-eval: ${s.gate.pass ? 'PASS' : 'FAIL'}`,
    '',
    '| Cases | Passed | Failed | Errors | Pass rate | Critical passed |',
    '|---|---|---|---|---|---|',
    `| ${s.total} | ${s.passed} | ${s.failed} | ${s.errors} | ${pct(s.passRate)} (min ${pct(s.minPassRate)}) `
      + `| ${s.critical.passed} of ${s.critical.total} |`,
    '',
  ];
  if (!s.gate.pass) {
    lines.push('The gate failed:', '', ...s.gate.reasons.map((r) => `- ${cell(r)}`), '');
  }
  for (const w of s.warnings) lines.push(`> **Warning:** ${cell(w)}`, '');

  const failing = results.filter((r) => r.status !== 'pass');
  if (failing.length) {
    lines.push('### Cases that did not pass', '', '| Case | Category | Critical | First failure |', '|---|---|---|---|');
    for (const r of failing) {
      lines.push(`| ${cell(r.id)} | ${cell(r.category)} | ${r.critical ? 'yes' : 'no'} | ${cell(firstFailure(r))} |`);
    }
    lines.push('');
  }
  if (s.flaky?.length) lines.push(`Flaky: ${s.flaky.map(cell).join(', ')}`, '');

  const usage = s.usage
    ? Object.entries(s.usage).map(([role, u]) => `${role} ${u.inputTokens} in, ${u.outputTokens} out`).join('; ')
    : null;
  lines.push(
    '### Run',
    '',
    `- Judge: ${cell(meta.judge ?? 'unknown')}${meta.judgeModel ? ` (${cell(meta.judgeModel)})` : ''}`,
    `- Agent: ${cell(meta.agent ?? 'unknown')}${meta.agentModel ? ` (${cell(meta.agentModel)})` : ''}`,
    `- Scenario bank sha256: ${short(meta.scenariosSha256)}`,
    `- Commit: ${short(meta.gitSha)}`,
    ...(usage ? [`- Tokens: ${usage}`] : []),
    '',
  );
  return lines.join('\n');
}
