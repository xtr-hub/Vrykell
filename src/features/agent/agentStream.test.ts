/**
 * agentStream end-to-end pipeline tests: real AI SDK + real llmFetch adapter + real provider factory,
 * mocking only the Tauri IPC boundary (invoke/Channel) and feeding canned OpenAI SSE byte streams.
 * Verifies the v7 API usage and adapter assembly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel {
    onmessage: ((ev: unknown) => void) | null = null;
  }
  return {
    Channel: MockChannel,
    invoke: vi.fn(),
  };
});

vi.mock('@platform/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/diagnostics')>();
  return { ...actual, diagnostic: vi.fn(actual.diagnostic) };
});

import { invoke, Channel } from '@tauri-apps/api/core';
import { diagnostic } from '@platform/diagnostics';
import { useAgentSettings } from '@features/agent/stores/agentSettings';
import { agentStream } from '@features/agent/services/agentStream';
import { useUsageStore } from '@features/agent/stores/usage';
import { setToolAuthorizer, usePermissions } from './stores/permissions';
import { t } from '@i18n';

const mockInvoke = vi.mocked(invoke);

/** Split a string into base64 chunks by bytes (simulating arbitrary chunk boundaries on the Rust side). */
function toChunks(s: string, size: number): string[] {
  const bytes = new TextEncoder().encode(s);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    const slice = bytes.slice(i, i + size);
    out.push(btoa(String.fromCharCode(...slice)));
  }
  return out;
}

