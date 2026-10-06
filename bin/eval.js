#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadScenarios,
  filterScenarios,
  runSuite,
  summarize,
  formatCase,
  formatSummary,
  buildReport,
  createMockJudge,
  createAnthropicJudge,
  createOpenAICompatibleJudge,
  compareReports,
  formatComparison,
} from '../src/index.js';

const DEFAULTS = {
  judge: 'mock',
  concurrency: '4',
  retries: '1',
  timeout: '10000',
  minPassRate: '0.9',
  handoffTool: 'handoff_to_human',
  out: 'reports/eval-report.json',
};

const HELP = `Usage: agent-eval -s <scenarios.json> -a <agent.js> [options]
       agent-eval compare <before.json> <after.json>

  -s, --scenarios <file>    scenario bank (required)
  -a, --agent <file>        module whose default export is the agent (required)
  -j, --judge <name>        mock | anthropic | openai | none (default ${DEFAULTS.judge})
  -c, --category <list>     only these categories, comma separated
      --critical            only critical cases
      --concurrency <n>     cases in flight at once (default ${DEFAULTS.concurrency})
      --retries <n>         retries on network errors, timeouts, 429 and 5xx (default ${DEFAULTS.retries})
      --timeout <ms>        per call timeout for agent and judge (default ${DEFAULTS.timeout})
      --min-pass-rate <x>   overall pass rate required, 0..1 (default ${DEFAULTS.minPassRate})
      --handoff-tool <name> tool the "handoff" rule looks for (default ${DEFAULTS.handoffTool})
  -o, --out <file>          JSON report path (default ${DEFAULTS.out})
  -v, --verbose             print every reply and tool call
  -h, --help

Exit codes: 0 gate passed, 1 gate failed, 2 usage or setup error.
compare exits 1 when a case that passed before no longer passes.`;

const JUDGES = {
  mock: () => createMockJudge(),
  anthropic: () => createAnthropicJudge(),
  openai: () => createOpenAICompatibleJudge(),
  none: () => undefined,
};

function toNumber(name, value, { min = 0, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  const kind = integer ? 'an integer' : 'a number';
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} must be ${kind} between ${min} and ${max}`);
  }
  return n;
}

async function runCompare(files) {
  if (files.length !== 2) {
    throw new Error('compare needs two report files: agent-eval compare <before.json> <after.json>');
  }
  const [before, after] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
  const result = compareReports(before, after, { beforeLabel: files[0], afterLabel: files[1] });
  console.log(formatComparison(result));
  process.exitCode = result.regressions.length ? 1 : 0;
}

async function main() {
  if (process.argv[2] === 'compare') {
    await runCompare(process.argv.slice(3));
    return;
  }
  const { values: args } = parseArgs({
    options: {
      scenarios: { type: 'string', short: 's' },
      agent: { type: 'string', short: 'a' },
      judge: { type: 'string', short: 'j', default: DEFAULTS.judge },
      category: { type: 'string', short: 'c' },
      critical: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: DEFAULTS.concurrency },
      retries: { type: 'string', default: DEFAULTS.retries },
      timeout: { type: 'string', default: DEFAULTS.timeout },
      'min-pass-rate': { type: 'string', default: DEFAULTS.minPassRate },
      'handoff-tool': { type: 'string', default: DEFAULTS.handoffTool },
      out: { type: 'string', short: 'o', default: DEFAULTS.out },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (!args.scenarios || !args.agent) {
    throw new Error('--scenarios and --agent are required (see agent-eval --help)');
  }
  if (!Object.hasOwn(JUDGES, args.judge)) {
    throw new Error(`unknown judge "${args.judge}" (use ${Object.keys(JUDGES).join(', ')})`);
  }
  const opts = {
    concurrency: toNumber('concurrency', args.concurrency, { min: 1, integer: true }),
    retries: toNumber('retries', args.retries, { integer: true }),
    timeoutMs: toNumber('timeout', args.timeout, { min: 1, max: 2_147_483_647 }),
    handoffTool: args['handoff-tool'],
  };
  const minPassRate = toNumber('min-pass-rate', args['min-pass-rate'], { max: 1 });

  const mod = await import(pathToFileURL(resolve(args.agent)).href);
  const agent = mod.default;
  if (typeof agent !== 'function') throw new Error(`${args.agent} must export the agent as default`);
  const judge = JUDGES[args.judge]();

  const categories = args.category ? args.category.split(',').map((c) => c.trim()).filter(Boolean) : [];
  const scenarios = filterScenarios(await loadScenarios(args.scenarios), { categories, criticalOnly: args.critical });

  console.log(
    `agent-eval-harness  ${scenarios.length} scenarios  agent ${args.agent}  judge ${args.judge}`
      + `  concurrency ${opts.concurrency}\n`,
  );
  const started = Date.now();
  const results = await runSuite(scenarios, { agent, judge, ...opts });
  for (const r of results) console.log(formatCase(r, { verbose: args.verbose }));

  const summary = summarize(results, { minPassRate });
  console.log(formatSummary(summary));

  const report = buildReport(results, summary, {
    agent: args.agent,
    scenarios: args.scenarios,
    judge: args.judge,
    filters: { categories, criticalOnly: args.critical },
    options: opts,
    durationMs: Date.now() - started,
  });
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${args.out}`);
  process.exitCode = summary.gate.pass ? 0 : 1;
}

main().catch((err) => {
  console.error(`agent-eval: ${err.message}`);
  process.exitCode = 2;
});
