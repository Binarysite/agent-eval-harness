import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { scenarioBankSchema } from '../src/schema.js';
import { EXPECTATION_KEYS } from '../src/expectations.js';
import { loadScenarios, validateScenarios } from '../src/scenarios.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_FILE = join(root, 'schema/scenarios.schema.json');
const BANKS = ['examples/sticker-shop/scenarios.json', 'examples/starter/scenarios.json'];
// A fresh Ajv per schema: Ajv keeps compiled schemas by $id.
const compile = (schema) => {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  return Object.assign(validate, { text: () => ajv.errorsText(validate.errors) });
};

test('schema/scenarios.schema.json is what the code generates (npm run schema)', async () => {
  const onDisk = await readFile(SCHEMA_FILE, 'utf8');
  assert.equal(onDisk, `${JSON.stringify(scenarioBankSchema(), null, 2)}\n`);
});

test('the schema lists exactly the rules and fields the validator accepts', () => {
  const schema = scenarioBankSchema();
  assert.deepEqual(Object.keys(schema.$defs.expect.properties), [...EXPECTATION_KEYS]);
  assert.deepEqual(
    Object.keys(schema.$defs.scenario.properties),
    ['id', 'category', 'message', 'critical', 'context', 'expect', 'rubric'],
  );
});

test('every example bank validates against the schema and names it in $schema', async () => {
  const validate = compile(JSON.parse(await readFile(SCHEMA_FILE, 'utf8')));
  for (const file of BANKS) {
    const bank = JSON.parse(await readFile(join(root, file), 'utf8'));
    assert.ok(validate(bank), `${file}: ${validate.text()}`);
    assert.match(bank.$schema, /scenarios\.schema\.json$/, file);
  }
});

test('the schema rejects the banks the validator rejects', () => {
  const validate = compile(scenarioBankSchema());
  const base = { id: 'a', category: 'x', message: 'hi', expect: { anyTool: false } };
  const bad = [
    [{ ...base, critcal: true }],
    [{ ...base, expect: { exclude: ['x'] } }],
    [{ ...base, expect: { excludes: [] } }],
    [{ ...base, expect: { excludes: [' '] } }],
    [{ ...base, expect: { toolArgs: {} } }],
    [{ ...base, expect: { toolArgs: { t: {} } } }],
    [{ ...base, expect: { handoff: 'yes' } }],
    [{ ...base, id: '' }],
    [{ ...base, critical: 'true' }],
    [{ id: 'a', category: 'x', message: 'hi' }],
    [{ id: 'a', category: 'x', message: 'hi', expect: {} }],
    [{ id: 'a', category: 'x', message: 'hi', critical: true, rubric: 'r' }],
    [{ ...base, rubric: '' }],
    [{ ...base, context: [] }],
    { scenarios: [base], extra: 1 },
    'not a bank',
  ];
  for (const bank of bad) {
    assert.throws(() => validateScenarios(bank), undefined, `validator: ${JSON.stringify(bank)}`);
    assert.equal(validate(bank), false, `schema: ${JSON.stringify(bank)}`);
  }
  assert.ok(validate([base]));
  assert.ok(validate({ $schema: 'x', scenarios: [base] }));
});

test('a bank can be an object with $schema and scenarios; other keys are an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'bank.json');
  const scenario = { id: 'a', category: 'x', message: 'hi', expect: { anyTool: false } };
  await writeFile(file, JSON.stringify({ $schema: './s.json', scenarios: [scenario] }));
  assert.deepEqual(await loadScenarios(file), [scenario]);
  await writeFile(file, JSON.stringify({ scenarios: [scenario], scenario: [] }));
  await assert.rejects(loadScenarios(file), /unknown key "scenario"/);
  await writeFile(file, JSON.stringify({ $schema: './s.json' }));
  await assert.rejects(loadScenarios(file), /an object with a "scenarios" array/);
});
