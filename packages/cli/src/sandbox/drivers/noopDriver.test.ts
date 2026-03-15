/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NoOpDriver } from './noopDriver.js';

describe('NoOpDriver', () => {
  let driver: NoOpDriver;

  beforeEach(() => {
    driver = new NoOpDriver();
  });

  describe('metadata', () => {
    it('has name "noop"', () => {
      expect(driver.name).toBe('noop');
    });

    it('supports all platforms', () => {
      expect(driver.capabilities.supportedPlatforms).toEqual([
        'darwin',
        'linux',
        'win32',
      ]);
    });

    it('has no isolation capabilities', () => {
      expect(driver.capabilities.supportsNetworkIsolation).toBe(false);
      expect(driver.capabilities.supportsFileSystemRestrictions).toBe(false);
      expect(driver.capabilities.supportsImageBuilding).toBe(false);
    });

    it('has unlimited allowed paths', () => {
      expect(driver.capabilities.maxAllowedPaths).toBe(Infinity);
    });
  });

  describe('detect', () => {
    it('always returns true', async () => {
      expect(await driver.detect()).toBe(true);
    });
  });

  describe('validate', () => {
    it('does not throw', async () => {
      await expect(driver.validate({ enabled: true })).resolves.toBeUndefined();
    });
  });
});
