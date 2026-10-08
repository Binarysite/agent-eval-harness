/**
 * A deterministic stand-in for the LLM judge, so the whole pipeline runs
 * offline, in CI and in tests with no API key.
 *
 * It does NOT read the rubric. It applies a few generic heuristics that any
 * support reply should satisfy, and says so in its reason. Treat a pass from
 * this judge as "nothing obviously wrong", never as "meets the rubric".
 * Every verdict carries `graded: false`, so the gate knows the rubric was not read.
 */

const DEFAULT_BANNED = ['guarantee', 'i promise', '100%', 'as an ai language model'];

/**
 * @param {{ maxChars?: number, banned?: string[] }} [opts]
 * @returns {import('../runner.js').Judge}
 */
export function createMockJudge({ maxChars = 600, banned = DEFAULT_BANNED } = {}) {
  return async function mockJudge({ output }) {
    const reply = output.reply.trim();
    const verdict = (pass, reason) => ({ pass, reason, graded: false });
    if (!reply) return verdict(false, 'empty reply');
    if (reply.length > maxChars) return verdict(false, `reply is ${reply.length} chars, limit ${maxChars}`);
    const text = reply.toLowerCase();
    const hit = banned.find((p) => text.includes(p));
    if (hit) return verdict(false, `reply contains "${hit}"`);
    return verdict(true, 'mock heuristics passed (rubric not graded)');
  };
}
