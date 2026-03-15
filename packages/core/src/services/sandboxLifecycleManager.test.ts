/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SandboxLifecycleManager } from './sandboxLifecycleManager.js';
import type { SandboxDriver, SandboxDriverContext } from './sandboxDriver.js';
import type { SandboxConfig } from '../config/config.js';

function createMockDriver(
  available: boolean,
  overrides?: Partial<SandboxDriver>,
): SandboxDriver {
  return {
    name: 'test-driver',
    description: 'Mock test driver',
    capabilities: {
      supportsNetworkIsolation: false,
      supportsFileSystemRestrictions: false,
      supportsImageBuilding: false,
      requiresPreExistingContainer: false,
      supportedPlatforms: [process.platform],
      maxAllowedPaths: Infinity,
    },
    detect: vi.fn().mockResolvedValue(available),
    validate: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

const mockConfig: SandboxConfig = { enabled: true };

const mockContext: SandboxDriverContext = {
  config: mockConfig,
  nodeArgs: [],
  cliArgs: [],
  workdir: '/tmp/test',
};

describe('SandboxLifecycleManager', () => {
  describe('state transitions', () => {
    it('starts in idle state', () => {
      const manager = new SandboxLifecycleManager(createMockDriver(true));
      expect(manager.state).toBe('idle');
    });

    it('transitions idle → initializing → ready on successful initialize', async () => {
      const driver = createMockDriver(true);
      const manager = new SandboxLifecycleManager(driver);

      await manager.initialize(mockConfig);

      expect(manager.state).toBe('ready');
      expect(driver.detect).toHaveBeenCalledOnce();
      expect(driver.validate).toHaveBeenCalledWith(mockConfig);
    });

    it('transitions ready → running → completed on successful execute', async () => {
      const driver = createMockDriver(true);
      const manager = new SandboxLifecycleManager(driver);

      await manager.initialize(mockConfig);
      const exitCode = await manager.execute(mockContext);

      expect(manager.state).toBe('completed');
      expect(exitCode).toBe(0);
      expect(driver.execute).toHaveBeenCalledWith(mockContext);
    });

    it('returns the exit code from driver.execute()', async () => {
      const driver = createMockDriver(true, {
        execute: vi.fn().mockResolvedValue(42),
      });
      const manager = new SandboxLifecycleManager(driver);
      await manager.initialize(mockConfig);
      const exitCode = await manager.execute(mockContext);
      expect(exitCode).toBe(42);
    });
  });

  describe('error handling', () => {
    it('transitions to error state when detect() returns false', async () => {
      const manager = new SandboxLifecycleManager(createMockDriver(false));
      await expect(manager.initialize(mockConfig)).rejects.toThrow(
        'not available',
      );
      expect(manager.state).toBe('error');
    });

    it('transitions to error state when validate() throws', async () => {
      const driver = createMockDriver(true, {
        validate: vi.fn().mockRejectedValue(new Error('bad config')),
      });
      const manager = new SandboxLifecycleManager(driver);
      await expect(manager.initialize(mockConfig)).rejects.toThrow(
        'bad config',
      );
      expect(manager.state).toBe('error');
    });

    it('transitions to error state when execute() throws', async () => {
      const driver = createMockDriver(true, {
        execute: vi.fn().mockRejectedValue(new Error('spawn failed')),
      });
      const manager = new SandboxLifecycleManager(driver);
      await manager.initialize(mockConfig);
      await expect(manager.execute(mockContext)).rejects.toThrow(
        'spawn failed',
      );
      expect(manager.state).toBe('error');
    });
  });

  describe('state guards', () => {
    it('throws if initialize() called when not idle', async () => {
      const manager = new SandboxLifecycleManager(createMockDriver(true));
      await manager.initialize(mockConfig);

      await expect(manager.initialize(mockConfig)).rejects.toThrow(
        "Cannot initialize: lifecycle manager is in 'ready' state",
      );
    });

    it('throws if execute() called before initialize()', async () => {
      const manager = new SandboxLifecycleManager(createMockDriver(true));
      await expect(manager.execute(mockContext)).rejects.toThrow(
        'Call initialize() first',
      );
    });

    it('throws if execute() called after error', async () => {
      const manager = new SandboxLifecycleManager(createMockDriver(false));
      await expect(manager.initialize(mockConfig)).rejects.toThrow();

      await expect(manager.execute(mockContext)).rejects.toThrow(
        "Cannot execute: lifecycle manager is in 'error' state",
      );
    });
  });

  describe('driverName', () => {
    it('exposes the driver name', () => {
      const driver = createMockDriver(true);
      const manager = new SandboxLifecycleManager(driver);
      expect(manager.driverName).toBe('test-driver');
    });
  });
});
