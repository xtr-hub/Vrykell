import { beforeEach, expect, it, vi } from 'vitest';
import { agentStream } from '../services/agentStream';
import { useAgentSettings } from '../stores/agentSettings';
import { useUsageStore } from '../stores/usage';
import type { ToolRun } from '../model/messageParts';

const metrics = vi.hoisted(() => ({ resolve: undefined as ((usage: unknown) => void) | undefined, parts: [] as unknown[] }));
vi.mock('ai', async importOriginal => ({
  ...await importOriginal<typeof import('ai')>(),
  streamText: vi.fn(() => ({
    fullStream: (async function* () { yield* metrics.parts; })(),
    usage: new Promise(resolve => { metrics.resolve = resolve; }),
  })),
}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: vi.fn(async command => command === 'get_ai_config' ? {
    has_key: true, has_anthropic_key: false, has_gemini_key: false, has_tavily_key: false,
    provider: 'openai-compatible', base_url: 'https://api.example.com/v1', model: 'test-model',
    active_model: 'test', models: [{ id: 'test', name: 'Test', provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model' }],
  } : ''),
}));

beforeEach(() => {
  useAgentSettings.setState(state => ({ global: { ...state.global, agentMode: false } }));
  useUsageStore.setState({ records: [] }); metrics.resolve = undefined; metrics.parts = [];
});

it('preserves cancellation in structured tool results', async () => {
  metrics.parts = [{ type: 'tool-result', toolCallId: 'question', toolName: 'ask_user', output: { ok: false, answered: false, cancelled: true } }];
  const runs: ToolRun[] = [];
  await agentStream([{ role: 'user', content: 'Question' }], () => {}, { handlers: { onToolEvent: run => runs.push(run) } });
  expect(runs[runs.length - 1]?.state).toBe('cancelled');
});

it('retains the denial reason from a structured tool result', async () => {
  metrics.parts = [{ type: 'tool-result', toolCallId: 'denied', toolName: 'run_command', output: { ok: false, denied: true, error: 'Policy denied this command' } }];
  const runs: ToolRun[] = [];
  await agentStream([{ role: 'user', content: 'Run it' }], () => {}, { handlers: { onToolEvent: run => runs.push(run) } });
  expect(runs[runs.length - 1]).toMatchObject({ state: 'denied', error: 'Policy denied this command' });
});

it('finishes the reply without waiting for optional usage and records it when available', async () => {
  await agentStream([{ role: 'user', content: 'Question' }], () => {});
  expect(useUsageStore.getState().records).toHaveLength(0);
  metrics.resolve?.({ inputTokens: 3, outputTokens: 4, inputTokenDetails: {}, outputTokenDetails: {} });
  await vi.waitFor(() => expect(useUsageStore.getState().records).toHaveLength(1));
});

it('ignores late usage after the turn is cancelled', async () => {
  const controller = new AbortController();
  await agentStream([{ role: 'user', content: 'Question' }], () => {}, { signal: controller.signal });
  controller.abort();
  metrics.resolve?.({ inputTokens: 3, outputTokens: 4, inputTokenDetails: {}, outputTokenDetails: {} });
  await Promise.resolve();
  expect(useUsageStore.getState().records).toHaveLength(0);
});
