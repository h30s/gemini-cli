/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerDriver } from './containerDriver.js';

// Mock command-exists
vi.mock('command-exists', () => ({
  default: {
    sync: vi.fn().mockReturnValue(false),
  },
}));

describe('ContainerDriver', () => {
  describe('Docker driver', () => {
    let driver: ContainerDriver;

    beforeEach(() => {
      driver = new ContainerDriver('docker');
    });

    describe('metadata', () => {
      it('has name "docker"', () => {
        expect(driver.name).toBe('docker');
      });

      it('supports darwin and linux', () => {
        expect(driver.capabilities.supportedPlatforms).toEqual([
          'darwin',
          'linux',
        ]);
      });

      it('supports all isolation capabilities', () => {
        expect(driver.capabilities.supportsNetworkIsolation).toBe(true);
        expect(driver.capabilities.supportsFileSystemRestrictions).toBe(true);
        expect(driver.capabilities.supportsImageBuilding).toBe(true);
      });

      it('has unlimited allowed paths', () => {
        expect(driver.capabilities.maxAllowedPaths).toBe(Infinity);
      });

      it('does not require pre-existing container', () => {
        expect(driver.capabilities.requiresPreExistingContainer).toBe(false);
      });
    });

    describe('detect', () => {
      it('returns false when docker command is not found', async () => {
        const { default: commandExists } = await import('command-exists');
        vi.mocked(commandExists.sync).mockReturnValue(false);
        expect(await driver.detect()).toBe(false);
      });

      it('returns true when docker command is found', async () => {
        const { default: commandExists } = await import('command-exists');
        vi.mocked(commandExists.sync).mockReturnValue(true);
        expect(await driver.detect()).toBe(true);
      });
    });

    describe('validate', () => {
      it('throws when image is missing', async () => {
        await expect(driver.validate({ enabled: true })).rejects.toThrow(
          'Sandbox image is required',
        );
      });

      it('throws when image name is invalid', async () => {
        await expect(
          driver.validate({ enabled: true, image: 'bad image!!' }),
        ).rejects.toThrow('Invalid sandbox image name');
      });
    });
  });

  describe('Podman driver', () => {
    it('has name "podman"', () => {
      const driver = new ContainerDriver('podman');
      expect(driver.name).toBe('podman');
    });
  });

  describe('gVisor driver', () => {
    let driver: ContainerDriver;

    beforeEach(() => {
      driver = new ContainerDriver('docker', 'runsc');
    });

    it('has name "gvisor"', () => {
      expect(driver.name).toBe('gvisor');
    });

    it('description mentions gVisor', () => {
      expect(driver.description).toContain('gVisor');
    });

    describe('detect', () => {
      it('requires both docker and runsc commands', async () => {
        const { default: commandExists } = await import('command-exists');
        // docker exists but runsc doesn't
        vi.mocked(commandExists.sync).mockImplementation(
          (cmd: string) => cmd === 'docker',
        );
        expect(await driver.detect()).toBe(false);
      });

      it('returns true when both docker and runsc exist', async () => {
        const { default: commandExists } = await import('command-exists');
        vi.mocked(commandExists.sync).mockReturnValue(true);
        expect(await driver.detect()).toBe(true);
      });
    });
  });
});
