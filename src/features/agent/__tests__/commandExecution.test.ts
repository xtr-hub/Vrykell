import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { ptyWrite } from '@platform/pty';
import { useSessionStore } from '@features/workspace';
import { leaf } from '@features/workspace/model/windowLayout';
import { registerTerminal, unregisterTerminal, useTerminalStore, useBlockStore } from '@features/terminal';
import { clearCompletionReadiness } from '@features/terminal/services/commandCompletion';
import { runCommandAndWait } from '../tools/runCommand';

vi.mock('@platform/pty', () => ({ ptyWrite: vi.fn().mockResolvedValue(undefined) }));
const workspace = useSessionStore.getState();
const terminals = useTerminalStore.getState();
const blocks = useBlockStore.getState();
const paneId = 'classic-pane';
let marker: (data: string) => boolean;
let dispose: ReturnType<typeof vi.fn>;
let terminal: Terminal;

beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(ptyWrite).mockReset().mockResolvedValue(undefined);
  dispose = vi.fn();
  terminal = {
    parser: { registerOscHandler: (_code: number, callback: typeof marker) => { marker = callback; return { dispose }; } },
    registerMarker: () => ({ line: 0, isDisposed: false, dispose: vi.fn() }),
    buffer: { active: { baseY: 0, cursorY: 0, cursorX: 0, getLine: () => ({ translateToString: () => 'actual output' }) } },
  } as unknown as Terminal;
  registerTerminal(paneId, terminal);
  useSessionStore.setState({ tabs: [{ id: 'classic', kind: 'session', title: 'Server', layout: leaf({ id: paneId, kind: 'ssh', ssh: { host: 'server', name: 'Server' } }) }] });
  useTerminalStore.setState({ sessions: { [paneId]: 'pty-classic' }, scenes: { [paneId]: 'classic' } });
  useBlockStore.setState({ byTab: {} });
});
afterEach(() => {
  clearCompletionReadiness(paneId);
  unregisterTerminal(paneId, terminal);
  useSessionStore.setState(workspace, true); useTerminalStore.setState(terminals, true); useBlockStore.setState(blocks, true);
  vi.useRealTimers();
});

function complete(code = 0) {
  const data = vi.mocked(ptyWrite).mock.calls[0]![1];
  const token = /777;([^;]+);/.exec(data)![1];
  marker(`${token};${code}`);
}

it('waits through a quiet screen until a matching shell completion marker arrives', async () => {
  let settled = false;
  const result = runCommandAndWait('sleep 5; echo result', { paneId }).then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(settled).toBe(false);
  expect(marker('another-command;0')).toBe(false);
  complete();
  expect(await result).toMatchObject({ ok: true, completed: true, exitCode: 0, output: 'actual output' });
  expect(dispose).toHaveBeenCalledOnce();
});

it('keeps the real nonzero exit code from a classic shell', async () => {
  const result = runCommandAndWait('false', { paneId });
  await vi.advanceTimersByTimeAsync(1); complete(2);
  expect(await result).toMatchObject({ ok: false, completed: true, exitCode: 2 });
});

it('retains completion delivered before the terminal write promise resolves', async () => {
  vi.mocked(ptyWrite).mockImplementationOnce(async (_session, data) => {
    const token = /777;([^;]+);/.exec(data)![1];
    marker(`${token};start`); marker(`${token};0`);
  });
  expect(await runCommandAndWait('echo fast', { paneId })).toMatchObject({ ok: true, completed: true, exitCode: 0 });
  expect(dispose).toHaveBeenCalledOnce();
});

it('rejects concurrent commands before they can be queued in the same terminal', async () => {
  const first = runCommandAndWait('sleep 5', { paneId });
  await vi.advanceTimersByTimeAsync(1);
  expect(await runCommandAndWait('echo queued', { paneId })).toMatchObject({ ok: false, completed: false, code: 'TERMINAL_BUSY' });
  expect(ptyWrite).toHaveBeenCalledOnce();
  complete(); await first;
});

it('does not execute a command that was already cancelled', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await runCommandAndWait('echo cancelled', { paneId, signal: controller.signal })).toMatchObject({ ok: false, completed: false, code: 'COMMAND_ABORTED' });
  expect(ptyWrite).not.toHaveBeenCalled();
});

it('reports a timeout without claiming completion and keeps listening for the late marker', async () => {
  const result = runCommandAndWait('sleep 99', { paneId, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ ok: false, completed: false, code: 'COMMAND_TIMEOUT' });
  // The shell may still be running; its marker remains the readiness signal for this pane.
  expect(dispose).not.toHaveBeenCalled();
  complete();
  expect(dispose).toHaveBeenCalledOnce();
});
