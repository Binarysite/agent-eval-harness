import { pct } from './util.js';
import { PROVENANCE_KEYS } from './provenance.js';

/**
 * Compare two JSON reports case by case. A raw diff of the files is noisy
 * (timestamps, durations); what matters is which cases changed status.
 * A regression is a case that passed before and does not pass now, including
 * one that is missing from the second report. A new case that fails is not a
 * regression here: the gate of the run that produced it is what catches it.
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
  const differs = PROVENANCE_KEYS.filter((key) => meta(before, key) !== meta(after, key));
  const warnings = differs.filter((key) => key !== 'gitSha')
    .map((key) => `${key} differs between the runs: ${meta(before, key)} -> ${meta(after, key)}`);
  const short = (sha) => (sha ? String(sha).slice(0, 12) : 'none');
  const notes = differs.includes('gitSha')
    ? [`commits: ${short(meta(before, 'gitSha'))} -> ${short(meta(after, 'gitSha'))}`]
    : [];
  // A different selection turns every case left out into "pass -> missing".
  const setup = {
    filters: (report) => JSON.stringify(report.meta?.filters ?? null),
    trials: (report) => report.meta?.options?.trials ?? null,
  };
  for (const [name, read] of Object.entries(setup)) {
    if (read(before) !== read(after)) {
      warnings.push(`${name} differ between the runs: ${read(before)} -> ${read(after)}`);
    }
  }
  return {
    changes,
    regressions: changes.filter((change) => change.from === 'pass'),
    passRate: { before: before.summary.passRate, after: after.summary.passRate },
    notes,
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
  lines.push(...(comparison.notes ?? []));
  for (const w of comparison.warnings ?? []) lines.push(`WARNING: ${w}`);
  return lines.join('\n');
}
