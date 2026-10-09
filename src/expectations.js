import { isDeepStrictEqual } from 'node:util';

/**
 * Rule-based expectations. Each rule is cheap, deterministic and explainable:
 * it either holds for the agent output or it does not, and the failure message
 * says exactly why. Rules cover what can be checked without judgment (which
 * tools ran, what text must never appear). Anything that needs judgment goes in
 * the scenario's `rubric` for the LLM judge.
 *
 * @typedef {{ name: string, args?: Record<string, unknown> }} ToolCall
 * @typedef {{ reply: string, toolCalls: ToolCall[] }} AgentOutput
 * @typedef {{ rule: string, pass: boolean, detail: string }} CheckResult
 * @typedef {{ handoffTool: string }} CheckOptions
 * @typedef {object} Rule
 * @property {string} expects   completes the sentence `"<key>" must ...` in validation errors
 * @property {(value: unknown) => boolean} valid
 * @property {(value: any, out: AgentOutput, called: string[], opts: CheckOptions) => Omit<CheckResult, 'rule'>} check
 */

const lower = (s) => String(s).toLowerCase();
const quote = (list) => list.map((x) => JSON.stringify(x)).join(', ');
/** A plain object: not null, not an array. */
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// An empty string is in every reply and in no tool name, so it would make the rule vacuous.
const isStringList = (v) => Array.isArray(v) && v.length > 0
  && v.every((x) => typeof x === 'string' && x.trim() !== '');
const isBoolean = (v) => typeof v === 'boolean';
const isArgsMap = (v) => isObject(v) && Object.keys(v).length > 0 && Object.values(v).every(isObject);

/** True when every key in `expected` deep-equals the same key in `actual`. */
function argsMatch(actual = {}, expected = {}) {
  return Object.entries(expected).every(([k, v]) => isDeepStrictEqual(actual[k], v));
}

/** @type {Record<string, Rule>} */
const RULES = {
  tools: {
    expects: 'be a non-empty array of non-empty strings',
    valid: isStringList,
    check(names, _out, called) {
      const missing = names.filter((n) => !called.includes(n));
      return {
        pass: missing.length === 0,
        detail: missing.length ? `expected tool(s) not called: ${missing.join(', ')}` : `called ${names.join(', ')}`,
      };
    },
  },

  noTools: {
    expects: 'be a non-empty array of non-empty strings',
    valid: isStringList,
    check(names, _out, called) {
      const hit = names.filter((n) => called.includes(n));
      return {
        pass: hit.length === 0,
        detail: hit.length ? `forbidden tool(s) called: ${hit.join(', ')}` : 'no forbidden tools called',
      };
    },
  },

  anyTool: {
    expects: 'be boolean',
    valid: isBoolean,
    check(required, _out, called) {
      const pass = required ? called.length > 0 : called.length === 0;
      const ok = required ? 'called at least one tool' : 'called no tools';
      const bad = required
        ? 'expected at least one tool call, got none'
        : `expected no tool calls, got: ${called.join(', ')}`;
      return { pass, detail: pass ? ok : bad };
    },
  },

  handoff: {
    expects: 'be boolean',
    valid: isBoolean,
    check(required, _out, called, { handoffTool }) {
      const did = called.includes(handoffTool);
      const pass = did === required;
      const ok = did ? `handed off via ${handoffTool}` : 'did not hand off';
      const bad = required
        ? `expected a handoff (${handoffTool}), none happened`
        : `unexpected handoff (${handoffTool})`;
      return { pass, detail: pass ? ok : bad };
    },
  },

  toolArgs: {
    expects: 'map tool names to argument objects',
    valid: isArgsMap,
    check(spec, out) {
      const bad = Object.entries(spec).filter(
        ([name, expected]) => !out.toolCalls.some((c) => c.name === name && argsMatch(c.args, expected)),
      );
      return {
        pass: bad.length === 0,
        detail: bad.length
          ? bad.map(([name, exp]) => `no ${name} call with ${JSON.stringify(exp)}`).join('; ')
          : 'tool arguments match',
      };
    },
  },

  includesAny: {
    expects: 'be a non-empty array of non-empty strings',
    valid: isStringList,
    check(phrases, out) {
      const text = lower(out.reply);
      const pass = phrases.some((p) => text.includes(lower(p)));
      return {
        pass,
        detail: pass ? 'reply contains an expected phrase' : `reply contains none of: ${quote(phrases)}`,
      };
    },
  },

  excludes: {
    expects: 'be a non-empty array of non-empty strings',
    valid: isStringList,
    check(phrases, out) {
      const text = lower(out.reply);
      const hit = phrases.filter((p) => text.includes(lower(p)));
      return {
        pass: hit.length === 0,
        detail: hit.length ? `reply contains forbidden text: ${quote(hit)}` : 'no forbidden text in reply',
      };
    },
  },
};

/** Every key a scenario's `expect` block may use. Unknown keys fail validation. */
export const EXPECTATION_KEYS = Object.freeze(Object.keys(RULES));

/**
 * Check that `value` has the shape rule `key` accepts.
 * @param {string} key
 * @param {unknown} value
 * @returns {string | null} what is wrong, or null when the value is valid
 */
export function validateExpectation(key, value) {
  if (!Object.hasOwn(RULES, key)) return `unknown expectation "${key}"`;
  const rule = RULES[key];
  return rule.valid(value) ? null : `"${key}" must ${rule.expects}`;
}

/** The tool the `handoff` rule looks for when the caller does not name one. */
export const HANDOFF_TOOL = 'handoff_to_human';

/**
 * Run every rule declared in `expect` against one agent output.
 * @param {Record<string, unknown>} expect
 * @param {AgentOutput} output
 * @param {{ handoffTool?: string }} [opts]
 * @returns {CheckResult[]}
 */
export function checkExpectations(expect, output, { handoffTool = HANDOFF_TOOL } = {}) {
  const called = output.toolCalls.map((c) => c.name);
  return Object.entries(expect).map(([key, value]) => {
    if (!Object.hasOwn(RULES, key)) return { rule: key, pass: false, detail: `unknown expectation "${key}"` };
    return { rule: key, ...RULES[key].check(value, output, called, { handoffTool }) };
  });
}
