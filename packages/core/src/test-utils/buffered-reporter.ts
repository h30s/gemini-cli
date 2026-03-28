/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Reporter, File, Task, UserConsoleLog } from 'vitest';

/**
 * BufferedTestReporter — GSoC 2026 POC
 *
 * Intercepts Vitest's IPC-delivered console output (onUserConsoleLog),
 * buffers it per-test in memory, discards on pass, and flushes on fail.
 *
 * onFinished enforces the CI noise gate: if any passing file exceeds
 * 1 line of output, the suite exits with a diagnostic report.
 *
 * Architecture note: Vitest runs tests in isolated worker threads; a
 * reporter runs in the main Node process. Overriding process.stdout.write
 * in the reporter only catches main-thread output — it completely misses
 * the noise from test workers, which is where virtually all the noise
 * originates. onUserConsoleLog is the correct IPC hook: Vitest serializes
 * worker console output via IPC and delivers it to the main process with
 * each payload tagged by taskId for per-test buffer isolation.
 *
 * Design note: lineCounts is a SEPARATE map from buffers.
 * onTestFinished deletes the buffer (to free memory) but persists the
 * line count so that onFinished's CI gate can still read it.
 * Without this separation the gate checks empty maps and never fires.
 *
 * Worker Thread Model:
 *   Worker A: console.log("x") → IPC {taskId:"abc", content:"x"} ↘
 *   Worker B: console.log("y") → IPC {taskId:"def", content:"y"} → Main: Reporter
 *                                                                    onUserConsoleLog → buffers["abc"].push("x")
 *                                                                    onUserConsoleLog → buffers["def"].push("y")
 */
/** Set GEMINI_BUFFERED_REPORTER=0 to disable this reporter entirely (no-op mode).
 * All other layers (global mocking, debugLogger guard, CI gate) remain operational.
 * Use this escape hatch if reporter instability is observed on a specific environment. */
const REPORTER_ENABLED = process.env['GEMINI_BUFFERED_REPORTER'] !== '0';

export class BufferedTestReporter implements Reporter {
  // Keyed by taskId — one buffer per test, naturally isolated across parallel workers
  private buffers = new Map<string, string[]>();

  // Separate from buffers: persisted after buffer deletion so onFinished can read them.
  // Maps taskId → total line count emitted by that test.
  private lineCounts = new Map<string, number>();

  // Per-test byte totals — avoids O(n²) buf.join('').length on every log event.
  private bufferBytes = new Map<string, number>();

  onUserConsoleLog(log: UserConsoleLog) {
    if (!REPORTER_ENABLED) return;
    // No taskId = runner-level log (suite setup/teardown). Let through unchanged.
    // Phase 2 will intercept these via a separate suite-level buffer.
    if (!log.taskId) return;

    if (!this.buffers.has(log.taskId)) {
      this.buffers.set(log.taskId, []);
      this.bufferBytes.set(log.taskId, 0);
    }
    const buf = this.buffers.get(log.taskId)!;
    const currentBytes = this.bufferBytes.get(log.taskId)!;

    // Hard cap: 1 MB per test — O(1) check via separate byte counter.
    // Prevents OOM if a test enters an infinite console.log loop.
    // When exceeded: append a visible warning — the cap is never silent.
    if (currentBytes < 1_048_576) {
      buf.push(log.content);
      this.bufferBytes.set(log.taskId, currentBytes + log.content.length);
    } else if (!buf.at(-1)?.includes('[TRUNCATED]')) {
      buf.push('\n⚠️  [TRUNCATED] buffer exceeded 1 MB — remaining output suppressed\n');
    }
  }

  onTestFinished(test: Task) {
    const buf = this.buffers.get(test.id) ?? [];

    // Persist line count BEFORE deleting the buffer.
    // onFinished's CI gate reads lineCounts — not buffers — so this must happen first.
    const lines = buf
      .join('\n')
      .split('\n')
      .filter(Boolean).length;
    this.lineCounts.set(test.id, lines);

    if (test.result?.state === 'fail') {
      if (buf.length > 0) {
        // Flush buffer on failure — wrapped in clear delimiters so context is findable
        process.stdout.write(`\n--- Buffered logs for: ${test.name} ---\n`);
        process.stdout.write(buf.join('\n'));
        process.stdout.write(`\n--- End buffered logs ---\n`);
      }
    }
    // Free memory — buffer no longer needed; lineCounts is retained for onFinished.
    this.buffers.delete(test.id);
    this.bufferBytes.delete(test.id);
  }

  onFinished(files: File[]) {
    if (!REPORTER_ENABLED) return;
    // CI noise gate: fail the suite if any passing file emits more than 1 line.
    // Reads from lineCounts (not buffers) — buffers are already freed at this point.
    // This is what makes the improvement permanent — without enforcement, fixes erode.
    const noisy = files.filter(
      (f) => !f.result?.errors?.length && this.fileLineCount(f) > 1,
    );

    if (noisy.length > 0) {
      process.stderr.write(
        '\n❌  CI Noise Guard — passing files exceeding 1-line budget:\n',
      );
      noisy.forEach((f) =>
        process.stderr.write(
          `  ${f.name}  (${this.fileLineCount(f)} lines emitted)\n`,
        ),
      );
      process.stderr.write(
        '\nFix: ensure all console output in passing tests is gated behind a test-env check\n' +
          'or wrapped with mockDebugLogger(). See CONTRIBUTING.md for the testing standard.\n',
      );
      process.exit(1);
    }
  }

  // Count persisted line totals for a file across all its tasks.
  // Uses lineCounts (not buffers) so it works correctly after onTestFinished cleanup.
  private fileLineCount(file: File): number {
    return (file.tasks ?? []).reduce(
      (sum, t) => sum + (this.lineCounts.get(t.id) ?? 0),
      0,
    );
  }
}
