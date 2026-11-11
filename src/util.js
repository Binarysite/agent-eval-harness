/**
 * Small helpers shared by several modules. They live here so that the
 * dependency graph points one way: runner, report, markdown and compare import
 * from util, never from each other.
 *
 * @typedef {{ inputTokens: number, outputTokens: number }} Usage
 * @typedef {{ agent?: Usage, judge?: Usage }} UsageByRole
 */

/** setTimeout fires at once for a delay longer than this. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Format a 0..1 ratio as a percentage with one decimal. */
export function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Add up token counts per role. Returns undefined when nothing reported any,
 * so a run without usage shows no token line at all.
 * @param {Array<UsageByRole | undefined>} list
 * @returns {UsageByRole | undefined}
 */
export function sumUsage(list) {
  let total;
  for (const usage of list) {
    for (const role of /** @type {const} */ (['agent', 'judge'])) {
      if (!usage?.[role]) continue;
      total ??= {};
      const t = (total[role] ??= { inputTokens: 0, outputTokens: 0 });
      t.inputTokens += usage[role].inputTokens;
      t.outputTokens += usage[role].outputTokens;
    }
  }
  return total;
}

/**
 * "agent 1200 in, 300 out  judge 800 in, 40 out", for the roles that reported tokens.
 * @param {UsageByRole} usage
 * @param {string} [separator]
 */
export function formatUsage(usage, separator = '  ') {
  return Object.entries(usage)
    .map(([role, u]) => `${role} ${u.inputTokens} in, ${u.outputTokens} out`)
    .join(separator);
}

// Key shapes of the providers a judge or agent is likely to call, masked ones included
// ("sk-ab***yz"): OpenAI and Anthropic, xAI, Google, GitHub.
const KEY_SHAPES = /\b(?:sk-|xai-)[\w*-]+|\bAIza[\w-]{10,}|\bgh[pousr]_\w{10,}|\bgithub_pat_\w+/g;

/**
 * Remove the given secrets, anything shaped like a provider key and the token
 * after `Bearer` from text that may end up in the console or the report.
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(KEY_SHAPES, '[redacted]').replace(/\b(Bearer)\s+(?!\[redacted\])\S+/gi, '$1 [redacted]');
}
