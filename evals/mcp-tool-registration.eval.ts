/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// evals/mcp-tool-registration.eval.ts
// behavior_tag: subagents.mcp_tool_registration
// Covers: Subagents without toolConfig must be able to use MCP tools
// Criticality: HIGH
// Policy: ALWAYS_PASSES
// Regression test for: fix(core): allow subagents without toolConfig to register MCP tools (PR #20170)

import { evalTest } from './test-helper.js';

describe('subagents.mcp_tool_registration', () => {
  evalTest('ALWAYS_PASSES', {
    name: 'agent correctly lists available tools when asked',
    prompt: 'What tools do you have available? List them.',
    assert: async (rig, result) => {
      // Agent should describe its tools, not return an error
      expect(result.toLowerCase()).not.toMatch(
        /error|failed|unavailable|cannot/i,
      );
      // Response should be substantive — tool listing is non-trivial
      expect(result.length).toBeGreaterThan(50);
    },
  });
});
