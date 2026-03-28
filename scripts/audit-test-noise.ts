/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * audit-test-noise.ts — GSoC 2026 POC
 *
 * Measures the test suite noise baseline by running `npm run preflight`
 * with Vitest's JSON reporter for deterministic, structured output — not
 * heuristic line detection that produces inaccurate results against Vitest's
 * actual output format.
 *
 * Usage:
 *   npx tsx scripts/audit-test-noise.ts
 *
 * Output:
 *   - Ranked table of top 15 noisiest passing test files (stdout)
 *   - Full report saved to preflight_noise_report.json
 *
 * Why JSON reporter:
 *   Raw terminal output from Vitest mixes reporter formatting, timing lines,
 *   and console output in a way that makes regex-based counting inaccurate.
 *   The JSON reporter gives us a structured `console` array per file with
 *   exact message content — reliable and reproducible.
 */

import { execSync } from 'child_process';
import fs from 'fs';

const JSON_LOG = 'preflight_baseline_raw.json';
const REPORT_OUT = 'preflight_noise_report.json';

console.log('📊 Audit: measuring test suite noise baseline...');
console.log('   Running: tests (this may take a few minutes)\n');

// Run with JSON reporter for structured output; capture stderr separately.
// A non-zero exit is expected when tests fail — we still want the output file.
try {
  execSync(
    `npm run test:ci -- --reporter=json --outputFile=${JSON_LOG}`,
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch {
  // A non-zero exit is expected if any tests fail — we still want the output
  console.log(
    '   ℹ️  Some tests failed (expected) — continuing with captured output...',
  );
}

if (!fs.existsSync(JSON_LOG)) {
  console.error(`❌ No output file found at ${JSON_LOG}. Is Vitest installed?`);
  process.exit(1);
}

interface VitestJsonOutput {
  testResults: Array<{
    testFilePath: string;
    status: 'passed' | 'failed';
    testResults: Array<{
      title: string;
      status: 'passed' | 'failed';
    }>;
    console?: Array<{ message: string; type: string }>;
  }>;
}

const raw: VitestJsonOutput = JSON.parse(fs.readFileSync(JSON_LOG, 'utf-8'));

interface FileReport {
  file: string;
  status: 'passed' | 'failed';
  consoleLinesEmitted: number;
  estimatedBytes: number;
}

const report: FileReport[] = raw.testResults
  .map((r) => ({
    file: r.testFilePath.replace(process.cwd(), ''),
    status: r.status,
    consoleLinesEmitted: (r.console ?? []).length,
    estimatedBytes: (r.console ?? []).reduce(
      (s, l) => s + l.message.length,
      0,
    ),
  }))
  .sort((a, b) => b.consoleLinesEmitted - a.consoleLinesEmitted);

fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));

console.log('--- Top 15 Noisiest Test Files (passing tests only) ---\n');
report
  .filter((r) => r.status === 'passed')
  .slice(0, 15)
  .forEach((r, i) => {
    const kb = (r.estimatedBytes / 1024).toFixed(1);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.consoleLinesEmitted.toString().padStart(6)} lines | ${kb.padStart(7)} KB | ${r.file}`,
    );
  });

const passingReports = report.filter((r) => r.status === 'passed');
const totalLines = passingReports.reduce(
  (s, r) => s + r.consoleLinesEmitted,
  0,
);
const totalKB = (
  passingReports.reduce((s, r) => s + r.estimatedBytes, 0) / 1024
).toFixed(1);

console.log(
  `\n  Total noise from PASSING tests: ${totalLines} lines | ${totalKB} KB`,
);
console.log(`  Full report saved to: ${REPORT_OUT}\n`);
