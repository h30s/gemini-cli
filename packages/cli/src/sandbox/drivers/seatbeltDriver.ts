/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { quote } from 'shell-quote';
import type {
  SandboxDriver,
  SandboxDriverCapabilities,
  SandboxDriverContext,

  FatalSandboxError,
  debugLogger,
  GEMINI_DIR,
  homedir,
  type SandboxConfig} from '@google/gemini-cli-core';
import { BUILTIN_SEATBELT_PROFILES } from '../../utils/sandboxUtils.js';

const execAsync = promisify(exec);

const MAX_INCLUDE_DIRS = 5;
const PROXY_STARTUP_TIMEOUT_MS = 10_000;
const PROXY_RETRY_INTERVAL_MS = 250;

/**
 * macOS Seatbelt sandbox driver.
 *
 * Uses sandbox-exec with .sb profile files to restrict file system
 * and network access. This is the reference implementation for the
 * SandboxDriver interface.
 *
 * Extracted from packages/cli/src/utils/sandbox.ts lines 59-228.
 *
 * Improvements over the original:
 * 1. Proxy startup has a configurable timeout (original used unbounded loop)
 * 2. Warns when allowedPaths > 5 (original silently truncated)
 * 3. Proxy cleanup uses try/finally (original accumulated signal handlers)
 */
export class SeatbeltDriver implements SandboxDriver {
  readonly name = 'seatbelt';
  readonly description =
    'macOS Seatbelt (sandbox-exec) — lightweight, built-in sandboxing';

  readonly capabilities: SandboxDriverCapabilities = {
    supportsNetworkIsolation: true,
    supportsFileSystemRestrictions: true,
    supportsImageBuilding: false,
    requiresPreExistingContainer: false,
    supportedPlatforms: ['darwin'],
    maxAllowedPaths: MAX_INCLUDE_DIRS,
  };

  async detect(): Promise<boolean> {
    if (os.platform() !== 'darwin') return false;
    try {
      const { default: commandExists } = await import('command-exists');
      return commandExists.sync('sandbox-exec');
    } catch {
      return false;
    }
  }

  async validate(config: SandboxConfig): Promise<void> {
    // Extracted from sandbox.ts:60-65
    if (process.env['BUILD_SANDBOX']) {
      throw new FatalSandboxError(
        'Cannot BUILD_SANDBOX when using macOS Seatbelt',
      );
    }

    const profile = process.env['SEATBELT_PROFILE'] ?? 'permissive-open';
    const profileFile = this.resolveProfilePath(profile);

    if (!fs.existsSync(profileFile)) {
      throw new FatalSandboxError(
        `Missing macos seatbelt profile file '${profileFile}'`,
      );
    }

    // IMPROVEMENT: Warn when allowedPaths exceeds the limit
    // (Original code at sandbox.ts:100 silently truncated)
    const pathCount = config.allowedPaths?.length ?? 0;
    if (pathCount > MAX_INCLUDE_DIRS) {
      debugLogger.warn(
        `Seatbelt supports max ${MAX_INCLUDE_DIRS} included directories. ` +
          `${pathCount} configured — last ${pathCount - MAX_INCLUDE_DIRS} will be ignored.`,
      );
    }
  }

  async execute(context: SandboxDriverContext): Promise<number> {
    const profile = (process.env['SEATBELT_PROFILE'] ??= 'permissive-open');
    const profileFile = this.resolveProfilePath(profile);

    debugLogger.log(`using macos seatbelt (profile: ${profile}) ...`);

    // Build sandbox-exec arguments (extracted from sandbox.ts:82-155)
    const args = await this.buildSandboxArgs(context, profileFile);

    // Handle proxy (extracted from sandbox.ts:157-215)
    const proxyCommand = process.env['GEMINI_SANDBOX_PROXY_COMMAND'];
    let proxyProcess: ChildProcess | undefined;

    try {
      if (proxyCommand) {
        proxyProcess = await this.startProxy(proxyCommand);
      }

      // Spawn sandbox-exec (extracted from sandbox.ts:217-227)
      process.stdin.pause();
      const sandboxProcess = spawn('sandbox-exec', args, {
        stdio: 'inherit',
      });

      return await new Promise<number>((resolve, reject) => {
        sandboxProcess.on('error', reject);
        sandboxProcess.on('close', (code) => {
          process.stdin.resume();
          resolve(code ?? 1);
        });
      });
    } finally {
      // IMPROVEMENT: Cleanup in finally, not global signal handlers
      // Original (sandbox.ts:183-194) used process.on('exit'/'SIGINT'/'SIGTERM')
      // which accumulated listeners on repeated invocations
      if (proxyProcess?.pid) {
        try {
          process.kill(-proxyProcess.pid, 'SIGTERM');
        } catch {
          // Best-effort proxy cleanup
        }
      }
    }
  }

  // --- Private Methods ---

  private resolveProfilePath(profile: string): string {
    // Extracted from sandbox.ts:67-79
    if (BUILTIN_SEATBELT_PROFILES.includes(profile)) {
      const bundledPath = fileURLToPath(
        new URL(`../../utils/sandbox-macos-${profile}.sb`, import.meta.url),
      );
      if (fs.existsSync(bundledPath)) return bundledPath;
    }
    // Custom profile from project settings directory
    return path.join(GEMINI_DIR, `sandbox-macos-${profile}.sb`);
  }

