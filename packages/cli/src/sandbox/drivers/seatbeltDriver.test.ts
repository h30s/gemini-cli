/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeatbeltDriver } from './seatbeltDriver.js';
import os from 'node:os';

// Mock command-exists
vi.mock('command-exists', () => ({
  default: {
    sync: vi.fn().mockReturnValue(false),
  },
}));

describe('SeatbeltDriver', () => {
  let driver: SeatbeltDriver;

  beforeEach(() => {
    driver = new SeatbeltDriver();
    vi.restoreAllMocks();
  });

  describe('metadata', () => {
    it('has name "seatbelt"', () => {
      expect(driver.name).toBe('seatbelt');
    });

    it('only supports darwin', () => {
      expect(driver.capabilities.supportedPlatforms).toEqual(['darwin']);
    });

    it('supports network isolation and file system restrictions', () => {
      expect(driver.capabilities.supportsNetworkIsolation).toBe(true);
      expect(driver.capabilities.supportsFileSystemRestrictions).toBe(true);
    });

    it('does not support image building', () => {
      expect(driver.capabilities.supportsImageBuilding).toBe(false);
    });

    it('limits allowed paths to 5', () => {
      expect(driver.capabilities.maxAllowedPaths).toBe(5);
    });
  });

  describe('detect', () => {
    it('returns false on non-darwin platforms', async () => {
      if (os.platform() !== 'darwin') {
        expect(await driver.detect()).toBe(false);
      }
    });
  });

  describe('validate', () => {
    it('throws when BUILD_SANDBOX is set', async () => {
      const original = process.env['BUILD_SANDBOX'];
      process.env['BUILD_SANDBOX'] = '1';
      try {
        await expect(driver.validate({ enabled: true })).rejects.toThrow(
          'Cannot BUILD_SANDBOX when using macOS Seatbelt',
        );
      } finally {
        if (original === undefined) {
          delete process.env['BUILD_SANDBOX'];
        } else {
          process.env['BUILD_SANDBOX'] = original;
        }
      }
    });
  });
});
