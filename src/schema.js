import { EXPECTATION_SCHEMAS } from './expectations.js';
import { FIELD_SCHEMAS } from './scenarios.js';

/** Where the generated schema is published; `$id` and the examples' `$schema` point here. */
export const SCHEMA_PATH = 'schema/scenarios.schema.json';

const hasRules = { required: ['expect'], properties: { expect: { type: 'object', minProperties: 1 } } };

/**
 * The JSON Schema (draft 2020-12) of a scenario bank, built from the same
 * tables the validator uses, so the two cannot drift: `npm run schema` writes
 * it and a test fails when the file is stale. One check is the validator's
 * alone: ids must be unique, which JSON Schema cannot express.
 * @returns {Record<string, any>}
 */
export function scenarioBankSchema() {
  const scenarioArray = { type: 'array', items: { $ref: '#/$defs/scenario' } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/Binarysite/agent-eval-harness/blob/main/${SCHEMA_PATH}`,
    title: 'agent-eval-harness scenario bank',
    description: 'An array of scenarios, or an object with "scenarios" and an optional "$schema". '
      + 'Scenario ids must also be unique, which the harness checks and this schema cannot.',
    anyOf: [
      scenarioArray,
      {
        type: 'object',
        properties: { $schema: { type: 'string' }, scenarios: scenarioArray },
        required: ['scenarios'],
        additionalProperties: false,
      },
    ],
    $defs: {
      scenario: {
        type: 'object',
        properties: { ...FIELD_SCHEMAS, expect: { $ref: '#/$defs/expect' } },
        required: ['id', 'category', 'message'],
        additionalProperties: false,
        // Needs "expect" rules, a "rubric", or both; a critical case needs at least one rule.
        anyOf: [{ required: ['rubric'] }, hasRules],
        if: { properties: { critical: { const: true } }, required: ['critical'] },
        then: hasRules,
      },
      expect: {
        type: 'object',
        description: FIELD_SCHEMAS.expect.description,
        properties: { ...EXPECTATION_SCHEMAS },
        additionalProperties: false,
      },
    },
  };
}
