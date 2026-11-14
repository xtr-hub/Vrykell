import { expect, it } from 'vitest';
import { prepareToolRecoveryStep, TOOL_RECOVERY_GUIDANCE } from '../model/toolRecovery';

it('allows normal failures to be diagnosed without suppressing tools', () => {
  for (const output of [null, 'denied', { ok: false, exitCode: 3 }, { ok: false, completed: false }, { denied: false }]) {
    expect(prepareToolRecoveryStep({ steps: [{ toolResults: [{ output }] }] })).toBeUndefined();
  }
});

it('forces a text-only handoff after any denial in the current turn', () => {
  expect(prepareToolRecoveryStep({ steps: [] })).toBeUndefined();
  expect(prepareToolRecoveryStep({ steps: [
    { toolResults: [{ output: { ok: false, denied: true, error: 'Confirmation unavailable' } }] },
    { toolResults: [{ output: { ok: true } }] },
  ] })).toEqual({ toolChoice: 'none' });
  expect(TOOL_RECOVERY_GUIDANCE).toContain('Never retry with another tool');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('Only call tools included in this request');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('terminal_keys is for keystrokes');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('soft completion guard');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('executionState=unknown');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('a program you started in this conversation may be stopped');
  expect(TOOL_RECOVERY_GUIDANCE).toContain('do not interrupt a program you did not start in this conversation');
  expect(prepareToolRecoveryStep({ steps: [{ toolResults: [{ output: { denied: true } }] }] }, ['ask_user', 'run_command'])).toEqual({ toolChoice: 'none' });
});

it('uses the answered question without offering another question in the same turn', () => {
  const steps = [{ toolResults: [{ toolName: 'ask_user', output: { ok: true, answered: true, answer: 'Continue' } }] }];
  expect(prepareToolRecoveryStep({ steps }, ['ask_user', 'run_command', 'read_file'])).toEqual({ activeTools: ['run_command', 'read_file'] });
  expect(prepareToolRecoveryStep({ steps }, ['ask_user'])).toEqual({ toolChoice: 'none' });
  for (const output of [{ ok: true, answered: false }, { ok: false, cancelled: true }, { ok: false }]) {
    expect(prepareToolRecoveryStep({ steps: [{ toolResults: [{ toolName: 'ask_user', output }] }] }, ['ask_user', 'run_command'])).toEqual({ toolChoice: 'none' });
  }
});
