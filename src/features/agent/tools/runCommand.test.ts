/**
 * runCommandAndWait tests: mock the PTY boundary and drive block lifecycles through the real
 * blockStore. Covers block-mode completion (exit code + agent mark), no session, altScreen
 * rejection and timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@platform/pty', () => ({
  ptyWrite: vi.fn(async () => {}),
}));

import { runCommandAndWait } from '@features/agent/tools/runCommand';
import { ptyWrite } from '@platform/pty';
import { Terminal } from '@xterm/xterm';
import { writeTerminalInput } from '@features/terminal/services/terminalWriteQueue';
import { setPendingCommandRegistrar } from '@features/terminal/services/pendingCommandRegistry';
import { clearCompletionReadiness } from '@features/terminal/services/commandCompletion';
import { registerTerminal, unregisterTerminal } from '@features/terminal/stores/terminal';
import { terminalCommandReady } from '@features/agent/services/terminalAvailability';
import { useBlockStore } from '@features/terminal/stores/blocks';
import { useTerminalStore } from '@features/terminal/stores/terminal';
import { useSessionStore } from '@features/workspace';
import { agentControl } from '@features/agent/services/agentControl';
import type { TermBlock } from '@features/terminal/services/pipeline/termBlock';

const initialBlocks = useBlockStore.getState();
const initialTerm = useTerminalStore.getState();
const initialWs = useSessionStore.getState();

function setupPane(): string {
  // Simulate an active tab after startup (the store no longer seeds an initial tab)
  useSessionStore.getState().addTab({});
  const tabId = useSessionStore.getState().activeId;
  const paneId = `${tabId}#0`;
  useTerminalStore.setState((s) => ({ sessions: { ...s.sessions, [paneId]: 'pty-1' } }));
  return paneId;
}

function mkBlock(p: Partial<TermBlock>): TermBlock {
  return {
    id: 'b1',
    command: 'ls',
    status: 'executing',
    exitCode: null,
    // The claim criterion is startedAt >= call time t0 (preexec runs after the write); default to
    // "now" to simulate a just-started command, and pass an explicit small timestamp for older blocks
    startedAt: Date.now(),
    endedAt: null,
    wasLongRunning: false,
    outputHtml: '',
    outputText: '',
    outputRaw: '',
    linesTruncated: 0,
    ...p,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runCommandAndWait', () => {
  it('does not write a queued command after its turn was cancelled', async () => {
    const paneId = setupPane();
    let release!: () => void;
    vi.mocked(ptyWrite).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const earlier = writeTerminalInput('pty-1', 'earlier input');
    const controller = new AbortController();
    const clearPending = vi.fn();
    setPendingCommandRegistrar(() => clearPending);
    const pending = runCommandAndWait('echo cancelled', { paneId, signal: controller.signal });
    controller.abort();
    release();
    await earlier;
    await expect(pending).resolves.toMatchObject({ ok: false, completed: false, code: 'COMMAND_ABORTED' });
    expect(vi.mocked(ptyWrite).mock.calls.filter(([, data]) => data.includes('cancelled'))).toEqual([]);
    expect(clearPending).toHaveBeenCalledOnce();
  });

  it('reschedules completion after a later statement outlives the snapshot grace period', async () => {
    vi.useFakeTimers();
    const paneId = setupPane();
    const pending = runCommandAndWait('first\nsecond', { paneId });
    await vi.advanceTimersByTimeAsync(0);
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'first', command: 'first' }));
    useBlockStore.getState().updateBlock(paneId, 'first', { status: 'done', exitCode: 0 });
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'second', command: 'second' }));
    await vi.advanceTimersByTimeAsync(400);
    useBlockStore.getState().updateBlock(paneId, 'second', { status: 'done', exitCode: 0, outputText: 'complete' });
    await vi.advanceTimersByTimeAsync(350);
    await expect(pending).resolves.toMatchObject({ ok: true, completed: true, output: expect.stringContaining('complete') });
  });
  it('reports a disconnected execution target before sending a command', async () => {
    const result = await runCommandAndWait('echo test', { paneId: 'missing' });
    expect(result).toMatchObject({ ok: false, completed: false, code: 'TERMINAL_DISCONNECTED', requiresUserAction: true });
  });

  it.each(['closed', 'replacement'])('settles immediately when the execution target becomes %s', async state => {
    const paneId = setupPane();
    const pending = runCommandAndWait('echo test', { paneId });
    await tick();
    useTerminalStore.setState({ sessions: state === 'closed' ? {} : { [paneId]: 'different-process' } });
    await expect(pending).resolves.toMatchObject({ ok: false, completed: false, code: 'TERMINAL_DISCONNECTED', requiresUserAction: true });
  });
  beforeEach(() => {
    useBlockStore.setState(initialBlocks, true);
    useTerminalStore.setState(initialTerm, true);
    useSessionStore.setState(initialWs, true);
  });
  afterEach(() => {
    vi.useRealTimers();
    setPendingCommandRegistrar(null);
  });

  it('block mode: a new block turns done -> returns the exit code and output, and the block receives the agent mark', async () => {
    const paneId = setupPane();
    const promise = runCommandAndWait('ls');
    await tick(); // let ptyWrite settle and the subscription attach
    expect(agentControl.isControlled(paneId)).toBe(true);

    useBlockStore.getState().addBlock(paneId, mkBlock({}));
    await tick();
    // claiming sets the projection mark
    expect(useBlockStore.getState().byTab[paneId]![0]!.agent).toBe(true);

    useBlockStore.getState().updateBlock(paneId, 'b1', {
      status: 'done',
      exitCode: 0,
      endedAt: 2,
      outputText: 'a.txt\nb.txt',
    });
    const r = await promise;
    expect(r).toMatchObject({ ok: true, exitCode: 0, output: 'a.txt\nb.txt' });
    expect(agentControl.isControlled(paneId)).toBe(false);
  });

  // Regression: one submitted script can become several blocks (PowerShell runs a multi-line
  // script statement by statement). Returning a single block handed the model just its last line.
  it('block mode: returns every block command and output when a multi-line script splits into several blocks', async () => {
    const paneId = setupPane();
    const promise = runCommandAndWait('$f = "x"\nSet-Content $f "hi"\nRemove-Item $f -Force');
    await tick();

    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b1', command: '$f = "x"' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b1', { status: 'done', exitCode: 0 });
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b2', command: 'Set-Content $f "hi"' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b2', { status: 'done', exitCode: 0, outputText: '写入完成' });
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b3', command: 'Remove-Item $f -Force' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b3', { status: 'done', exitCode: 0, outputText: '删除成功' });

    await new Promise((r) => setTimeout(r, 400));
    const r = await promise;
    expect(r).toMatchObject({ ok: true, completed: true, exitCode: 0 });
    expect(r.output).toContain('$ $f = "x"');
    expect(r.output).toContain('$ Set-Content $f "hi"\n写入完成');
    expect(r.output).toContain('$ Remove-Item $f -Force\n删除成功');
    for (const id of ['b1', 'b2', 'b3']) expect(agentControl.hasBlock(id)).toBe(true);
  });

  it('block mode: blocks outside this submission do not count toward the result', async () => {
    const paneId = setupPane();
    const promise = runCommandAndWait('echo mine');
    await tick();
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'mine', command: 'echo mine' }));
    // A command the user typed concurrently: not part of this submission, so it must not join
    // the result the model sees.
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'user', command: 'git status' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'mine', { status: 'done', exitCode: 0, outputText: 'mine' });
    useBlockStore.getState().updateBlock(paneId, 'user', { status: 'done', exitCode: 0, outputText: 'user output' });

    await new Promise((r) => setTimeout(r, 400));
    const r = await promise;
    expect(r.output).toBe('mine');
    expect(agentControl.hasBlock('user')).toBe(false);
    expect(agentControl.hasBlock('mine')).toBe(true);
  });

  it('block mode: one failing step among several -> ok:false with that step exit code', async () => {    const paneId = setupPane();
    const promise = runCommandAndWait('step one\nstep two');
    await tick();
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b1', command: 'step one' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b1', { status: 'done', exitCode: 0, outputText: 'ok' });
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b2', command: 'step two' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b2', { status: 'done', exitCode: 3, outputText: 'missing' });

    await new Promise((r) => setTimeout(r, 400));
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(3);
    expect(r.error).toContain('3');
  });

  it('keeps the head and tail of oversized output and marks the omission', async () => {
    const paneId = setupPane();
    const promise = runCommandAndWait('big');
    await tick();
    useBlockStore.getState().addBlock(paneId, mkBlock({ id: 'b1', command: 'big' }));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b1', {
      status: 'done',
      exitCode: 0,
      outputText: `HEAD-MARKER\n${'x'.repeat(20_000)}\nTAIL-MARKER`,
    });

    await new Promise((r) => setTimeout(r, 400));
    const r = await promise;
    expect(r.output).toContain('HEAD-MARKER');
    expect(r.output).toContain('TAIL-MARKER');
    expect(r.output).toContain('字符已省略');
    expect(r.output.length).toBeLessThan(8300);
  });

  it('block mode: nonzero exit code -> ok:false with an error description', async () => {    const paneId = setupPane();
    const promise = runCommandAndWait('ls');
    await tick();
    useBlockStore.getState().addBlock(paneId, mkBlock({}));
    await tick();
    useBlockStore.getState().updateBlock(paneId, 'b1', {
      status: 'done',
      exitCode: 2,
      endedAt: 2,
      outputText: 'No such file',
    });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.error).toContain('2');
  });

  it('no terminal session -> structured error (never throws)', async () => {
    const r = await runCommandAndWait('ls');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有可用的终端会话');
  });

  it('altScreen fullscreen app -> refuses execution', async () => {
    const paneId = setupPane();
    useTerminalStore.setState((s) => ({ scenes: { ...s.scenes, [paneId]: 'altScreen' } }));
    const r = await runCommandAndWait('ls');
    expect(r).toMatchObject({ ok: false, code: 'TERMINAL_INTERACTIVE' });
    expect(r.error).toContain('altScreen');
  });

  it('timeout -> returns partial output with a timeout description', async () => {
    vi.useFakeTimers();
    setupPane();
    const promise = runCommandAndWait('sleep 999', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, completed: false, code: 'COMMAND_TIMEOUT' });
    expect(r.error).toContain('超时');
  });

  it('timeout on a classic shell -> a late end marker makes the pane ready for the next command', async () => {
    const tabId = useSessionStore.getState().addTab({ shellType: 'bash' });
    const paneId = `${tabId}#0`;
    useTerminalStore.setState((s) => ({
      sessions: { ...s.sessions, [paneId]: 'pty-classic' },
      startupStates: { ...s.startupStates, [paneId]: 'ready' },
      scenes: { ...s.scenes, [paneId]: 'classic' },
    }));
    const terminal = new Terminal({ cols: 80, rows: 5, scrollback: 100 });
    registerTerminal(paneId, terminal);
    try {
      expect(await runCommandAndWait('sleep 999', { paneId, timeoutMs: 20 })).toMatchObject({ code: 'COMMAND_TIMEOUT' });
      expect(terminalCommandReady(paneId)).toBe(false);

      const payload = vi.mocked(ptyWrite).mock.calls.map(([, data]) => data).join('');
      const token = /777;(command-[^;]+);/.exec(payload)?.[1];
      expect(token).toBeTruthy();
      await new Promise<void>(resolve => terminal.write(`\x1b]777;${token};0\x07`, resolve));
      expect(terminalCommandReady(paneId)).toBe(true);
    } finally {
      clearCompletionReadiness(paneId);
      unregisterTerminal(paneId, terminal);
      terminal.dispose();
    }
  });

  it('never treats a quiet terminal snapshot as successful completion', async () => {
    vi.useFakeTimers();
    setupPane();
    const promise = runCommandAndWait('ls');
    // 1500ms grace (no blocks) -> snapshot mode; completes once output is stable for 2 x 500ms
    await vi.advanceTimersByTimeAsync(3000);
    const r = await promise;
    expect(r).toMatchObject({ ok: false, completed: false, code: 'COMMAND_UNCONFIRMED' });
    expect(r.error).toContain('无法确认');
  });

  it('grace-period self-healing: a block missed by the subscription is claimed by the 1500ms direct scan', async () => {
    vi.useFakeTimers();
    const paneId = setupPane();
    const promise = runCommandAndWait('ls');
    // The block exists and is already done before the subscription attaches (simulating a
    // missed event ordering).
    await vi.advanceTimersByTimeAsync(10);
    useBlockStore.setState((s) => ({
      byTab: {
        ...s.byTab,
        [paneId]: [mkBlock({ status: 'done', exitCode: 0, endedAt: 2, outputText: 'x' })],
      },
    }));
    // setState triggers the subscription (normal claim); the point here is that it does not
    // fall back to snapshot mode.
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;
    expect(r).toMatchObject({ ok: true, exitCode: 0, output: 'x' });
    expect(agentControl.hasBlock('b1')).toBe(true);
  });

  it('regression: an existing pending prompt block is claimed after it turns executing (real lifecycle)', async () => {
    const paneId = setupPane();
    // empty pending block created when the prompt is drawn (133;A) - the future home of this command
    useBlockStore.getState().addBlock(
      paneId,
      mkBlock({ id: 'prompt', command: '', status: 'pending', startedAt: null }),
    );
    const promise = runCommandAndWait('ls');
    await tick();
    // after the write: 133;E/C arrives, the same block turns executing and receives the command
    useBlockStore.getState().updateBlock(paneId, 'prompt', {
      command: 'ls',
      status: 'executing',
      startedAt: Date.now(),
    });
    await tick();
    expect(agentControl.hasBlock('prompt')).toBe(true);

    useBlockStore.getState().updateBlock(paneId, 'prompt', {
      status: 'done',
      exitCode: 0,
      endedAt: Date.now(),
      outputText: 'a.txt\nb.txt',
    });
    const r = await promise;
    expect(r).toMatchObject({ ok: true, exitCode: 0, output: 'a.txt\nb.txt' });
  });

  it('an older same-name block before t0 is not claimed (no new block -> snapshot fallback)', async () => {
    vi.useFakeTimers();
    const paneId = setupPane();
    // the user ran ls by hand an hour ago - it must not be mistaken for our block
    useBlockStore.getState().addBlock(
      paneId,
      mkBlock({ id: 'old', status: 'done', exitCode: 0, startedAt: 1, outputText: 'stale' }),
    );
    const promise = runCommandAndWait('ls');
    await vi.advanceTimersByTimeAsync(3000);
    const r = await promise;
    expect(agentControl.hasBlock('old')).toBe(false);
    expect(r.exitCode).toBeUndefined(); // snapshot mode has no exit code
    expect(r.completed).toBe(false);
    expect(r.error).toContain('无法确认');
  });

  it('switching to altScreen mid-execution (TUI) -> settles immediately instead of waiting for the timeout', async () => {
    vi.useFakeTimers();
    const paneId = setupPane();
    const promise = runCommandAndWait('claude');
    await vi.advanceTimersByTimeAsync(10);
    // the command switches the terminal into fullscreen interaction (a fullscreen TUI)
    useTerminalStore.setState((s) => ({ scenes: { ...s.scenes, [paneId]: 'altScreen' } }));
    const r = await promise;
    expect(r).toMatchObject({ ok: false, code: 'TERMINAL_INTERACTIVE' });
    expect(r.error).toContain('全屏交互界面');
  });

  it('records the toolCall->block mapping on claim (for inline command block rendering)', async () => {
    const paneId = setupPane();
    const promise = runCommandAndWait('ls', { toolCallId: 'tc-1' });
    await tick();
    useBlockStore.getState().addBlock(paneId, mkBlock({}));
    await tick();
    expect(agentControl.blockForToolCall('tc-1')).toBe('b1');
    useBlockStore.getState().updateBlock(paneId, 'b1', {
      status: 'done',
      exitCode: 0,
      endedAt: Date.now(),
      outputText: 'x',
    });
    await promise;
  });
});
