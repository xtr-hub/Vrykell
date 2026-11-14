import { termInstances } from '../stores/terminal';
import type { IMarker, Terminal } from '@xterm/xterm';
import { posixScriptCommand } from '../model/commandSubmission';

export interface ShellCommandCompletion {
  wrap: (command: string) => string;
  result: () => { exitCode: number; output: string } | null;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

interface CompletionRecovery {
  terminal: Terminal;
  ready: boolean;
  dispose: () => void;
}

/** Timed-out submissions whose late completion marker still proves the shell became ready. */
const recoveries = new Map<string, CompletionRecovery>();
/** Bound the retained terminal reference when a marker never arrives or the pane is abandoned. */
const RECOVERY_TTL_MS = 10 * 60_000;

/**
 * A shell can return to the prompt with a carriage return only, leaving the end of the echoed
 * wrapper on the marker row. Strip that echo fragment from the first captured line.
 */
function stripEchoTail(line: string, echoTail: string): string {
  if (!echoTail) return line;
  for (let length = Math.min(line.length, echoTail.length); length >= 2; length--) {
    if (echoTail.endsWith(line.slice(-length))) return line.slice(0, line.length - length);
  }
  return line;
}

/** Use the terminal parser to observe a private completion marker from a POSIX shell. */
export function watchShellCommandCompletion(paneId: string): ShellCommandCompletion | null {
  const terminal = termInstances.get(paneId);
  if (!terminal?.parser) return null;
  const token = `command-${crypto.randomUUID()}`;
  const buffer = terminal.buffer.active;
  let start = buffer.baseY + buffer.cursorY;
  let startColumn = 0;
  let echoTail = '';
  let startMarker: IMarker | undefined;
  let completed: { exitCode: number; output: string } | null = null;
  const listeners = new Set<() => void>();
  const handler = terminal.parser.registerOscHandler(777, data => {
    const [id, status] = data.split(';');
    if (id !== token) return false;
    if (status === 'start') {
      const active = terminal.buffer.active;
      start = active.baseY + active.cursorY;
      startColumn = active.cursorX;
      const row = active.getLine(start)?.translateToString(true) ?? '';
      echoTail = (active.cursorX > 0 ? row.slice(0, active.cursorX) : row).trimEnd();
      startMarker?.dispose();
      startMarker = terminal.registerMarker(0);
      return true;
    }
    if (!status || !/^\d+$/.test(status)) return false;
    const active = terminal.buffer.active;
    const end = active.baseY + active.cursorY;
    const lines: string[] = [];
    const markerLine = startMarker && !startMarker.isDisposed ? startMarker.line : null;
    const first = markerLine ?? (startMarker ? Math.max(0, end - 200) : start);
    for (let row = Math.max(first, end - 200); row <= end; row++) {
      const line = active.getLine(row)?.translateToString(true) ?? '';
      if (line.includes(token)) continue;
      const slice = row === first ? line.slice(startColumn) : line;
      const text = row === first && markerLine !== null ? stripEchoTail(slice, echoTail) : slice;
      if (row === first && slice && !text) continue;
      lines.push(text);
    }
    completed = { exitCode: Number(status), output: lines.join('\n').trimEnd() };
    for (const listener of listeners) listener();
    return true;
  });
  return {
    // Keep execution and status capture in one shell statement, before prompt hooks can run.
    wrap: command => `printf '\\033]777;${token};start\\007'; ${posixScriptCommand(command)}; printf '\\033]777;${token};%s\\007' "$?"\n`,
    result: () => completed,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => { handler.dispose(); startMarker?.dispose(); listeners.clear(); },
  };
}

/**
 * Keep listening after a command stops waiting: the end marker still proves that the shell
 * reached a prompt again, so the command queue can lift a soft block without a new turn.
 */
export function retainCompletionForReadiness(paneId: string, completion: ShellCommandCompletion): void {
  clearCompletionReadiness(paneId);
  const terminal = termInstances.get(paneId);
  if (!terminal) { completion.dispose(); return; }
  const entry: CompletionRecovery = { terminal, ready: false, dispose: () => {} };
  let unsubscribe = () => {};
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    if (!completion.result()) return;
    entry.ready = true;
    unsubscribe();
    completion.dispose();
  };
  unsubscribe = completion.subscribe(settle);
  entry.dispose = () => {
    if (expiry !== null) clearTimeout(expiry);
    expiry = null;
    unsubscribe();
    completion.dispose();
  };
  recoveries.set(paneId, entry);
  expiry = setTimeout(() => clearCompletionReadiness(paneId), RECOVERY_TTL_MS);
  settle();
}

/** Whether a retained completion marker confirmed that the shell is safe for another write. */
export function completionRecoveryReady(paneId: string): boolean {
  const entry = recoveries.get(paneId);
  if (!entry) return false;
  if (termInstances.get(paneId) !== entry.terminal) {
    entry.dispose();
    recoveries.delete(paneId);
    return false;
  }
  return entry.ready;
}

/** A new submission owns the terminal again; its own completion marker replaces the old one. */
export function clearCompletionReadiness(paneId: string): void {
  const entry = recoveries.get(paneId);
  if (!entry) return;
  entry.dispose();
  recoveries.delete(paneId);
}
