import { t, type I18nKey } from '@i18n';
import type { ModelMessage } from 'ai';

/**
 * Transcript parts preserve text/tool order and complete model results in the existing
 * message storage column. Plain-text answers leave parts undefined. The display preview
 * is independent of the complete result used to recreate model history.
 */

export type ToolRunState = 'approval-pending' | 'input-pending' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export const DEFAULT_TOOL_COMMAND_TIMEOUT_MS = 120_000;

export interface ToolRun {
  toolCallId: string;
  toolName: string; // 'run_command' | 'read_file' | ...
  input: Record<string, unknown>;
  state: ToolRunState;
  /** Bounded display preview; complete results belong to modelOutput. */
  output?: string;
  /** Complete serialized result for model history, independent of the display preview. */
  modelOutput?: string;
  providerExecuted?: boolean;
  error?: string;
  /** Reason a dangerous command matched (shown as a warning on the approval card); run_command only. */
  danger?: string;
  /** Backend-derived command shape (for example `npm run`); the approval card can allow only it. */
  shape?: string;
  startedAt: number;
  endedAt?: number;
}

export type MessagePart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolRun };

/**
 * Recreate earlier Agent-mode results as plain text for chat mode. Sending structured
 * `tool_calls` while no tools are registered invites the model to call them again and some
 * providers reject that history, so discussion history keeps the evidence but not the schema.
 */
export function partsToDiscussionText(content: string, parts?: MessagePart[]): string {
  if (!parts?.some(part => part.kind === 'tool')) return content;
  const blocks: string[] = [];
  let hasText = false;
  for (const part of parts) {
    if (part.kind === 'text') {
      if (!part.text) continue;
      blocks.push(part.text);
      hasText = true;
      continue;
    }
    const run = part.tool;
    blocks.push(`[Earlier tool call in Agent mode: ${run.toolName} (${run.state})]`);
    const result = run.modelOutput ?? run.output ?? run.error;
    if (result) blocks.push(result);
  }
  if (!hasText && content) blocks.push(content);
  return blocks.join('\n\n');
}

/** Recreate standard call/result pairs in transcript order; history never executes a tool. */
export function partsToModelMessages(content: string, parts?: MessagePart[]): ModelMessage[] {
  if (!parts?.some(part => part.kind === 'tool')) return [{ role: 'assistant', content }];
  const messages: ModelMessage[] = [];
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text) messages.push({ role: 'assistant', content: part.text });
      continue;
    }
    const run = part.tool;
    if (!run.toolCallId || !run.toolName || ids.has(run.toolCallId)) continue;
    ids.add(run.toolCallId);
    const value = run.modelOutput ?? run.output ?? run.error ?? 'This call was interrupted. No completed result is available.';
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: run.toolCallId,
      toolName: run.toolName, input: run.input, ...(run.providerExecuted ? { providerExecuted: true } : {}) }] });
    messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: run.toolCallId, toolName: run.toolName,
      output: { type: run.state === 'error' ? 'error-text' : 'text', value } }] });
  }
  return messages;
}

/** Parts to the stored string; empty or undefined becomes '' (compact and identical to old data). */
export function serializeParts(parts?: MessagePart[]): string {
  return parts && parts.length > 0 ? JSON.stringify(parts) : '';
}

/** Stored string to parts; '', malformed JSON or a non-array becomes undefined (plain-text rendering). */
export function deserializeParts(raw: string): MessagePart[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0) return undefined;
    const valid = v.every((part: unknown) => {
      if (!part || typeof part !== 'object' || !('kind' in part)) return false;
      if (part.kind === 'text') return 'text' in part && typeof part.text === 'string';
      if (part.kind !== 'tool' || !('tool' in part) || !part.tool || typeof part.tool !== 'object') return false;
      const run = part.tool as Record<string, unknown>;
      return typeof run.toolCallId === 'string' && typeof run.toolName === 'string' && typeof run.startedAt === 'number'
        && typeof run.state === 'string' && ['approval-pending', 'input-pending', 'running', 'done', 'error', 'denied', 'cancelled'].includes(run.state)
        && !!run.input && typeof run.input === 'object' && !Array.isArray(run.input)
        && ['output', 'modelOutput', 'error', 'danger', 'shape'].every(key => run[key] === undefined || typeof run[key] === 'string');
    });
    if (!valid) return undefined;
    return v as MessagePart[];
  } catch {
    return undefined;
  }
}

const TOOL_LABEL: Record<string, I18nKey> = {
  run_command: 'Execute command',
  read_file: 'Read file',
  edit_file: 'Edit file',
  write_file: 'Write file',
  search_files: 'Search',
  list_dir: 'List directory',
  web_search: 'Web search',
  google_search: 'Web search',
  web_fetch: 'Fetch page',
  web_crawl: 'Crawl pages',
  read_terminal: 'Read terminal',
  terminal_keys: 'Terminal keys',
  use_skill: 'Use skill',
  install_skill: 'Install skill',
  mcp: 'MCP tool',
  memory: 'Memory tool',
  think: 'Think',
};

const STATE_LABEL: Record<ToolRunState, I18nKey> = {
  'input-pending': 'Awaiting answer',
  'approval-pending': 'Awaiting approval',
  running: 'Running',
  done: 'Succeeded',
  error: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

/** Build a compact display/export summary; model history uses full call/result pairs. */
export function partsToHistoryText(parts?: MessagePart[]): string {
  if (!parts) return '';
  const lines: string[] = [];
  for (const p of parts) {
    if (p.kind !== 'tool') continue;
    const label = TOOL_LABEL[p.tool.toolName] ? t(TOOL_LABEL[p.tool.toolName]!) : p.tool.toolName;
    if (p.tool.toolName === 'ask_user') {
      lines.push(`[${t('Ask the user')}: ${String(p.tool.input.question ?? '').slice(0, 2000)} → ${t(STATE_LABEL[p.tool.state])}]`);
      try {
        const result: unknown = JSON.parse(p.tool.output ?? '{}');
        if (result && typeof result === 'object' && 'answer' in result && typeof result.answer === 'string') lines.push(`${t('Your answer')}: ${result.answer.slice(0, 4000)}`);
      } catch { continue; }
      continue;
    }
    const target =
      typeof p.tool.input.command === 'string'
        ? p.tool.input.command
        : typeof p.tool.input.path === 'string'
          ? p.tool.input.path
          : typeof p.tool.input.query === 'string'
            ? p.tool.input.query
            : '';
    lines.push(
      `[${label}${target ? `: ${target}` : ''} → ${t(STATE_LABEL[p.tool.state])}]`,
    );
  }
  return lines.length > 0 ? '\n' + lines.join('\n') : '';
}
