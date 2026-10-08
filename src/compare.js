import { pct } from './report.js';
import { PROVENANCE_KEYS } from './provenance.js';

/**
 * Compare two JSON reports case by case. A raw diff of the files is noisy
 * (timestamps, durations); what matters is which cases changed status.
 *
 * @typedef {{ id: string, status: string, critical: boolean }} ReportCase
 * @typedef {{ summary: { passRate: number }, results: ReportCase[] }} Report
 */

function assertReport(report, label) {
  if (!Array.isArray(report?.results) || typeof report?.summary?.passRate !== 'number') {
    throw new Error(`${label} is not an agent-eval report`);
  }
}

/**
 * @param {Report} before
 * @param {Report} after
 * @param {{ beforeLabel?: string, afterLabel?: string }} [labels] names used in errors, usually file paths
 */
export function compareReports(before, after, { beforeLabel = 'before', afterLabel = 'after' } = {}) {
  assertReport(before, beforeLabel);
  assertReport(after, afterLabel);
  const byId = (report) => new Map(report.results.map((r) => [r.id, r]));
  const beforeById = byId(before);
  const afterById = byId(after);
  const changes = [];
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const from = beforeById.get(id)?.status ?? 'missing';
    const to = afterById.get(id)?.status ?? 'missing';
    const critical = Boolean((afterById.get(id) ?? beforeById.get(id)).critical);
    if (from !== to) changes.push({ id, critical, from, to });
  }
  // A status change between two different setups may come from the setup, not the agent.
  const meta = (report, key) => report.meta?.[key] ?? null;
  const warnings = PROVENANCE_KEYS.filter((key) => meta(before, key) !== meta(after, key))
    .map((key) => `${key} differs between the runs: ${meta(before, key)} -> ${meta(after, key)}`);
  return {
    changes,
    regressions: changes.filter((change) => change.from === 'pass'),
    passRate: { before: before.summary.passRate, after: after.summary.passRate },
    warnings,
  };
}

/** Human-readable comparison, one line per changed case. */
export function formatComparison(comparison) {
  const lines = comparison.changes.map((change) => {
    const tag = change.critical ? '  [critical]' : '';
    return `${change.from.padEnd(7)} -> ${change.to.padEnd(7)} ${change.id}${tag}`;
  });
  if (!lines.length) lines.push('No case changed status.');
  const { before, after } = comparison.passRate;
  lines.push('', `Pass rate ${pct(before)} -> ${pct(after)}  regressions ${comparison.regressions.length}`);
  for (const w of comparison.warnings ?? []) lines.push(`WARNING: ${w}`);
  return lines.join('\n');
}
