/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxDriverRegistry } from './sandboxDriverRegistry.js';
import type { SandboxDriver } from './sandboxDriver.js';

// Helper to create mock drivers with configurable availability and platform
function createMockDriver(
  name: string,
  available: boolean,
  overrides?: Partial<SandboxDriver>,
): SandboxDriver {
  return {
    name,
    description: `Mock ${name} driver`,
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

function createMockDriverForPlatform(
  name: string,
  available: boolean,
  platforms: NodeJS.Platform[],
): SandboxDriver {
  return createMockDriver(name, available, {
    capabilities: {
      supportsNetworkIsolation: false,
      supportsFileSystemRestrictions: false,
      supportsImageBuilding: false,
      requiresPreExistingContainer: false,
      supportedPlatforms: platforms,
      maxAllowedPaths: Infinity,
    },
  });
}

describe('SandboxDriverRegistry', () => {
  let registry: SandboxDriverRegistry;

  beforeEach(() => {
    registry = new SandboxDriverRegistry();
  });

  describe('register', () => {
    it('registers a driver and makes it retrievable by name', () => {
      const driver = createMockDriver('seatbelt', true);
      registry.register(driver);
      expect(registry.get('seatbelt')).toBe(driver);
    });

    it('throws on duplicate driver name', () => {
      registry.register(createMockDriver('test', true));
      expect(() => registry.register(createMockDriver('test', true))).toThrow(
        "Sandbox driver 'test' already registered",
      );
    });

    it('skips drivers for unsupported platforms', () => {
      // Create a driver that only supports a platform we're NOT on
      const unsupportedPlatform: NodeJS.Platform =
        process.platform === 'darwin' ? 'win32' : 'darwin';
      const driver = createMockDriverForPlatform('win-only', true, [
        unsupportedPlatform,
      ]);

      registry.register(driver);
      expect(registry.get('win-only')).toBeUndefined();
      expect(registry.listAll()).toHaveLength(0);
    });

    it('registers drivers for the current platform', () => {
      const driver = createMockDriverForPlatform('current', true, [
        process.platform,
      ]);
      registry.register(driver);
      expect(registry.get('current')).toBe(driver);
    });
  });

  describe('resolve', () => {
    it('resolves explicit command to matching driver', async () => {
      const docker = createMockDriver('docker', true);
      registry.register(docker);
      const result = await registry.resolve({
        enabled: true,
        command: 'docker',
      });
      expect(result).toBe(docker);
    });

    it('maps sandbox-exec alias to seatbelt driver', async () => {
      const seatbelt = createMockDriver('seatbelt', true);
      registry.register(seatbelt);
      const result = await registry.resolve({
        enabled: true,
        command: 'sandbox-exec',
      });
      expect(result).toBe(seatbelt);
    });

    it('maps runsc alias to gvisor driver', async () => {
      const gvisor = createMockDriver('gvisor', true);
      registry.register(gvisor);
      const result = await registry.resolve({
        enabled: true,
        command: 'runsc',
      });
      expect(result).toBe(gvisor);
    });

    it('returns undefined for unknown command (not registered)', async () => {
      const result = await registry.resolve({
        enabled: true,
        command: 'lxc',
      });
      expect(result).toBeUndefined();
    });

    it('throws FatalSandboxError when driver exists but not available', async () => {
      registry.register(createMockDriver('docker', false));
      await expect(
        registry.resolve({ enabled: true, command: 'docker' }),
      ).rejects.toThrow('not available');
    });

    it('auto-detects first available driver when no command specified', async () => {
      registry.register(createMockDriver('seatbelt', false));
      registry.register(createMockDriver('docker', true));
      const result = await registry.resolve({ enabled: true });
      expect(result?.name).toBe('docker');
    });

    it('returns undefined when no drivers are available and no command', async () => {
      registry.register(createMockDriver('seatbelt', false));
      registry.register(createMockDriver('docker', false));
      const result = await registry.resolve({ enabled: true });
      expect(result).toBeUndefined();
    });
  });

  describe('detectBest', () => {
    it('respects registration order (priority)', async () => {
      registry.register(createMockDriver('seatbelt', true));
      registry.register(createMockDriver('docker', true));
      const result = await registry.detectBest();
      expect(result?.name).toBe('seatbelt');
    });

    it('skips drivers whose detection throws', async () => {
      registry.register(
        createMockDriver('seatbelt', true, {
          detect: vi.fn().mockRejectedValue(new Error('binary missing')),
        }),
      );
      registry.register(createMockDriver('docker', true));
      const result = await registry.detectBest();
      expect(result?.name).toBe('docker');
    });

    it('returns undefined when all drivers fail detection', async () => {
      registry.register(
        createMockDriver('a', true, {
          detect: vi.fn().mockRejectedValue(new Error('fail')),
        }),
      );
      registry.register(createMockDriver('b', false));
      const result = await registry.detectBest();
      expect(result).toBeUndefined();
    });
  });

  describe('listAvailable', () => {
    it('returns only drivers that are currently available', async () => {
      registry.register(createMockDriver('seatbelt', false));
      registry.register(createMockDriver('docker', true));
      registry.register(createMockDriver('noop', true));
      const available = await registry.listAvailable();
      expect(available.map((d) => d.name)).toEqual(['docker', 'noop']);
    });

    it('returns empty array when nothing is available', async () => {
      registry.register(createMockDriver('seatbelt', false));
      const available = await registry.listAvailable();
      expect(available).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('returns all registered drivers in registration order', () => {
      registry.register(createMockDriver('seatbelt', true));
      registry.register(createMockDriver('docker', false));
      registry.register(createMockDriver('noop', true));
      const all = registry.listAll();
      expect(all.map((d) => d.name)).toEqual(['seatbelt', 'docker', 'noop']);
    });

    it('returns empty array when nothing is registered', () => {
      expect(registry.listAll()).toEqual([]);
    });
  });

  describe('getDiagnostics', () => {
    it('returns platform and all driver info with availability', async () => {
      registry.register(createMockDriver('seatbelt', true));
      registry.register(createMockDriver('docker', false));
      const diag = await registry.getDiagnostics();

      expect(diag.platform).toBe(process.platform);
      expect(diag.drivers).toHaveLength(2);
      expect(diag.drivers[0]).toMatchObject({
        name: 'seatbelt',
        available: true,
      });
      expect(diag.drivers[1]).toMatchObject({
        name: 'docker',
        available: false,
      });
      expect(diag.recommended).toBe('seatbelt');
    });

    it('captures detection errors in diagnostics', async () => {
      registry.register(
        createMockDriver('broken', true, {
          detect: vi.fn().mockRejectedValue(new Error('crash')),
        }),
      );
      const diag = await registry.getDiagnostics();
      expect(diag.drivers[0].available).toBe(false);
      expect(diag.drivers[0].error).toBe('crash');
    });

    it('returns no recommended driver when nothing is available', async () => {
      registry.register(createMockDriver('docker', false));
      const diag = await registry.getDiagnostics();
      expect(diag.recommended).toBeUndefined();
    });
  });
});
