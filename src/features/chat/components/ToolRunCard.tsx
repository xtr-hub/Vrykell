import { useState } from 'react';
import { t, type I18nKey } from '@i18n';
import { AskQuestion, Brain, Check, ChevronRight, FileText, Folder, Globe, Pencil, RefreshCw, Search, TerminalPrompt, Wrench, X } from '@ui/icons';
import ToolOutput from './ToolOutput';
import BlockOutput from '@features/terminal/components/BlockOutput';
import { useBlockStore } from '@features/terminal';
import { agentControl } from '@features/agent/services/agentControl';
import ToolApproval from './ToolApproval';
import ToolQuestion from './ToolQuestion';
import type { ChatEnvironment } from '../model/conversation';
import { environmentForPane } from '../services/conversationContext';
import type { ToolRun, ToolRunState } from '@features/agent/model/messageParts';

const STATE_LABEL: Record<ToolRunState, I18nKey> = {
  'input-pending': 'Awaiting answer',
  running: 'Running',
  'approval-pending': 'Awaiting approval',
  done: 'Completed',
  error: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

function str(value: unknown): string { return typeof value === 'string' ? value : ''; }

function summarize(run: ToolRun): { icon: React.ReactNode; label: string; text: string } {
  const input = run.input;
  const size = { size: 15 };
  switch (run.toolName) {
    case 'ask_user': return { icon: <AskQuestion {...size} />, label: t('Ask the user'), text: str(input.question) };
    case 'run_command': return { icon: <TerminalPrompt {...size} />, label: t('Run command'), text: str(input.command) };
    case 'terminal_keys': return { icon: <TerminalPrompt {...size} />, label: t('Send terminal input'), text: str(input.text) || str(input.keys) };
    case 'read_terminal': return { icon: <TerminalPrompt {...size} />, label: t('Read terminal'), text: '' };
    case 'read_file': return { icon: <FileText {...size} />, label: t('Read file'), text: str(input.path) };
    case 'edit_file': return { icon: <Pencil {...size} />, label: t('Edit file'), text: str(input.path) };
    case 'write_file': return { icon: <Pencil {...size} />, label: t('Write file'), text: str(input.path) };
    case 'search_files': return { icon: <Search {...size} />, label: t('Search files'), text: str(input.query) };
    case 'list_dir': return { icon: <Folder {...size} />, label: t('List directory'), text: str(input.path) };
    case 'web_search':
    case 'google_search': return { icon: <Globe {...size} />, label: t('Web search'), text: str(input.query) };
    case 'web_fetch': return { icon: <Globe {...size} />, label: t('Fetch page'), text: str(input.url) };
    case 'think': return { icon: <Brain {...size} />, label: t('Thinking process'), text: '' };
    default: return { icon: <Wrench {...size} />, label: run.toolName, text: str(input.command) || str(input.path) || str(input.query) || str(input.url) || str(input.title) };
  }
}

function commandExitCode(run: ToolRun): number | undefined {
  if (run.toolName !== 'run_command' || !run.output) return undefined;
  try {
    const value: unknown = JSON.parse(run.output);
    if (typeof value !== 'object' || value === null) return undefined;
    const code = (value as Record<string, unknown>).exitCode;
    return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
  } catch { return undefined; }
}

/** Output body shown when a row is expanded; a structured command result carries its own field. */
function expandBody(run: ToolRun): string {
  if (run.toolName === 'run_command' && run.output) {
    try {
      const value: unknown = JSON.parse(run.output);
      if (typeof value === 'object' && value !== null) {
        const output = (value as Record<string, unknown>).output;
        if (typeof output === 'string') return output;
      }
    } catch { /* Unstructured output is displayed verbatim. */ }
  }
  return run.output || run.error || '';
}

function CommandOutputBlock({ run, paneId, framed }: { run: ToolRun; paneId?: string; framed: boolean }) {
  const block = useBlockStore(state => {
    const id = agentControl.blockForToolCall(run.toolCallId);
    return id && paneId ? state.byTab[paneId]?.find(item => item.id === id) : undefined;
  });
  const body = expandBody(run);
  const running = run.state === 'running';
  const text = block?.outputText || body;
  return <ToolOutput framed={framed} text={text}>
    <div className="ai-tool-output">
      {block?.outputHtml ? <BlockOutput text={block.outputHtml} isHtml flush={framed} />
        : text ? <BlockOutput text={text} flush={framed} />
          : <span>{t(running ? 'Command running…' : 'No output')}</span>}
    </div>
  </ToolOutput>;
}

/**
 * Tool status, approval, input and output share one disclosure card in the exchange.
 * `framed` marks the chat panel presentation, where expanded output sits inside the
 * shared code-block frame and therefore drops its own terminal surface.
 */
export default function ToolRunCard({ run, paneId, framed = false, conversationId, environment, onAskAboutTool }: { run: ToolRun; paneId?: string; framed?: boolean; conversationId?: string; environment?: ChatEnvironment; onAskAboutTool?: (question: string) => void }) {
  const [toggled, setToggled] = useState<{ state: ToolRunState; open: boolean } | null>(null);
  const problem = run.state === 'error' || run.state === 'denied';
  const { icon, label, text } = summarize(run);
  const pending = run.state === 'approval-pending' || run.state === 'input-pending';
  const summaryTarget = run.state === 'approval-pending' ? environment ?? (paneId ? environmentForPane(paneId) : null) : null;
  const targetAddress = summaryTarget?.ssh
    ? `${summaryTarget.ssh.user ? `${summaryTarget.ssh.user}@` : ''}${summaryTarget.ssh.host}:${summaryTarget.ssh.port ?? 22}`
    : summaryTarget?.cwd;
  const summaryText = run.state === 'approval-pending'
    ? [summaryTarget?.label, targetAddress].filter(Boolean).join(' · ') || t('No execution terminal selected')
    : pending ? '' : text;
  const exitCode = commandExitCode(run);
  const status = exitCode !== undefined && (run.state === 'done' || run.state === 'error')
    ? t('Exit code {{code}}', { code: exitCode }) : t(STATE_LABEL[run.state]);
  const body = expandBody(run);
  const isCommand = run.toolName === 'run_command';
  const open = toggled?.state === run.state ? toggled.open : false;
  const input = JSON.stringify(run.input, null, 2);
  const expandable = problem || run.toolName !== 'ask_user' && (isCommand || Object.keys(run.input).length > 0 || body.length > 0);
  const truncated = body.length > 6000;
  return <div className="ai-tool-card" data-tool-state={run.state} data-open={open}>
    <button type="button" data-subtle className="ai-tool-summary" aria-label={[label, summaryText, status].filter(Boolean).join(' ')} aria-expanded={open} disabled={!expandable || pending}
      onClick={() => setToggled({ state: run.state, open: !open })}>
      {icon}<span className="ai-tool-summary-text">
        <span className="ai-tool-label">{label}</span><span className="ai-tool-description" data-tip={summaryText || undefined}>{summaryText}</span>
      </span>
      <span className="ai-tool-state" data-state={run.state}>
        {run.state === 'done' ? <Check size={12} /> : run.state === 'running' ? <RefreshCw size={12} className="reload-spin" />
          : (problem || run.state === 'cancelled') ? <X size={12} /> : null}{status}
      </span>
      {expandable && !pending && <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />}
    </button>
    {run.toolName === 'ask_user' && <ToolQuestion run={run} conversationId={conversationId} />}
    {run.state === 'approval-pending' && <ToolApproval run={run} conversationId={conversationId} onAskAboutTool={onAskAboutTool} />}
    {open && <div className="ai-tool-details">
      {problem && <div className="ai-tool-verdict" role="status">
        {run.state === 'denied' ? run.danger || run.error || t('Denied') : run.error || t('Tool execution failed')}
      </div>}
      <div className="ai-tool-section-label">{t('Tool input')}</div>
      <pre className="ai-tool-input" data-selectable>{input}</pre>
      <div className="ai-tool-section-label">{t('Tool output')}</div>
      {isCommand ? <CommandOutputBlock run={run} paneId={paneId} framed={framed} />
          : <ToolOutput framed={framed} text={body}>
            <pre className="ai-tool-output" data-selectable>{truncated ? `${t('Only the end of the output is shown')}\n` : ''}{body.slice(-6000) || t('No output')}</pre>
          </ToolOutput>}
    </div>}
  </div>;
}
