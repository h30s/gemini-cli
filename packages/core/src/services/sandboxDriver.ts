/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SandboxConfig, Config } from '../config/config.js';

/**
 * Declares what a sandbox driver can do.
 * Used by the registry for intelligent auto-detection and diagnostics.
 */
export interface SandboxDriverCapabilities {
  /** Whether the driver can block outbound network access. */
  supportsNetworkIsolation: boolean;
  /** Whether the driver can restrict file system access to specific paths. */
  supportsFileSystemRestrictions: boolean;
  /** Whether the driver can build custom sandbox images/profiles. */
  supportsImageBuilding: boolean;
  /** Whether the driver requires a pre-existing container (e.g., LXC). */
  requiresPreExistingContainer: boolean;
  /** Platforms this driver supports. */
  supportedPlatforms: NodeJS.Platform[];
  /** Max number of extra allowed paths. Infinity for unlimited. */
  maxAllowedPaths: number;
}

/**
 * Everything a driver needs to execute a sandboxed process.
 * Replaces the 4-parameter signature of start_sandbox().
 */
export interface SandboxDriverContext {
  config: SandboxConfig;
  nodeArgs: string[];
  cliArgs: string[];
  workdir: string;
  cliConfig?: Config;
}

/**
 * Core sandbox driver interface.
 *
 * Design rationale:
 * - execute() owns the full spawn→wait→cleanup lifecycle because
 *   cleanup differs per driver (Seatbelt kills proxy process group,
 *   Docker removes network + proxy container, LXC removes devices).
 * - detect() is async because some checks need I/O (commandExists,
 *   `lxc list`, `docker info`).
 * - capabilities is static metadata (describes driver type, not runtime state).
 * - validate() throws FatalSandboxError with actionable messages.
 */
export interface SandboxDriver {
  /** Unique driver name (used as registry key). */
  readonly name: string;
  /** Human-readable description for diagnostics. */
  readonly description: string;
  /** Static capability metadata. */
  readonly capabilities: SandboxDriverCapabilities;

  /**
   * Check if this driver can run on the current system.
   * Returns true if the required binary/runtime is available.
   */
  detect(): Promise<boolean>;

  /**
   * Validate the given config for this driver. Throws FatalSandboxError
   * with an actionable message if validation fails.
   */
  validate(config: SandboxConfig): Promise<void>;

  /**
   * Execute the sandboxed process. Returns the exit code.
   * Owns the full lifecycle: setup → spawn → wait → cleanup.
   */
  execute(context: SandboxDriverContext): Promise<number>;
}
