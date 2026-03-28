/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { BufferedTestReporter } from './src/test-utils/buffered-reporter';

export default defineConfig({
  test: {
    // Keep default reporter for CI structure (pass/fail counters, timing).
    // Add BufferedTestReporter as a second reporter — reporters compose cleanly in Vitest.
    // GSoC 2026 POC: buffers per-test output, discards on pass, flushes on fail.
    reporters: ['default', 'junit', new BufferedTestReporter()],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    silent: true,
    setupFiles: ['./test-setup.ts'],
    outputFile: {
      junit: 'junit.xml',
    },
    // CRITICAL: Suppress the default reporter's native console printing.
    // Without this, logs appear twice — once from the default reporter and
    // once from our controlled flush on failure via BufferedTestReporter.
    // onConsoleLog operates at the config level (controls default reporter print).
    // onUserConsoleLog operates at the reporter level (receives the IPC payload).
    // Both are needed: one to suppress, one to capture.
    onConsoleLog(_log: string, _type: 'stdout' | 'stderr'): false | void {
      // React act() warnings must always reach the developer — never suppress them.
      // All other per-test console output is handled by BufferedTestReporter via IPC.
      if (_log.includes('not wrapped in act')) return;
      if (_log.includes('ReactDOM.render is no longer supported')) return;
      if (_log.includes('UnhandledPromiseRejectionWarning')) return;
      return false; // suppress — BufferedTestReporter routes it correctly
    },
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
  },
});
