/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';
import { FatalSandboxError } from '../utils/errors.js';
import type { SandboxDriver, SandboxDriverContext } from './sandboxDriver.js';
import type { SandboxConfig } from '../config/config.js';

/** Possible states of the lifecycle manager. */
export type SandboxState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'completed'
  | 'error';

/**
 * Manages the lifecycle of a sandbox driver execution.
 *
 * Lifecycle: idle → initializing → ready → running → completed
 *                                                  ↘ error
 *
 * This provides a structured layer over raw driver.execute() calls,
 * adding state tracking, validation sequencing, and error categorization.
 */
export class SandboxLifecycleManager {
  private _state: SandboxState = 'idle';
  private readonly driver: SandboxDriver;

  constructor(driver: SandboxDriver) {
    this.driver = driver;
  }

  /** Current lifecycle state. */
  get state(): SandboxState {
    return this._state;
  }

  /** The driver being managed. */
  get driverName(): string {
    return this.driver.name;
  }

  /**
   * Initialize: verify the driver is available and validate config.
   * Transitions: idle → initializing → ready (or error).
   */
  async initialize(config: SandboxConfig): Promise<void> {
    if (this._state !== 'idle') {
      throw new FatalSandboxError(
        `Cannot initialize: lifecycle manager is in '${this._state}' state`,
      );
    }

    this._state = 'initializing';
    debugLogger.log(`Initializing sandbox driver: ${this.driver.name}`);

    try {
      // Verify driver availability
      const available = await this.driver.detect();
      if (!available) {
        throw new FatalSandboxError(
          `Sandbox driver '${this.driver.name}' detected but not available. ` +
            `${this.driver.description}`,
        );
      }

      // Validate configuration
      await this.driver.validate(config);
      this._state = 'ready';
      debugLogger.log(`Sandbox driver '${this.driver.name}' ready`);
    } catch (e) {
      this._state = 'error';
      throw e;
    }
  }

  /**
   * Execute the sandbox. Returns the process exit code.
   * Transitions: ready → running → completed (or error).
   */
  async execute(context: SandboxDriverContext): Promise<number> {
    if (this._state !== 'ready') {
      throw new FatalSandboxError(
        `Cannot execute: lifecycle manager is in '${this._state}' state. ` +
          `Call initialize() first.`,
      );
    }

    this._state = 'running';
    debugLogger.log(`Executing sandbox driver: ${this.driver.name}`);

    try {
      const exitCode = await this.driver.execute(context);
      this._state = 'completed';
      debugLogger.log(
        `Sandbox driver '${this.driver.name}' completed with exit code: ${exitCode}`,
      );
      return exitCode;
    } catch (e) {
      this._state = 'error';
      throw e;
    }
  }
}
