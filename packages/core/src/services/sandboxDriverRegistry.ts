/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FatalSandboxError } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import type {
  SandboxDriver,
  SandboxDriverCapabilities,
} from './sandboxDriver.js';
import type { SandboxConfig } from '../config/config.js';

/** Diagnostic info for a single driver. */
export interface SandboxDriverDiagnostic {
  name: string;
  description: string;
  available: boolean;
  error?: string;
  capabilities: SandboxDriverCapabilities;
}

/** Full sandbox diagnostics report. */
export interface SandboxDiagnostics {
  platform: NodeJS.Platform;
  drivers: SandboxDriverDiagnostic[];
  recommended?: string;
}

/**
 * Registry for sandbox drivers. Follows the HookRegistry/ToolRegistry pattern.
 *
 * Drivers are registered in priority order (first registered = highest priority):
 * 1. Native platform drivers (Seatbelt on macOS)
 * 2. Container drivers (Docker, Podman, gVisor)
 * 3. User-managed drivers (LXC)
 * 4. NoOp fallback (always last)
 *
 * Selection algorithm (replaces getSandboxCommand() if/else chain):
 * 1. If config.command is explicit → resolve alias → return that driver
 * 2. If no command → auto-detect (first available in registration order)
 * 3. If nothing available → return undefined (caller decides)
 */
export class SandboxDriverRegistry {
  private readonly drivers = new Map<string, SandboxDriver>();
  private readonly order: string[] = []; // registration order = priority

  // Backward-compatibility aliases: CLI command name → driver name
  private static readonly ALIASES: Record<string, string> = {
    'sandbox-exec': 'seatbelt',
    runsc: 'gvisor',
  };

  /**
   * Register a driver. Skips drivers whose supportedPlatforms don't
   * include the current platform (dynamic discovery).
   */
  register(driver: SandboxDriver): void {
    // Dynamic platform filtering — only register if this platform is supported
    if (!driver.capabilities.supportedPlatforms.includes(process.platform)) {
      debugLogger.log(
        `Skipping sandbox driver '${driver.name}': ` +
          `not supported on ${process.platform}`,
      );
      return;
    }

    if (this.drivers.has(driver.name)) {
      throw new Error(`Sandbox driver '${driver.name}' already registered`);
    }
    this.drivers.set(driver.name, driver);
    this.order.push(driver.name);
    debugLogger.log(`Registered sandbox driver: ${driver.name}`);
  }

  /** Get a driver by name. */
  get(name: string): SandboxDriver | undefined {
    return this.drivers.get(name);
  }

  /**
   * Resolve a SandboxConfig to a specific driver.
   * Handles aliases (sandbox-exec → seatbelt, runsc → gvisor).
   */
  async resolve(config: SandboxConfig): Promise<SandboxDriver | undefined> {
    if (config.command) {
      const name =
        SandboxDriverRegistry.ALIASES[config.command] ?? config.command;
      const driver = this.drivers.get(name);
      if (!driver) {
        // Driver not registered (may be filtered by platform or unknown)
        return undefined;
      }
      const available = await driver.detect();
      if (!available) {
        throw new FatalSandboxError(
          `Sandbox driver '${driver.name}' is not available on this system. ` +
            `${driver.description}`,
        );
      }
      return driver;
    }

    // No explicit command — auto-detect best available
    return this.detectBest();
  }

  /** Find the first available driver in registration (priority) order. */
  async detectBest(): Promise<SandboxDriver | undefined> {
    for (const name of this.order) {
      const driver = this.drivers.get(name)!;
      try {
        if (await driver.detect()) {
          debugLogger.log(`Auto-detected sandbox driver: ${driver.name}`);
          return driver;
        }
      } catch (e) {
        debugLogger.warn(`Driver ${name} detection failed: ${e}`);
      }
    }
    return undefined;
  }

  /** Return only drivers that are currently available. */
  async listAvailable(): Promise<SandboxDriver[]> {
    const available: SandboxDriver[] = [];
    for (const name of this.order) {
      const driver = this.drivers.get(name)!;
      try {
        if (await driver.detect()) available.push(driver);
      } catch {
        /* skip */
      }
    }
    return available;
  }

  /** Return all registered drivers (regardless of availability). */
  listAll(): SandboxDriver[] {
    return this.order.map((n) => this.drivers.get(n)!);
  }

  /**
   * Generate diagnostic info for `gemini sandbox --info`.
   */
  async getDiagnostics(): Promise<SandboxDiagnostics> {
    const results: SandboxDriverDiagnostic[] = [];
    for (const name of this.order) {
      const driver = this.drivers.get(name)!;
      let available = false;
      let error: string | undefined;
      try {
        available = await driver.detect();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      results.push({
        name: driver.name,
        description: driver.description,
        available,
        error,
        capabilities: driver.capabilities,
      });
    }
    return {
      platform: process.platform,
      drivers: results,
      recommended: results.find((d) => d.available)?.name,
    };
  }
}
