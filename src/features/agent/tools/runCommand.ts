/**
 * Execute against the captured terminal target and return structured results.
 * Integrated shells complete through command blocks; classic POSIX shells use
 * private markers parsed by the existing terminal. Quiet output is unconfirmed.
 * Cancellation and timeout stop waiting without terminating the terminal process.
 */

import { writeTerminalCommand } from '@features/terminal/services/commandSubmission';
import { t } from '@i18n';
import { executionPaneSpec } from '../services/executionTarget';
import { diagnostic } from '@platform/diagnostics';
import {
  useTerminalStore,
  useBlockStore,
  getFocusedTerminalId,
  getRecentOutputFor,
  watchShellCommandCompletion,
  retainCompletionForReadiness,
  clearCompletionReadiness,
  type ShellCommandCompletion,
} from '@features/terminal';
import { agentControl } from '@features/agent/services/agentControl';
import { DEFAULT_TOOL_COMMAND_TIMEOUT_MS } from '../model/messageParts';
import { terminalDisconnected, terminalExecutionState } from '../services/terminalAvailability';

export interface RunCommandResult {
  ok: boolean;
  /** Only present in block mode; undefined on snapshot and error paths. */
  exitCode?: number;
  /** Tail of the output (≤8KB). */
  output: string;
  error?: string;
  completed?: boolean;
  /** Stable reason for machine decisions: timeout, busy, interactive, aborted, disconnected. */
  code?: string;
  requiresUserAction?: boolean;
}

const OUTPUT_CAP = 8192;
/** Head kept when output has to be shortened: command echo, paths and early lines live there. */
const OUTPUT_HEAD = 2048;
const BLOCK_GRACE_MS = 1500;

function tail(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s;
}

/**
 * Shorten long output to the head and the tail with an explicit gap marker. The head keeps paths
 * and early failures visible to the model, and the marker states what was omitted so the model
 * does not re-run the command just to see the beginning.
 */
function capOutput(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  const omitted = s.length - OUTPUT_HEAD - (OUTPUT_CAP - OUTPUT_HEAD);
  return `${s.slice(0, OUTPUT_HEAD)}\n…（中间 ${omitted} 字符已省略，可用 read_terminal 查看终端画面）…\n${s.slice(-(OUTPUT_CAP - OUTPUT_HEAD))}`;
}

