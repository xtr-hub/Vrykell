/**
 * terminal — live terminal read/write tools (read_terminal / terminal_keys).
 *
 * They let the agent "look at the screen and type keys" like a person, driving full-screen
 * interactive TUIs (editors, pagers, system monitors) well enough to edit files through a
 * terminal editor:
 *   - read_terminal  reads the currently visible screen of the focused terminal (in altScreen it
 *                    reads the alt buffer, i.e. the editor screen)
 *   - terminal_keys  sends a raw key sequence to the focused terminal's PTY (keys only, no Enter)
 *
 * Neither waits for a command to finish (that is run_command's job); typical use:
 *   terminal_keys("editor /path/file.txt\r") → read_terminal() → terminal_keys("i…content…\x1b:wq\r")
 *
 * Convention: never throw — return a structured result so the model can correct itself.
 */

import { tool } from 'ai';
import { t } from '@i18n';
import { DESC_READ_TERMINAL, DESC_TERMINAL_KEYS } from '@features/agent/model/toolTexts';
import { z } from 'zod';
import { ptyWrite } from '@platform/pty';
import {
  getFocusedTerminalId,
  getTerminalScreen,
  useTerminalStore,
  useBlockStore,
} from '@features/terminal';
import { gate, type ToolContext } from '@features/agent/stores/permissions';
import { terminalDisconnected, terminalExecutionState } from '../services/terminalAvailability';

const BLOCK_OUTPUT_CAP = 2000;
const BLOCK_COUNT = 4;
/** Screen-update wait bound; a longer request is clamped instead of rejecting the whole call. */
const MAX_WAIT_MS = 10_000;
const DEFAULT_WAIT_MS = 300;

/** "Live screen" in the block-list scene = the tails of the most recent command blocks (the main terminal surface is idle there). */
function blockListContent(paneId: string): string {
  const blocks = useBlockStore.getState().byTab[paneId] ?? [];
  const withOutput = blocks.filter((b) => b.outputText && b.outputText.trim().length > 0);
  const tail = withOutput.slice(-BLOCK_COUNT);
  if (tail.length === 0) return '（块列表为空，暂无输出）';
  return tail
    .map((b) => `$ ${b.command || '（无命令）'}\n${b.outputText.slice(-BLOCK_OUTPUT_CAP)}`)
    .join('\n\n');
}

export function buildTerminalTools(ctx: ToolContext) {
  return {
    read_terminal: tool({
      description: DESC_READ_TERMINAL,
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) => {
        const g = await gate('read_terminal', {}, toolCallId, ctx);
        if (!g.proceed) return g.result;
        const paneId = ctx.paneId === undefined ? getFocusedTerminalId() : ctx.paneId;
        if (!paneId) return { ok: false, error: t('No execution terminal is connected to this conversation.') };
        const ts = useTerminalStore.getState();
        const disconnected = terminalDisconnected(paneId);
        if (disconnected) return disconnected;
        const screen = ts.scenes[paneId] === 'blockList' ? null : getTerminalScreen(paneId);
        const executionState = terminalExecutionState(paneId);
        if (screen) return { ok: true, ...screen, executionState };
        // No main terminal surface (blockList): compose the "screen" from command block output.
        return {
          ok: true,
          executionState,
          scene: ts.scenes[paneId] ?? 'classic',
          cols: ts.dims[paneId]?.cols ?? 80,
          rows: ts.dims[paneId]?.rows ?? 24,
          cursorY: null,
          cursorX: null,
          content: blockListContent(paneId),
        };
      },
    }),

    terminal_keys: tool({
      description: DESC_TERMINAL_KEYS,
      inputSchema: z.object({
        keys: z.string().default('').describe('Raw keys; escapes such as \\b, \\u0018, \\e, \\u001b[A and \\xNN are decoded; omit to only wait'),
        wait_ms: z.number().int().min(0).optional().describe('Milliseconds to wait for screen updates, default 300; values above 10000 are clamped'),
      }),
      execute: async ({ keys, wait_ms }, { toolCallId }) => {
        const g = await gate('terminal_keys', { keys }, toolCallId, ctx);
        if (!g.proceed) return g.result;
        // Tolerant normalization: the model often adds an extra backslash layer (literal text), so decode everything into real control characters.
        const { keys: normalized, error } = normalizeKeys(keys ?? '');
        if (error) {
          return { ok: false, error };
        }
        if (normalized.length === 0 && !wait_ms) {
          return { ok: false, error: '按键序列为空，请提供要发送的按键' };
        }
        if (normalized.length > 4096) {
          return { ok: false, error: '按键序列过长（>4096 字符），请分段发送' };
        }
        const paneId = ctx.paneId === undefined ? getFocusedTerminalId() : ctx.paneId;
        if (!paneId) return { ok: false, error: t('No execution terminal is connected to this conversation.') };
        const sessionId = useTerminalStore.getState().sessions[paneId];
        const disconnected = terminalDisconnected(paneId);
        if (disconnected || !sessionId) return disconnected ?? terminalDisconnected(paneId)!;
        try {
          if (normalized.length > 0) await ptyWrite(sessionId, normalized);
        } catch (e) {
          const disconnected = terminalDisconnected(paneId, sessionId);
          if (disconnected) return disconnected;
          return { ok: false, error: `写入终端失败: ${e instanceof Error ? e.message : String(e)}` };
        }
        const wait = Math.min(wait_ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const interrupted = terminalDisconnected(paneId, sessionId);
        if (interrupted) return interrupted;
        return {
          ok: true,
          sent: normalized.length,
          decoded: normalized,
          ...(normalized.length === 0 ? { waited_ms: wait } : {}),
          scene: useTerminalStore.getState().scenes[paneId] ?? 'classic',
        };
      },
    }),
  };
}

/**
 * Tolerantly normalize the key string written by the model: decode "literal escapes" (text with an
 * extra backslash layer, such as "\\u0018", "\\b", "\\e") into real control characters; any escape
 * still unrecognized (such as "\uZZZZ") returns an error and is never sent verbatim.
 */
function normalizeKeys(raw: string): { keys: string; error?: string } {
  const keys = raw
    // Literal \uXXXX → character (for example \\u0018 → Ctrl+X)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    // Literal \xNN → character (for example \\x1b → Esc)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    // Literal \e → Esc
    .replace(/\\e/g, '\u001b')
    // Literal JSON escapes (the model often adds an extra backslash)
    .replace(/\\b/g, '\b')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\f/g, '\f');
  // Validate: any remaining \u/\x is necessarily a malformed escape (such as \uZZZZ / \xGG), so report an error instead of sending it verbatim.
  const m = /\\u(?![0-9a-fA-F]{4})/.exec(keys) ?? /\\x(?![0-9a-fA-F]{2})/.exec(keys);
  if (m) {
    return {
      keys,
      error:
        `无效转义序列「${m[0]}…」：控制字符请用 \\uXXXX（如 \\u0018）或 \\xNN（如 \\x1b）表达，` +
        '或直接写可见字符；工具不会发送无法识别的转义',
    };
  }
  return { keys };
}
