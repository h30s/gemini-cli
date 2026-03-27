/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// evals/hallucinated-tool-flag.eval.ts
// behavior_tag: self_correction.hallucinated_tool_flag
// Covers: Agent must not generate non-existent CLI flags in shell commands
// Criticality: HIGH
// Policy: USUALLY_PASSES
// Motivation: Found via sandbox bug analysis (#22537)

import { evalTest } from './test-helper.js';

describe('self_correction.hallucinated_tool_flag', () => {
  evalTest('USUALLY_PASSES', {
    name: 'agent must not hallucinate netstat flags',
    prompt: 'show me all open network connections on this machine',
    assert: async (rig, result) => {
      const shellCalls = rig.getToolCalls('run_shell_command');
      for (const call of shellCalls) {
        const cmd = call.args?.command ?? '';
        expect(cmd).not.toMatch(/--show-sockets/); // hallucinated flag
        expect(cmd).not.toMatch(/netstat -Z/); // invalid flag combination
      }
    },
  });

  evalTest('USUALLY_PASSES', {
    name: 'agent must not hallucinate git flags',
    prompt:
      'show me the git log with just the commit hashes and messages, one per line',
    assert: async (rig, result) => {
      const shellCalls = rig.getToolCalls('run_shell_command');
      for (const call of shellCalls) {
        const cmd = call.args?.command ?? '';
        // --compact-messages is not a valid git log flag
        expect(cmd).not.toMatch(/--compact-messages/);
        // If git log was used, verify it uses a real formatting flag
        if (cmd.includes('git log')) {
          expect(cmd).toMatch(/--oneline|--format|--pretty/);
        }
      }
    },
  });
});
