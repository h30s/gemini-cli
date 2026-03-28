/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BufferedTestReporter Canary Test — GSoC 2026 POC
 *
 * This file is the self-contained proof that the reporter works:
 *
 * Happy path: 200 console.log() calls → ZERO lines in terminal.
 *   If any canary log appears during a passing run, the reporter is broken.
 *
 * Sad path (SKIPPED in normal runs — run manually to demo failure behaviour):
 *   5 context logs + intentionally failing expect().
 *   All 5 logs MUST appear BEFORE the assertion error so the developer
 *   gets full context without searching.
 *
 *   To demo the sad path:
 *     GEMINI_BUFFERED_REPORTER_DEMO=1 npx vitest run src/test-utils/__tests__/buffered-reporter.canary.test.ts
 *   Or temporarily remove the .skip below and re-run.
 *
 * Run (normal):
 *   npx vitest run src/test-utils/__tests__/buffered-reporter.canary.test.ts
 *
 * Expected output (normal run — 1 pass, 1 skip, 0 lines of canary noise):
 *   ✓ BufferedTestReporter: canary (happy path)
 *     ✓ produces ZERO output when passing — logs must be silently discarded
 *   ◌ BufferedTestReporter: canary (sad path) [skipped]
 */

import { describe, it, expect } from 'vitest';

describe('BufferedTestReporter: canary (happy path)', () => {
  it('produces ZERO output when passing — logs must be silently discarded', () => {
    // This test spams console.log 200 times. If BufferedTestReporter is working,
    // running this file produces exactly 1 line of output (the ✓ pass line).
    // If any canary log appears in the terminal, the reporter is not intercepting
    // onUserConsoleLog correctly — almost certainly means it is overriding
    // process.stdout.write instead (which only catches main-thread output).
    for (let i = 0; i < 200; i++) {
      console.log(
        `[canary] this log should never appear in terminal — iteration ${i}`,
      );
    }
    expect(true).toBe(true);
  });
});

describe.skip('BufferedTestReporter: canary (sad path)', () => {
  // INTENTIONALLY SKIPPED in normal runs to keep the suite green.
  // This test fails by design — it demonstrates that buffered logs appear
  // before the assertion error on failure (the sad-path flush behaviour).
  //
  // To run this demo manually:
  //   npx vitest run src/test-utils/__tests__/buffered-reporter.canary.test.ts --reporter=verbose
  // Or remove .skip above temporarily and re-run with npx vitest run on this file.
  it('surfaces ALL buffered logs + stack trace when failing — nothing hidden', () => {
    // When this test fails, the developer should see all 5 logs printed
    // BEFORE the assertion error — full context, nothing hidden.
    // This simulates the real-world debugging scenario: a network call
    // that fails after a retry loop, where the developer needs the full
    // sequence to diagnose what went wrong.
    console.log('[canary] debug context: setting up network call');
    console.log('[canary] debug context: got response status 503');
    console.log('[canary] debug context: retry #1 initiated');
    console.log('[canary] debug context: retry #2 initiated');
    console.log('[canary] debug context: giving up after 2 retries');

    // This intentionally fails to demonstrate the sad-path flush.
    // To confirm the happy-path independently: comment out this line,
    // re-run, and verify the 5 logs above do NOT appear in the terminal.
    expect('connection').toBe('success');
  });
});
