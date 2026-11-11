// Writes schema/scenarios.schema.json from the validator's own tables.
// test/schema.test.js fails when the file on disk is not what this prints.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_PATH, scenarioBankSchema } from '../src/schema.js';

const file = join(fileURLToPath(new URL('..', import.meta.url)), SCHEMA_PATH);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(scenarioBankSchema(), null, 2)}\n`);
console.log(`wrote ${SCHEMA_PATH}`);
