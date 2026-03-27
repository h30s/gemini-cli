#!/usr/bin/env node
/**
 * validate-taxonomy.mjs
 * Usage: node evals/scripts/validate-taxonomy.mjs
 *
 * Validates evals/behaviors.taxonomy.json against evals/behaviors.taxonomy.schema.json
 * using AJV (draft-07). Run from the repo root.
 *
 * Requires: npm install ajv  (or rely on repo node_modules)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let Ajv;
try {
  Ajv = require('ajv');
} catch {
  console.error(
    '❌ Could not find "ajv". Run: npm install ajv  (or npm install from repo root)',
  );
  process.exit(1);
}

// Resolve paths relative to the repo root (cwd when run via npm scripts or from repo root).
const repoRoot   = process.cwd();
const schemaPath = resolve(repoRoot, 'evals/behaviors.taxonomy.schema.json');
const dataPath   = resolve(repoRoot, 'evals/behaviors.taxonomy.json');

let schema, data;
try {
  schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
} catch (e) {
  console.error(`❌ Could not read schema: ${schemaPath}\n   ${e.message}`);
  process.exit(1);
}
try {
  data = JSON.parse(readFileSync(dataPath, 'utf8'));
} catch (e) {
  console.error(`❌ Could not read taxonomy: ${dataPath}\n   ${e.message}`);
  process.exit(1);
}

const ajv   = new Ajv({ allErrors: true });
const valid = ajv.compile(schema)(data);

if (!valid) {
  console.error('❌ Taxonomy validation failed:');
  ajv.errors.forEach((e) =>
    console.error(`  ${e.instancePath || '(root)'} ${e.message}`),
  );
  process.exit(1);
}

const totalBehaviors = Object.values(data.categories).flatMap((c) =>
  Object.values(c.behaviors),
).length;

const categoryCount = Object.keys(data.categories).length;

console.log(
  `✅ Taxonomy valid: ${categoryCount} categories, ${totalBehaviors} behaviors`,
);
console.log(`   Version: ${data.version}`);
console.log(`   Categories: ${Object.keys(data.categories).join(', ')}`);
