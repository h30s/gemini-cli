/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SandboxDriverRegistry } from '@google/gemini-cli-core';
import { SeatbeltDriver } from './seatbeltDriver.js';
import { ContainerDriver } from './containerDriver.js';
import { NoOpDriver } from './noopDriver.js';

/**
 * Register all built-in sandbox drivers.
 *
 * Order = auto-detection priority (first match wins):
 * 1. Native platform drivers (fastest, no dependencies)
 * 2. Container drivers (require Docker/Podman)
 * 3. NoOp (always last — fallback/diagnostic)
 *
 * The registry automatically skips drivers whose supportedPlatforms
 * don't include the current platform (dynamic discovery).
 */
export function registerBuiltinDrivers(registry: SandboxDriverRegistry): void {
  // Native platform drivers
  registry.register(new SeatbeltDriver());
  // Future: registry.register(new BubblewrapDriver());   // Linux native
  // Future: registry.register(new AppContainerDriver()); // Windows native

  // Container drivers
  registry.register(new ContainerDriver('docker'));
  registry.register(new ContainerDriver('podman'));
  registry.register(new ContainerDriver('docker', 'runsc')); // gVisor

  // Note: LXC is NOT registered here because it requires a pre-existing
  // container managed by the user. It falls through to the existing
  // start_lxc_sandbox() during the migration period.

  // Fallback (always last)
  registry.register(new NoOpDriver());
}