  private async buildSandboxArgs(
    context: SandboxDriverContext,
    profileFile: string,
  ): Promise<string[]> {
    // Extracted from sandbox.ts:82-155
    const args: string[] = [];
    // Use cliConfig.getTargetDir() for the target directory, matching the
    // original sandbox.ts:101 behavior. This is the project root from config,
    // which may differ from process.cwd() (context.workdir).
    const targetDir = fs.realpathSync(
      context.cliConfig?.getTargetDir() || context.workdir,
    );

    // Directory mappings (sandbox.ts:87-96)
    args.push('-D', `TARGET_DIR=${targetDir}`);
    args.push('-D', `TMP_DIR=${fs.realpathSync(os.tmpdir())}`);
    args.push('-D', `HOME_DIR=${fs.realpathSync(homedir())}`);

    // macOS cache dir (sandbox.ts:95)
    try {
      const cacheDir = (
        await execAsync('getconf DARWIN_USER_CACHE_DIR')
      ).stdout.trim();
      args.push('-D', `CACHE_DIR=${fs.realpathSync(cacheDir)}`);
    } catch {
      args.push('-D', `CACHE_DIR=${os.tmpdir()}`);
    }

    // Include directories (sandbox.ts:98-141)
    const includedDirs = this.collectIncludedDirs(context, targetDir);
    for (let i = 0; i < MAX_INCLUDE_DIRS; i++) {
      const dirPath = i < includedDirs.length ? includedDirs[i] : '/dev/null';
      args.push('-D', `INCLUDE_DIR_${i}=${dirPath}`);
    }

    // Node options (sandbox.ts:82-85)
    const nodeOptions = [
      ...(process.env['DEBUG'] ? ['--inspect-brk'] : []),
      ...context.nodeArgs,
    ].join(' ');

    // Profile + command (sandbox.ts:145-155)
    const finalArgv = context.cliArgs;
    args.push(
      '-f',
      profileFile,
      'sh',
      '-c',
      [
        `SANDBOX=sandbox-exec`,
        `NODE_OPTIONS="${nodeOptions}"`,
        ...finalArgv.map((arg) => quote([arg])),
      ].join(' '),
    );

    return args;
  }

  private collectIncludedDirs(
    context: SandboxDriverContext,
    targetDir: string,
  ): string[] {
    // Extracted from sandbox.ts:98-131
    const dirs: string[] = [];

    // Workspace context directories (sandbox.ts:104-115)
    if (context.cliConfig) {
      const workspaceContext = context.cliConfig.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();

      for (const dir of directories) {
        try {
          const realDir = fs.realpathSync(dir);
          if (realDir !== targetDir && !dirs.includes(realDir)) {
            dirs.push(realDir);
          }
        } catch {
          /* skip non-existent */
        }
      }
    }

    // Custom allowed paths (sandbox.ts:118-131)
    if (context.config.allowedPaths) {
      for (const hostPath of context.config.allowedPaths) {
        if (hostPath && path.isAbsolute(hostPath) && fs.existsSync(hostPath)) {
          try {
            const realDir = fs.realpathSync(hostPath);
            if (!dirs.includes(realDir) && realDir !== targetDir) {
              dirs.push(realDir);
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    return dirs;
  }

  private async startProxy(proxyCommand: string): Promise<ChildProcess> {
    // Extracted from sandbox.ts:157-215 with timeout improvement
    const proxy =
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'] ||
      'http://localhost:8877';

    const sandboxEnv = { ...process.env };
    sandboxEnv['HTTPS_PROXY'] = proxy;
    sandboxEnv['https_proxy'] = proxy;
    sandboxEnv['HTTP_PROXY'] = proxy;
    sandboxEnv['http_proxy'] = proxy;

    const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'];
    if (noProxy) {
      sandboxEnv['NO_PROXY'] = noProxy;
      sandboxEnv['no_proxy'] = noProxy;
    }

    const proxyProcess = spawn(proxyCommand, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: true,
    });

    proxyProcess.stderr?.on('data', (data: Buffer) => {
      debugLogger.debug(`[PROXY STDERR]: ${data.toString().trim()}`);
    });

    // IMPROVEMENT: Proxy startup with timeout
    // Original (sandbox.ts:212-214) used unbounded `until` loop:
    //   await execAsync(`until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`)
    // This hangs forever if the proxy fails to start.
    const maxRetries = Math.ceil(
      PROXY_STARTUP_TIMEOUT_MS / PROXY_RETRY_INTERVAL_MS,
    );
    let retries = 0;

    debugLogger.log('waiting for proxy to start ...');

    while (retries < maxRetries) {
      try {
        await execAsync(`timeout 0.25 curl -s http://localhost:8877`);
        debugLogger.log('proxy started successfully');
        return proxyProcess;
      } catch {
        retries++;
        if (retries >= maxRetries) {
          // Kill the proxy process before throwing
          if (proxyProcess.pid) {
            try {
              process.kill(-proxyProcess.pid, 'SIGTERM');
            } catch {
              // best-effort
            }
          }
          throw new FatalSandboxError(
            `Proxy command '${proxyCommand}' did not start within ` +
              `${PROXY_STARTUP_TIMEOUT_MS / 1000} seconds. ` +
              `Verify the command works: ${proxyCommand}`,
          );
        }
        await new Promise((r) => setTimeout(r, PROXY_RETRY_INTERVAL_MS));
      }
    }

    return proxyProcess;
  }
}
