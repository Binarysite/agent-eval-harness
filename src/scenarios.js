import { readFile } from 'node:fs/promises';
import { NON_EMPTY_STRING, isObject, validateExpectation } from './expectations.js';

/**
 * @typedef {object} Scenario
 * @property {string} id            Stable, unique id (used in reports and diffs).
 * @property {string} category      Grouping for filters and per-category scores.
 * @property {string} message       What the user says to the agent.
 * @property {boolean} [critical]   A failing critical case fails the whole run.
 * @property {Record<string, unknown>} [context]  Passed to the agent as-is (user id, role...).
 * @property {Record<string, unknown>} [expect]   Rule-based expectations, see expectations.js.
 * @property {string} [rubric]      Plain-language criteria for the LLM judge.
 */

/** Every field a scenario may have, with its JSON Schema (`expect` is filled in by schema.js). */
export const FIELD_SCHEMAS = Object.freeze({
  id: { ...NON_EMPTY_STRING, description: 'Stable, unique id (used in reports and diffs).' },
  category: { ...NON_EMPTY_STRING, description: 'Grouping for filters and per-category scores.' },
  message: { ...NON_EMPTY_STRING, description: 'What the user says to the agent.' },
  critical: { type: 'boolean', description: 'A failing critical case fails the whole run.' },
  context: { type: 'object', description: 'Passed to the agent as-is (user id, role, a scripted history).' },
  expect: { type: 'object', description: 'Rule-based expectations.' },
  rubric: { ...NON_EMPTY_STRING, description: 'Plain-language criteria for the LLM judge.' },
});
const FIELDS = new Set(Object.keys(FIELD_SCHEMAS));

/**
 * Problems with one scenario, each prefixed with `at`.
 * @param {Record<string, unknown>} s
 * @param {string} at
 * @returns {string[]}
 */
function validateScenario(s, at) {
  const errors = [];
  // A typo like "critcal" would otherwise turn a release blocker into an ordinary case.
  for (const key of Object.keys(s)) if (!FIELDS.has(key)) errors.push(`unknown field "${key}"`);
  for (const field of ['id', 'category', 'message']) {
    if (typeof s[field] !== 'string' || !s[field].trim()) errors.push(`"${field}" must be a non-empty string`);
  }
  if (s.critical !== undefined && typeof s.critical !== 'boolean') errors.push('"critical" must be boolean');
  if (s.rubric !== undefined && (typeof s.rubric !== 'string' || !s.rubric.trim())) {
    errors.push('"rubric" must be a non-empty string');
  }
  if (s.context !== undefined && !isObject(s.context)) errors.push('"context" must be an object');
  if (s.expect !== undefined && !isObject(s.expect)) errors.push('"expect" must be an object');

  const rules = isObject(s.expect) ? Object.entries(s.expect) : [];
  if (!rules.length && !s.rubric) errors.push('needs "expect" rules, a "rubric", or both');
  // A rubric alone is only as good as the judge, and the mock judge does not read it.
  if (s.critical === true && !rules.length) errors.push('a critical case needs at least one "expect" rule');
  for (const [key, value] of rules) {
    const problem = validateExpectation(key, value);
    if (problem) errors.push(problem);
  }
  return errors.map((e) => `${at}: ${e}`);
}

/**
 * A bank is an array of scenarios, or an object with `scenarios` and an optional
 * `$schema` (so an editor can find schema/scenarios.schema.json).
 * @param {unknown} raw
 * @returns {unknown[]}
 */
function unwrapBank(raw) {
  if (Array.isArray(raw)) return raw;
  const bank = /** @type {any} */ (raw);
  if (!isObject(bank) || !Array.isArray(bank.scenarios)) {
    throw new Error('must contain a JSON array of scenarios, or an object with a "scenarios" array');
  }
  const extra = Object.keys(bank).filter((k) => k !== 'scenarios' && k !== '$schema');
  if (extra.length) throw new Error(`unknown key "${extra[0]}" next to "scenarios" (only "$schema" may be there)`);
  if (bank.$schema !== undefined && typeof bank.$schema !== 'string') throw new Error('"$schema" must be a string');
  return bank.scenarios;
}

/**
 * Validate a scenario bank. Collects every problem instead of stopping at the
 * first, so a broken bank is fixed in one pass. Unknown fields and expectation
 * keys are errors: a typo like `exclude` must not silently turn into "no check".
 * @param {unknown} raw  an array of scenarios, or `{ $schema?, scenarios }`
 * @returns {Scenario[]}
 */
export function validateScenarios(raw) {
  const bank = /** @type {any[]} */ (unwrapBank(raw));
  const errors = [];
  const seen = new Set();
  for (const [i, s] of bank.entries()) {
    const at = `scenario[${i}]${s && s.id ? ` (${s.id})` : ''}`;
    if (!isObject(s)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    errors.push(...validateScenario(s, at));
    if (typeof s.id === 'string') {
      if (seen.has(s.id)) errors.push(`${at}: duplicate id`);
      seen.add(s.id);
    }
  }
  if (errors.length) throw new Error(`Invalid scenarios:\n  ${errors.join('\n  ')}`);
  return bank;
}

/**
 * Read and validate a JSON scenario file.
 * @param {string | URL} file
 * @returns {Promise<Scenario[]>}
 */
export async function loadScenarios(file) {
  const raw = await readFile(file, 'utf8');
  let bank;
  try {
    bank = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON: ${err.message}`);
  }
  try {
    return validateScenarios(bank);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

/**
 * @param {Scenario[]} scenarios
 * @param {{ categories?: string[], criticalOnly?: boolean }} [filter]
 * @returns {Scenario[]}
 */
export function filterScenarios(scenarios, { categories = [], criticalOnly = false } = {}) {
  return scenarios.filter(
    (s) => (!categories.length || categories.includes(s.category)) && (!criticalOnly || s.critical === true),
  );
}