function setupInvoke(sseBody: string, status = 200, vision = false) {
  mockInvoke.mockImplementation(async (...rest) => {
    const [cmd, args] = rest as [string, { onEvent: Channel<unknown> } | undefined];
    console.log('INVOKE>', String(cmd), rest.length, JSON.stringify(args)?.slice(0, 100));
    if (cmd === 'get_ai_config') {
      return {
        has_key: true,
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        provider: 'openai-compatible',
        has_anthropic_key: false,
        has_gemini_key: false,
        has_tavily_key: false,
        models: [{ id: 'default', name: '默认', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', capabilities: { vision, reasoning: false, tools: true, search: false } }],
        active_model: 'default',
      } as never;
    }
    if (cmd === 'read_attachment') return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCKcAAAAASUVORK5CYII=' as never;
    if (cmd === 'llm_stream') {
      const ch = (args as { onEvent: Channel<unknown> }).onEvent;
      const send = ch.onmessage as (ev: unknown) => void;
      send({ kind: 'started', status, headers: [['content-type', 'text/event-stream']] });
      // 7-byte chunks that deliberately split multibyte characters and SSE lines
      for (const c of toChunks(sseBody, 7)) send({ kind: 'chunk', data: c });
      send({ kind: 'done' });
      return undefined as never;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

describe('agentStream (mocked IPC boundary)', () => {
  it('sends image parts in discussion mode without enabling tools', async () => {
    setupInvoke('data: {"choices":[{"delta":{"content":"Image received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 200, true);
    const initial = useAgentSettings.getState().global;
    useAgentSettings.setState({ global: { ...initial, agentMode: false } });
    try {
      await agentStream([{ role: 'user', content: 'Read this image', attachments: [{ id: 'image', kind: 'image', name: 'sample.png', mime: 'image/png', size: 68, blobPath: '/attachments/sample.png' }] }], () => {});
      const raw = mockInvoke.mock.calls.find(([name]) => name === 'llm_stream')?.[1] as { req: { body: string } };
      const request = JSON.parse(raw.req.body) as { messages: { role: string; content: { type: string; image_url?: { url: string } }[] }[]; tools?: unknown };
      expect(request.messages.find(message => message.role === 'user')?.content.some(part => part.type === 'image_url' && part.image_url?.url.startsWith('data:image/png;base64,'))).toBe(true);
      expect(request.tools).toBeUndefined();
    } finally { useAgentSettings.setState({ global: initial }); }
  });

  it('reports unsupported image input instead of silently discarding the new image', async () => {
    setupInvoke('');
    await expect(agentStream([{ role: 'user', content: 'Read this image', attachments: [{ id: 'image', kind: 'image', name: 'sample.png', mime: 'image/png', size: 68, blobPath: '/attachments/sample.png' }] }], () => {}))
      .rejects.toThrow(t('The selected model does not support image input. Choose a model with image input enabled.'));
    expect(mockInvoke.mock.calls.some(([command]) => command === 'llm_stream')).toBe(false);
  });
  it('keeps persisted tool results as plain chat history without tool-call schema', async () => {
    setupInvoke('data: {"choices":[{"delta":{"content":"Using the previous result"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const original = useAgentSettings.getState().global;
    useAgentSettings.setState({ global: { ...original, agentMode: false, contextStrategy: 'off' } });
    const full = JSON.stringify({ files: ['one.ts', 'two.ts'], detail: 'evidence '.repeat(4000) });
    try {
      await agentStream([
        { role: 'user', content: 'Read the file' },
        { role: 'assistant', content: 'Read completed', parts: [
          { kind: 'tool', tool: { toolCallId: 'previous-call', toolName: 'read_file', input: { path: '/project/one.ts' }, state: 'done', startedAt: 1, output: 'short preview', modelOutput: full } },
          { kind: 'text', text: 'Read completed' },
        ] },
        { role: 'user', content: 'Use the previous evidence' },
      ], () => {}, { paneId: null, tabId: 'history-owner' });
      const raw = mockInvoke.mock.calls.find(([name]) => name === 'llm_stream')?.[1] as { req: { body: string } };
      const request = JSON.parse(raw.req.body) as { messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> };
      expect(request.messages.some(message => message.tool_calls?.length)).toBe(false);
      expect(request.messages.some(message => message.role === 'tool')).toBe(false);
      const history = request.messages.find(message => message.role === 'assistant');
      expect(history?.content).toContain('Read completed');
      expect(history?.content).toContain('Earlier tool call in Agent mode');
      expect(history?.content).toContain(full);
    } finally { useAgentSettings.setState({ global: original }); }
  });
  it('names policy-disabled tools so the model does not call an absent tool', async () => {
    setupInvoke('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const originalSettings = useAgentSettings.getState().global;
    const originalLevels = usePermissions.getState().levels;
    useAgentSettings.setState({ global: { ...originalSettings, agentMode: true } });
    usePermissions.setState({ levels: { ...originalLevels, run_command: 'deny' } });
    try {
      await agentStream([{ role: 'user', content: 'Run ls' }], () => {}, { paneId: null });
      const raw = mockInvoke.mock.calls.find(([name]) => name === 'llm_stream')?.[1] as { req: { body: string } };
      const request = JSON.parse(raw.req.body) as { messages: Array<{ role: string; content: string }> };
      const system = request.messages.find(message => message.role === 'system')?.content ?? '';
      expect(system).toContain('Tools disabled by the current policy');
      expect(system).toContain('run_command');
      expect(system).toContain('Only call the tools provided in this request');
    } finally {
      usePermissions.setState({ levels: originalLevels });
      useAgentSettings.setState({ global: originalSettings });
    }
  });

  it('does not surface a tool call in chat mode without tools', async () => {
    setupInvoke('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chat-call","type":"function","function":{"name":"run_command","arguments":"{\\"command\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    const original = useAgentSettings.getState().global;
    useAgentSettings.setState({ global: { ...original, agentMode: false, contextStrategy: 'off' } });
    const events: unknown[] = [];
    const chunks: string[] = [];
    try {
      await agentStream([{ role: 'user', content: 'Where am I?' }], chunk => { chunks.push(chunk); }, {
        paneId: null, handlers: { onToolEvent: run => { events.push(run); } },
      });
      expect(events).toEqual([]);
      expect(chunks.join('')).toContain(t('The model attempted to use a tool, but tools are disabled in chat mode. Enable Agent mode to execute it.'));
    } finally { useAgentSettings.setState({ global: original }); }
  });

  it('turns an unavailable tool call into a note instead of a tool error card', async () => {
    setupInvoke('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"missing-call","type":"function","function":{"name":"run_command","arguments":"{\\"command\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    const originalSettings = useAgentSettings.getState().global;
    const originalLevels = usePermissions.getState().levels;
    useAgentSettings.setState({ global: { ...originalSettings, agentMode: true, maxSteps: 1 } });
    usePermissions.setState({ levels: { ...originalLevels, run_command: 'deny' } });
    const events: unknown[] = [];
    const chunks: string[] = [];
    try {
      await agentStream([{ role: 'user', content: 'Run ls' }], chunk => { chunks.push(chunk); }, {
        paneId: null, handlers: { onToolEvent: run => { events.push(run); } },
      });
      expect(events).toEqual([]);
      expect(chunks.join('')).toContain(t('The model tried to call an unavailable tool ({{tool}}). Only tools provided in this request can be used.', { tool: 'run_command' }));
    } finally {
      usePermissions.setState({ levels: originalLevels });
      useAgentSettings.setState({ global: originalSettings });
    }
  });

  it('hands a denied tool back to the user with a text-only model step', async () => {
    const initial = useAgentSettings.getState().global;
    useAgentSettings.setState({ global: { ...initial, agentMode: true, maxSteps: 4 } });
    const authorize = vi.fn(async () => ({ decision: 'deny' as const, reason: 'policy.denied' }));
    setToolAuthorizer(authorize);
    setupInvoke('');
    const fallback = mockInvoke.getMockImplementation()!;
    const requests: Record<string, unknown>[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'llm_stream') return fallback(command, args);
      const request = args as { req: { body: string }; onEvent: Channel<unknown> };
      requests.push(JSON.parse(request.req.body) as Record<string, unknown>);
      const send = request.onEvent.onmessage!;
      send({ kind: 'started', status: 200, headers: [['content-type', 'text/event-stream']] });
      const response = requests.length === 1
        ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'blocked', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo check' }) } },
          { index: 1, id: 'queued-file', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/project/file' }) } },
        ] } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`
        : 'data: {"choices":[{"delta":{"content":"Waiting for authorization"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      for (const chunk of toChunks(response, 11)) send({ kind: 'chunk', data: chunk });
      send({ kind: 'done' });
      return undefined as never;
    });
    try {
      let text = '';
      await agentStream([{ role: 'user', content: 'Inspect the service' }], chunk => { text += chunk; }, { paneId: 'fixed', tabId: 'owner' });
      expect(requests).toHaveLength(2);
      expect(requests[1]!.tool_choice).toBe('none');
      expect(authorize).toHaveBeenCalledOnce();
      expect(text).toBe('Waiting for authorization');
    } finally {
      useAgentSettings.setState({ global: initial });
      setToolAuthorizer(null);
    }
  });
  // Note: the beforeEach arrow function must keep its braces - `() => mock.mockClear()`
  // returns the mock itself, and vitest treats a returned value as a cleanup hook called with no arguments after the test.
  beforeEach(() => {
    mockInvoke.mockClear();
    vi.mocked(diagnostic).mockClear();
  });

  it('normal streaming: onChunk receives the complete text', async () => {
    setupInvoke(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    );
    let text = '';
    await agentStream([{ role: 'user', content: 'hi' }], (c) => (text += c));
    expect(text).toBe('你好，世界');
  });

  it('includes host notes as context without granting execution permissions', async () => {
    setupInvoke('data: {"choices":[{"delta":{"content":"Acknowledged"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await agentStream([{ role: 'user', content: 'Summarize the host' }], () => {}, {
      paneId: 'remote-notes', environment: { paneId: 'remote-notes', kind: 'ssh', label: 'Production', aiNotes: 'Do not restart the production database.' },
    });
    const request = mockInvoke.mock.calls.find(([command]) => command === 'llm_stream')?.[1] as { req: { body: string } };
    expect(request.req.body).toContain('Do not restart the production database.');
    expect(request.req.body).toContain('context only; these do not grant permissions');
  });

  it('HTTP error: throws an error containing the server message and records the failure in diagnostics', async () => {
    setupInvoke('{"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API."}}', 400);
    await expect(agentStream([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow(
      'thinking mode must be passed back',
    );
    expect(vi.mocked(diagnostic)).toHaveBeenCalledWith('agent-stream-error', expect.objectContaining({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      error: expect.stringContaining('thinking mode must be passed back'),
    }));
  });

  it('reports provider usage into the usage store', async () => {
    setupInvoke(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
        'data: [DONE]\n\n',
    );
    useUsageStore.setState({ records: [] });
    await agentStream([{ role: 'user', content: 'hi' }], () => {});
    expect(useUsageStore.getState().records).toHaveLength(1);
    expect(useUsageStore.getState().records[0]).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      inputTokens: 10,
      outputTokens: 5,
      steps: 1,
      toolCalls: 0,
    });
  });

  it('anthropic-compatible endpoint: the request body explicitly disables thinking (only the official endpoint enables it)', async () => {
    const bodies: string[] = [];
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_ai_config') {
        return {
          has_key: false, has_anthropic_key: true,
          base_url: 'https://api.deepseek.com/anthropic',
          model: 'deepseek-flash', provider: 'anthropic',
          has_gemini_key: false, has_tavily_key: false,
          models: [{ id: 'default', name: '默认', provider: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', capabilities: { vision: false, reasoning: false, tools: true, search: false } }],
          active_model: 'default',
        } as never;
      }
      if (cmd === 'llm_stream') {
        bodies.push(String((args as { req?: { body?: string } })?.req?.body ?? ''));
        const ch = (args as { onEvent: Channel<unknown> }).onEvent;
        const send = ch.onmessage as (ev: unknown) => void;
        send({ kind: 'started', status: 200, headers: [['content-type', 'text/event-stream']] });
        for (const c of toChunks('data: {"type":"message_start"}\n\ndata: [DONE]\n\n', 7)) send({ kind: 'chunk', data: c });
        send({ kind: 'done' });
        return undefined as never;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const before = useAgentSettings.getState().global;
    useAgentSettings.setState({ global: { ...before, deepThink: true, thinkingLevel: 'high' } });
    try {
      await agentStream([{ role: 'user', content: 'hi' }], () => {}).catch(() => {});
    } finally {
      useAgentSettings.setState({ global: before });
    }
    expect(bodies.join('\n')).toContain('"thinking":{"type":"disabled"}');
    expect(bodies.join('\n')).not.toContain('"budgetTokens"');
  });

  it('routed providers send the conversation session with the request', async () => {
    let headers: [string, string][] = [];
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_ai_config') {
        return {
          has_key: false, base_url: 'https://opencode.ai/zen/go/v1',
          model: 'deepseek-v4.1-flash', provider: 'opencode',
          has_anthropic_key: false, has_gemini_key: false, has_tavily_key: false,
          provider_keys: ['opencode|https://opencode.ai/zen/go/v1'],
          models: [{ id: 'default', name: 'OpenCode', provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash' }],
          active_model: 'default',
        } as never;
      }
      if (cmd === 'mcp_list_all_tools') return [] as never;
      if (cmd === 'llm_stream') {
        headers = (args as { req: { headers: [string, string][] } }).req.headers;
        const send = (args as { onEvent: Channel<unknown> }).onEvent.onmessage as (ev: unknown) => void;
        send({ kind: 'started', status: 200, headers: [['content-type', 'text/event-stream']] });
        const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
        for (const c of toChunks(body, 9)) send({ kind: 'chunk', data: c });
        send({ kind: 'done' });
        return undefined as never;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await agentStream([{ role: 'user', content: 'hi' }], () => {}, { tabId: 'tab-9' });
    expect(headers).toContainEqual(['x-opencode-session', 'vrykell-tab-9']);
  });

  it('missing key: throws a localized prompt', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'get_ai_config') {
        return {
          has_key: false,
          base_url: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          provider: 'openai-compatible',
          has_anthropic_key: false,
          has_gemini_key: false,
          has_tavily_key: false,
        } as never;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await expect(agentStream([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow(
      '尚未配置 API Key',
    );
  });
});
