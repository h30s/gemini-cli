/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as util from 'node:util';
import { vi } from 'vitest';

/**
 * A simple, centralized logger for developer-facing debug messages.
 *
 * WHY USE THIS?
 * - It makes the INTENT of the log clear (it's for developers, not users).
 * - It provides a single point of control for debug logging behavior.
 * - We can lint against direct `console.*` usage to enforce this pattern.
 *
 * HOW IT WORKS:
 * This is a thin wrapper around the native `console` object. The `ConsolePatcher`
 * will intercept these calls and route them to the debug drawer UI.
 *
 * GSoC 2026 — Layer 3: Test-environment noise guard.
 * When NODE_ENV=test or GEMINI_TEST_QUIET=1, all output is suppressed.
 * This eliminates the single largest noise source (200+ lines per test file)
 * without monkey-patching anything. Tests that need to assert on specific
 * log output should use the mockDebugLogger() escape hatch below.
 */

/**
 * True when running inside a test environment.
 * Set NODE_ENV=test (Vitest default) or GEMINI_TEST_QUIET=1 for surgical control.
 * GEMINI_TEST_QUIET is preferred in integration tests where NODE_ENV may differ.
 */
const IS_TEST_QUIET =
  process.env['NODE_ENV'] === 'test' ||
  process.env['GEMINI_TEST_QUIET'] === '1';

class DebugLogger {
  private logStream: fs.WriteStream | undefined;

  constructor() {
    this.logStream = process.env['GEMINI_DEBUG_LOG_FILE']
      ? fs.createWriteStream(process.env['GEMINI_DEBUG_LOG_FILE'], {
          flags: 'a',
        })
      : undefined;
    // Handle potential errors with the stream
    this.logStream?.on('error', (err) => {
      // Log to console as a fallback, but don't crash the app
      console.error('Error writing to debug log stream:', err);
    });
  }

  private writeToFile(level: string, args: unknown[]) {
    if (this.logStream) {
      const message = util.format(...args);
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [${level}] ${message}\n`;
      this.logStream.write(logEntry);
    }
  }

  log(...args: unknown[]): void {
    if (IS_TEST_QUIET) return;
    this.writeToFile('LOG', args);
    console.log(...args);
  }

  warn(...args: unknown[]): void {
    if (IS_TEST_QUIET) return;
    this.writeToFile('WARN', args);
    console.warn(...args);
  }

  error(...args: unknown[]): void {
    if (IS_TEST_QUIET) return;
    this.writeToFile('ERROR', args);
    console.error(...args);
  }

  debug(...args: unknown[]): void {
    if (IS_TEST_QUIET) return;
    this.writeToFile('DEBUG', args);
    console.debug(...args);
  }
}

export const debugLogger = new DebugLogger();

/**
 * mockDebugLogger — GSoC 2026 Layer 3 escape hatch.
 *
 * For tests that need to assert on specific log output.
 * Bypasses IS_TEST_QUIET by spying directly on the DebugLogger instance methods.
 *
 * Usage:
 *   const { assertLogged, assertNotLogged } = mockDebugLogger();
 *   debugLogger.log('something important');
 *   assertLogged(/something important/);
 */
export function mockDebugLogger() {
  const calls: string[] = [];

  const capture =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push(`[${level}] ${args.map(String).join(' ')}`);
    };

  vi.spyOn(debugLogger, 'log').mockImplementation(capture('LOG'));
  vi.spyOn(debugLogger, 'warn').mockImplementation(capture('WARN'));
  vi.spyOn(debugLogger, 'error').mockImplementation(capture('ERROR'));
  vi.spyOn(debugLogger, 'debug').mockImplementation(capture('DEBUG'));

  return {
    calls,
    assertLogged: (pattern: RegExp) =>
      expect(calls.some((c) => pattern.test(c))).toBe(true),
    assertNotLogged: (pattern: RegExp) =>
      expect(calls.some((c) => pattern.test(c))).toBe(false),
  };
}
