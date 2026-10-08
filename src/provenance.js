import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * What makes two reports comparable: the same judge and agent models, the same
 * scenario bank and the same code. `compare` warns when any of these differ.
 */
export const PROVENANCE_KEYS = Object.freeze(['judgeModel', 'agentModel', 'scenariosSha256', 'gitSha']);

/** The commit checked out in `cwd`, or null without git or outside a repository. */
export function gitSha(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** A judge or agent exposes its model as a `model` string property; null when it does not. */
const modelOf = (fn) => (typeof fn?.model === 'string' && fn.model ? fn.model : null);

/**
 * @param {{ agent?: Function, judge?: Function, scenariosFile?: string | URL, cwd?: string }} [run]
 * @returns {Promise<{ judgeModel: string | null, agentModel: string | null,
 *   scenariosSha256: string | null, gitSha: string | null }>}
 */
export async function runProvenance({ agent, judge, scenariosFile, cwd } = {}) {
  const bank = scenariosFile ? await readFile(scenariosFile) : null;
  return {
    judgeModel: modelOf(judge),
    agentModel: modelOf(agent),
    scenariosSha256: bank ? createHash('sha256').update(bank).digest('hex') : null,
    gitSha: gitSha(cwd),
  };
}
