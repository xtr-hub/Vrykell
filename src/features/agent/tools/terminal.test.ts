/**
 * Tests for the terminal tools (read_terminal / terminal_keys).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const { termMock } = vi.hoisted(() => ({
  termMock: {
    state: { sessions: {} as Record<string, string>, startupStates: {} as Record<string, string>, scenes: {} as Record<string, string>, dims: {} as Record<string, { cols: number; rows: number }>, focusedPaneId: 'p1' },
    screen: null as { text?: string } | null,
  },
}));
vi.mock('@features/terminal/stores/terminal', () => ({
  useTerminalStore: {
    getState: () => termMock.state,
    setState: (p: unknown) => Object.assign(termMock.state, p),
  },
  getFocusedTerminalId: () => termMock.state.focusedPaneId,
  getTerminalScreen: () => termMock.screen,
  termInstances: new Map(),
}));

import { buildTerminalTools } from '@features/agent/tools/terminal';
import { usePermissions, type ToolContext } from '@features/agent/stores/permissions';
import { approvingToolContext } from '../../../test-utils/approvingToolContext';
import { useBlockStore } from '@features/terminal/stores/blocks';

usePermissions.setState({ levels: { read_terminal: 'allow', terminal_keys: 'allow' } });
const CTX: ToolContext = approvingToolContext();

type Exec = (args: Record<string, unknown>) => Promise<unknown>;
const execOf = (t: unknown): Exec => {
  const e = (t as { execute: (a: unknown, o: unknown) => Promise<never> }).execute;
  return (args) => e(args, {});
};

beforeEach(() => {
  invokeMock.mockReset();
  termMock.state.sessions = {};
  termMock.state.scenes = {};
  termMock.state.dims = {};
  termMock.state.focusedPaneId = 'p1';
  termMock.screen = null;
  useBlockStore.setState({ byTab: {} });
});

describe('read_terminal tool', () => {
  it('reports busy and unknown states without inferring completion from a quiet snapshot', async () => {
    termMock.state.sessions = { p1: 's1' };
    termMock.state.scenes = { p1: 'classic' };
    termMock.screen = { text: 'quiet output' };
    const read = execOf(buildTerminalTools(CTX).read_terminal);
    expect(await read({})).toMatchObject({ executionState: 'unknown' });
    termMock.state.scenes = { p1: 'blockList' };
    expect(await read({})).toMatchObject({ executionState: 'ready' });
    useBlockStore.setState({ byTab: { p1: [{ id: 'running', command: 'sleep 10', status: 'executing', outputText: '', outputHtml: '', outputRaw: '', startedAt: 1, endedAt: null, exitCode: null, wasLongRunning: false, linesTruncated: 0 }] } });
    expect(await read({})).toMatchObject({ executionState: 'busy' });
  });
  it('no session: structured error', async () => {
    const r = await execOf(buildTerminalTools(CTX).read_terminal)({});
    expect(r).toMatchObject({ ok: false, code: 'TERMINAL_DISCONNECTED', requiresUserAction: true });
  });

  it('main xterm has content: returns the screen', async () => {
    termMock.state.sessions = { p1: 's1' };
    termMock.screen = { text: 'vim 画面' };
    const r = (await execOf(buildTerminalTools(CTX).read_terminal)({})) as { ok: boolean; text?: string };
    expect(r.ok).toBe(true);
    expect(r.text).toBe('vim 画面');
  });

  it('block-list scene: composes the screen from the latest command block output', async () => {
    termMock.state.sessions = { p1: 's1' };
    termMock.state.scenes = { p1: 'blockList' };
    termMock.state.dims = { p1: { cols: 100, rows: 30 } };
    termMock.screen = { text: 'stale main buffer' };
    useBlockStore.setState({ byTab: { p1: [{ id: 'b1', command: 'ls', outputText: 'a.txt\nb.txt', status: 'done' } as never] } });
    const r = (await execOf(buildTerminalTools(CTX).read_terminal)({})) as {
      ok: boolean; scene: string; cols: number; rows: number; content: string;
    };
    expect(r.ok).toBe(true);
    expect(r.scene).toBe('blockList');
    expect(r.cols).toBe(100);
    expect(r.rows).toBe(30);
    expect(r.content).toContain('a.txt');
  });

  it('gate denial returns immediately', async () => {
    usePermissions.setState({ levels: { read_terminal: 'deny' } });
    const r = await execOf(buildTerminalTools(CTX).read_terminal)({});
    expect(r).toBeDefined();
    usePermissions.setState({ levels: { read_terminal: 'allow', terminal_keys: 'allow' } });
  });
});

describe('terminal_keys tool', () => {
  it('waits without writing when empty keys request a screen update', async () => {
    vi.useFakeTimers();
    try {
      termMock.state.sessions = { p1: 's1' };
      const result = execOf(buildTerminalTools(CTX).terminal_keys)({ keys: '', wait_ms: 3000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toMatchObject({ ok: true, sent: 0, waited_ms: 3000 });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('accepts a longer screen-update wait and clamps anything beyond the bound', async () => {
    vi.useFakeTimers();
    try {
      termMock.state.sessions = { p1: 's1' };
      const tool = buildTerminalTools(CTX).terminal_keys as unknown as {
        inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      };
      expect(tool.inputSchema.safeParse({ keys: '', wait_ms: 4000 }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ keys: '', wait_ms: 20_000 }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ wait_ms: 1000 }).success).toBe(true);
      const result = execOf(buildTerminalTools(CTX).terminal_keys)({ keys: '', wait_ms: 20_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toMatchObject({ ok: true, waited_ms: 10_000 });
      const waitOnly = execOf(buildTerminalTools(CTX).terminal_keys)({ wait_ms: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waitOnly).toMatchObject({ ok: true, waited_ms: 1000 });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('sends keys: \\xNN normalization, wait_ms pass-through, returns the scene', async () => {
    termMock.state.sessions = { p1: 's1' };
    termMock.state.scenes = { p1: 'altScreen' };
    invokeMock.mockResolvedValue(undefined);
    const r = (await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'vi a\\x1b', wait_ms: 0 })) as {
      ok: boolean; sent: number; scene: string; decoded: string;
    };
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { id: 's1', data: 'vi a\u001b' });
    expect(r).toEqual({ ok: true, sent: 5, scene: 'altScreen', decoded: 'vi a\u001b' });
  });

  it('decodes literal \\uXXXX a model writes by mistake (an extra backslash) rather than sending plain text', async () => {
    termMock.state.sessions = { p1: 's1' };
    termMock.state.scenes = { p1: 'altScreen' };
    invokeMock.mockResolvedValue(undefined);
    // The model writes {"keys": "\\u000b\\u0018"}: the string holds a literal "\u000b\u0018", not control characters
    await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: '\\u000b\\u0018', wait_ms: 0 });
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { id: 's1', data: '\u000b\u0018' });
  });

  it('decodes every literal escape form (\\b \\t \\r \\n \\e \\xNN \\uXXXX)', async () => {
    termMock.state.sessions = { p1: 's1' };
    invokeMock.mockResolvedValue(undefined);
    // the model wrote the editor save-and-quit sequence in doubled-backslash literal form
    await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'i\\u001b:wq\\r', wait_ms: 0 });
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { id: 's1', data: 'i\u001b:wq\r' });
    // \\e = Esc, \\b = backspace, \\n = newline, \\t = Tab, \\x1b = Esc
    await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: '\\e\\b\\n\\t\\x1b[A', wait_ms: 0 });
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { id: 's1', data: '\u001b\b\n\t\u001b[A' });
  });

  it('invalid escapes (such as \\uZZZZ) report an error instead of being sent verbatim', async () => {
    termMock.state.sessions = { p1: 's1' };
    invokeMock.mockClear();
    const r = (await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'a\\uZZZZ', wait_ms: 0 })) as {
      ok: boolean; error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无效转义序列');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('empty or oversized key sequences: reports an error', async () => {
    termMock.state.sessions = { p1: 's1' };
    invokeMock.mockClear();
    const empty = await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: '', wait_ms: 0 });
    expect(empty).toEqual({ ok: false, error: '按键序列为空，请提供要发送的按键' });
    const long = await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'x'.repeat(5000), wait_ms: 0 });
    expect(long).toEqual({ ok: false, error: '按键序列过长（>4096 字符），请分段发送' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('no session / write failure: structured error', async () => {
    const noSession = await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'x', wait_ms: 0 });
    expect(noSession).toMatchObject({ ok: false, code: 'TERMINAL_DISCONNECTED', requiresUserAction: true });
    termMock.state.sessions = { p1: 's1' };
    invokeMock.mockRejectedValueOnce(new Error('pty 已关闭'));
    const fail = await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'x', wait_ms: 0 });
    expect(fail).toEqual({ ok: false, error: '写入终端失败: pty 已关闭' });
  });

  it('gate denial returns immediately', async () => {
    usePermissions.setState({ levels: { terminal_keys: 'deny' } });
    const r = await execOf(buildTerminalTools(CTX).terminal_keys)({ keys: 'x', wait_ms: 0 });
    expect(r).toBeDefined();
    expect(invokeMock).not.toHaveBeenCalled();
    usePermissions.setState({ levels: { read_terminal: 'allow', terminal_keys: 'allow' } });
  });
});
