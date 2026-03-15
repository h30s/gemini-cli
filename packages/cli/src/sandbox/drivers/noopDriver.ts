/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import type {
  SandboxDriver,
  SandboxDriverCapabilities,
  SandboxDriverContext,
 debugLogger, type SandboxConfig } from '@google/gemini-cli-core';

/**
 * No-Op sandbox driver. Always available as a fallback.
 *
 * Provides consistent logging and warnings that no isolation is active,
 * per the project requirements. Unlike other drivers, this one runs
 * the CLI process directly on the host without any sandboxing.
 */
export class NoOpDriver implements SandboxDriver {
  readonly name = 'noop';
  readonly description =
    'No sandbox — commands run directly on host (no isolation)';

  readonly capabilities: SandboxDriverCapabilities = {
    supportsNetworkIsolation: false,
    supportsFileSystemRestrictions: false,
    supportsImageBuilding: false,
    requiresPreExistingContainer: false,
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    maxAllowedPaths: Infinity,
  };

  async detect(): Promise<boolean> {
    return true; // Always available
  }

  async validate(_config: SandboxConfig): Promise<void> {
    debugLogger.warn(
      'No sandbox driver active — commands will run without isolation.',
    );
  }

  async execute(context: SandboxDriverContext): Promise<number> {
    // Run the CLI without any sandbox wrapping.
    // This provides a consistent code path for unsandboxed environments
    // with proper logging, rather than silently running without isolation.
    debugLogger.warn('Executing WITHOUT sandbox isolation.');

    const nodeOptions = [...context.nodeArgs].join(' ');
    const child = spawn(process.execPath, context.cliArgs, {
      stdio: 'inherit',
      cwd: context.workdir,
      env: {
        ...process.env,
        SANDBOX: 'noop',
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      },
    });

    return new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? 1));
    });
  }
}