export async function runCommandAndWait(
  command: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; toolCallId?: string; paneId?: string | null },
): Promise<RunCommandResult> {
  const paneId = opts?.paneId === undefined ? getFocusedTerminalId() : opts.paneId;
  if (!paneId) return { ok: false, output: '', error: t('No execution terminal is connected to this conversation.') };
  const ts = useTerminalStore.getState();
  const disconnected = terminalDisconnected(paneId);
  if (disconnected) return disconnected;
  const sessionId = ts.sessions[paneId];
  if (!sessionId) {
    return terminalDisconnected(paneId)!;
  }
  if (opts?.signal?.aborted) return { ok: false, completed: false, output: '', code: 'COMMAND_ABORTED', error: t('Command cancelled before execution.') };
  const executionState = terminalExecutionState(paneId);
  if (executionState === 'busy') {
    return { ok: false, completed: false, output: '', code: 'TERMINAL_BUSY', error: t('The terminal is busy. Use read_terminal to inspect it before sending another command.') };
  }
  if (executionState === 'interactive') {
    return {
      ok: false,
      code: 'TERMINAL_INTERACTIVE',
      output: '',
      error:
        '终端正在运行全屏应用（altScreen，如 vim/htop）。run_command 只用于非交互命令；' +
        '若需驱动这个全屏程序，请改用 read_terminal（看画面）+ terminal_keys（发按键）。',
    };
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TOOL_COMMAND_TIMEOUT_MS;
  // Claim baseline: the pending prompt block that already exists before the write is where this
  // command will live (the block is created when the prompt is drawn, at 133;A), so claiming on
  // "a new block" is not enough — startedAt >= t0 (the preexec instant) also covers the path where
  // an old pending block turns executing.
  const t0 = Date.now();

  const pane = executionPaneSpec(paneId);
  const posix = pane?.kind === 'ssh' || ['bash', 'zsh', 'sh'].includes(pane?.shellType ?? '');
  const completion = ts.scenes[paneId] === 'classic' && posix ? watchShellCommandCompletion(paneId) : null;
  clearCompletionReadiness(paneId);
  let retainedCompletion = false;
  agentControl.acquire(paneId);
  diagnostic('agent-command-start', { paneId, completionMode: completion ? 'marker' : 'block' });
  try {
    await writeTerminalCommand(paneId, sessionId, completion ? completion.wrap(command) : command, undefined, opts?.signal);
    const result = await waitForCompletion(paneId, sessionId, command, t0, opts?.toolCallId, opts?.signal, timeoutMs, completion);
    // A timed-out shell keeps running; its marker still tells us when the prompt returns, so the
    // queue can recover in the same turn instead of waiting for a new message.
    if (completion && (result.code === 'COMMAND_TIMEOUT' || result.code === 'COMMAND_UNCONFIRMED')) {
      // Already-arrived markers settle immediately; pending ones stay watched until the prompt returns.
      retainCompletionForReadiness(paneId, completion);
      retainedCompletion = true;
    }
    diagnostic('agent-command-completion', { paneId, completed: result.completed ?? false, ok: result.ok, exitCode: result.exitCode, outputChars: result.output.length });
    return result;
  } catch (e) {
    if (opts?.signal?.aborted) return { ok: false, completed: false, output: '', code: 'COMMAND_ABORTED', error: t('Stopped waiting. The command may still be running in the terminal.') };
    const disconnected = terminalDisconnected(paneId, sessionId);
    if (disconnected) return disconnected;
    return { ok: false, completed: false, output: '', code: 'TERMINAL_WRITE_FAILED', error: t('Could not write to the terminal: {{error}}', { error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    if (!retainedCompletion) completion?.dispose();
    agentControl.release(paneId);
  }
}

function waitForCompletion(
  paneId: string,
  sessionId: string,
  command: string,
  t0: number,
  toolCallId: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  completion: ShellCommandCompletion | null,
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * Blocks this submission produced, in start order. A shell that splits a multi-statement
     * script into one block per statement (PowerShell in block mode does) must not be reduced
     * to a single block: doing so returned just the last statement's line to the model.
     */
    const tracked: string[] = [];

    let doneGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubCompletion: (() => void) | undefined;

    const finish = (r: RunCommandResult) => {
      if (settled) return;
      settled = true;
      unsub?.();
      unsubScene?.();
      unsubCompletion?.();
      signal?.removeEventListener('abort', onAbort);
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (doneGraceTimer) clearTimeout(doneGraceTimer);
      clearTimeout(graceTimer);
      clearTimeout(timeoutTimer);
      resolve(r);
    };

    /** Switching into a full-screen TUI mid-run (for example the model launched a full-screen
     *  program despite the description) settles immediately instead of waiting out the 120s timeout;
     *  the program stays in the terminal for the user to operate. */
    const unsubScene = useTerminalStore.subscribe((s) => {
      const disconnected = terminalDisconnected(paneId, sessionId);
      if (disconnected) { finish(disconnected); return; }
      if (s.scenes[paneId] === 'altScreen') {
        finish({
          ok: false,
          code: 'TERMINAL_INTERACTIVE',
          output: '',
          error:
            '命令切入了全屏交互界面（TUI 模式），run_command 无法读取其输出，已停止等待。' +
            '程序仍在终端中运行。若需继续操作这个全屏程序，请用 read_terminal（看画面）+' +
            'terminal_keys（发按键）驱动它，或用非交互式命令（加 --help/--version 等标志或重定向输出）。',
        });
      }
    });

    const blockById = (id: string) => (useBlockStore.getState().byTab[paneId] ?? []).find((x) => x.id === id);
    const isTerminal = (status: string | undefined) => status === 'done' || status === 'interrupted';

    /** Build the result from the tracked blocks (reading their current outputText); a single block
     *  stays as-is, multiple blocks are joined as "command + output". */
    const resultFromBlocks = (): RunCommandResult | null => {
      if (tracked.length === 0) return null;
      const list = tracked.map(blockById);
      if (list.some((b) => !b || !isTerminal(b.status))) return null;
      const blocks = list as NonNullable<ReturnType<typeof blockById>>[];
      const last = blocks[blocks.length - 1]!;
      const failed = blocks.find((b) => b.status === 'interrupted' || (b.exitCode ?? 0) !== 0);
      const body =
        blocks.length === 1
          ? blocks[0]!.outputText
          : blocks.map((b) => `$ ${b.command}${b.outputText ? `\n${b.outputText}` : ''}`).join('\n\n');
      return {
        ok: !failed && last.status === 'done',
        completed: true,
        exitCode: last.exitCode ?? undefined,
        output: capOutput(body),
        error:
          last.status === 'interrupted' || failed?.status === 'interrupted'
            ? '命令被中断'
            : failed?.exitCode
              ? `退出码 ${failed.exitCode}`
              : undefined,
      };
    };

    const settleIfDone = (): void => {
      if (tracked.length === 0 || doneGraceTimer) return;
      if (!resultFromBlocks()) return;
      // finishBlock pushes the done style first, then asynchronously extracts the output snapshot
      // through the terminal emulator write('') FIFO callback (sessionController.finishBlock) — at that moment
      // outputText is usually still ''. Give snapshot extraction a grace period before settling,
      // otherwise the model receives empty output and wrongly concludes the directory is empty.
      doneGraceTimer = setTimeout(() => {
        doneGraceTimer = null;
        const r = resultFromBlocks();
        if (r) finish(r);
      }, 350);
    };

    /** A quiet screen is a snapshot, never evidence of command completion. */
    const startSnapshotMode = () => {
      let last = '';
      let stable = 0;
      snapshotTimer = setInterval(() => {
        const cur = getRecentOutputFor(paneId, 30);
        if (cur === last) {
          stable += 1;
          if (stable >= 2) {
            finish({ ok: false, completed: false, output: tail(cur), code: 'COMMAND_UNCONFIRMED', error: t('Command completion could not be confirmed. This is a terminal snapshot; use read_terminal and do not queue more commands until the shell is ready.') });
          }
        } else {
          last = cur;
          stable = 0;
        }
      }, 500);
    };

    /** Claim a block: register the source of truth + record the toolCall→block mapping (for
     *  embedded command block rendering) + apply an updateBlock immediately so the badge shows up. */
    const claim = (blockId: string) => {
      if (tracked.includes(blockId)) return;
      tracked.push(blockId);
      agentControl.markBlock(blockId);
      if (toolCallId) agentControl.linkToolCall(toolCallId, blockId);
      useBlockStore.getState().updateBlock(paneId, blockId, { agent: true });
    };

    /** Command echoes to expect for this submission: the whole command plus each non-empty line
     *  (a multi-line script is split into one block per statement). */
    const submitted = new Set(
      [command.trim(), ...command.split('\n').map((line) => line.trim()).filter(Boolean)],
    );

    /** Collect every block produced by this submission, in start order; unrelated blocks
     *  (concurrent user input) are not merged in. */
    const collectBlocks = (): void => {
      const blocks = useBlockStore.getState().byTab[paneId] ?? [];
      for (const b of blocks) {
        if (b.startedAt == null || b.startedAt < t0) continue;
        const echo = b.command.trim();
        // Missing echo (shell integration did not provide 133;E): treat the echo as empty.
        if (echo && !submitted.has(echo)) continue;
        claim(b.id);
      }
    };

    /** First-block claim: prefer a block whose command echo matches exactly, otherwise take the
     *  earliest block from this submission (fallback when the echo is missing). */
    const tryClaim = (): void => {
      if (tracked.length > 0) return;
      const blocks = useBlockStore.getState().byTab[paneId] ?? [];
      const fresh = blocks.filter((b) => b.startedAt != null && b.startedAt >= t0);
      if (fresh.length === 0) return;
      const exact = fresh.find((b) => b.command.trim() === command.trim());
      const known = fresh.find((b) => {
        const echo = b.command.trim();
        return !echo || submitted.has(echo);
      });
      claim((exact ?? known ?? fresh[0]!).id);
    };

    const graceTimer = setTimeout(() => {
      if (tracked.length === 0) {
        // Self-heal: when the grace period ends, scan directly once, bypassing the subscription
        // (events can be missed because of timing).
        tryClaim();
        collectBlocks();
        settleIfDone();
        if (!settled && tracked.length === 0 && !completion) startSnapshotMode();
      }
    }, BLOCK_GRACE_MS);

    const timeoutTimer = setTimeout(() => {
      const out = getRecentOutputFor(paneId, 30);
      finish({ ok: false, completed: false, output: tail(out), code: 'COMMAND_TIMEOUT', error: t('Command timed out after {{seconds}} seconds. It may still be running; use read_terminal before sending another command. For a scan or build, bound the next attempt with an explicit timeout or run it in the background.', { seconds: Math.round(timeoutMs / 1000) }) });
    }, timeoutMs);

    const onAbort = () => {
      finish({ ok: false, completed: false, output: tail(getRecentOutputFor(paneId, 30)), code: 'COMMAND_ABORTED', error: t('Stopped waiting. The command may still be running in the terminal.') });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Subscribe to the block stream: claim this submission's blocks (tag them as agent) → wait for a terminal state.
    unsub = useBlockStore.subscribe(() => {
      tryClaim();
      collectBlocks();
      settleIfDone();
    });
    const settleCompletion = () => {
      const result = completion?.result();
      if (result) finish({ ok: result.exitCode === 0, completed: true, exitCode: result.exitCode, output: capOutput(result.output),
        ...(result.exitCode !== 0 ? { error: t('Exit code: {{code}}', { code: result.exitCode }) } : {}) });
    };
    unsubCompletion = completion?.subscribe(settleCompletion);
    if (terminalDisconnected(paneId, sessionId)) finish(terminalDisconnected(paneId, sessionId)!);
    else if (signal?.aborted) onAbort();
    else if (useTerminalStore.getState().scenes[paneId] === 'altScreen') {
      finish({ ok: false, completed: false, output: '', code: 'TERMINAL_INTERACTIVE', error: t('The command entered an interactive screen. Use read_terminal and terminal_keys to continue.') });
    } else {
      settleCompletion();
      if (!settled) { tryClaim(); collectBlocks(); settleIfDone(); }
    }
  });
}
