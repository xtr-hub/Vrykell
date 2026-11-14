import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { writeClipboardText } from '@platform/clipboard';
import AiBlock from '../components/AiBlock';
import { useChatStore } from '../stores/chat';
import type { ChatExchange } from '../model/exchanges';
import type { ToolRun } from '@features/agent/model/messageParts';

vi.mock('@platform/clipboard', () => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));

const writeClipboardTextMock = vi.mocked(writeClipboardText);

afterEach(() => {
  cleanup();
  useChatStore.setState({ sendingTabs: [] });
});
const exchange: ChatExchange = { id: 'question', createdAt: 1,
  question: { id: 'question', role: 'user', content: 'Why did the build fail?', createdAt: 1 },
  answer: { id: 'answer', role: 'assistant', content: 'Check the **configuration**.', createdAt: 2 },
};

it.each(['block', 'conversation'] as const)('shows only the output cursor when structured text is streaming in %s presentation', presentation => {
  const { container, rerender } = render(<AiBlock presentation={presentation} exchange={{ ...exchange,
    answer: { ...exchange.answer!, content: '', pending: true, parts: [{ kind: 'text', text: 'The reply is arriving.' }] },
  }} />);
  expect(screen.getByText('The reply is arriving.')).toBeVisible();
  expect(screen.queryByText('处理中')).toBeNull();
  expect(container.querySelectorAll('.ai-pending-cursor')).toHaveLength(1);
  rerender(<AiBlock presentation={presentation} exchange={{ ...exchange,
    answer: { ...exchange.answer!, content: '', pending: false, parts: [{ kind: 'text', text: 'The reply is arriving.' }] },
  }} />);
  expect(container.querySelector('.ai-pending-cursor')).toBeNull();
});

it.each(['', ' \n ', '<|tool_calls_begin|>'])('keeps one waiting indicator when the stream tail has no visible text (%j)', text => {
  const { container } = render(<AiBlock presentation="conversation" exchange={{ ...exchange,
    answer: { ...exchange.answer!, content: '', pending: true, parts: [{ kind: 'text', text }] },
  }} />);
  expect(screen.getByRole('status')).toHaveTextContent('处理中');
  expect(container.querySelectorAll('.ai-pending-cursor')).toHaveLength(1);
});

it('switches between waiting, text output and a tool continuation without duplicate cursors', () => {
  const view = (parts?: import('@features/agent/model/messageParts').MessagePart[]) => <AiBlock presentation="conversation" exchange={{ ...exchange,
    answer: { ...exchange.answer!, content: '', pending: true, parts },
  }} />;
  const { container, rerender } = render(view());
  expect(screen.getByRole('status')).toHaveTextContent('处理中');
  rerender(view([{ kind: 'text', text: 'Checking the project.' }]));
  expect(screen.queryByRole('status')).toBeNull();
  expect(container.querySelectorAll('.ai-pending-cursor')).toHaveLength(1);
  rerender(view([{ kind: 'text', text: 'Checking the project.' }, commandPart]));
  expect(screen.getByRole('status')).toHaveTextContent('处理中');
  expect(container.querySelectorAll('.ai-pending-cursor')).toHaveLength(1);
  rerender(view([{ kind: 'text', text: 'Checking the project.' }, commandPart, { kind: 'text', text: 'The check succeeded.' }]));
  expect(screen.queryByRole('status')).toBeNull();
  expect(container.querySelectorAll('.ai-pending-cursor')).toHaveLength(1);
});

it('keeps sent attachments beneath the question and dismisses previews on outside press and Escape', () => {
  const view = render(<AiBlock presentation="conversation" exchange={{ ...exchange, question: { ...exchange.question!, attachments: [{ id: 'paste', kind: 'paste', name: 'Pasted sample', mime: 'text/plain', size: 11, textContent: 'sample text' }] } }} />);
  const question = view.container.querySelector('.ai-block-question')!;
  expect(question.nextElementSibling).toHaveClass('chat-question-attachments');
  const trigger = screen.getByRole('button', { name: 'Pasted sample' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toHaveTextContent('sample text');
  fireEvent.pointerDown(screen.getByRole('dialog'));
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('shows one copy action without unsupported native mutations for external replies', () => {
  const view = render(<AiBlock exchange={exchange} allowExchangeActions={false} presentation="conversation" />);
  expect(view.container.querySelectorAll('.chat-answer-actions')).toHaveLength(1);
  expect(screen.getByTestId('chat-answer-copy')).toBeVisible();
  expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑并重发' })).toBeNull();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
});

it('keeps failed replies in their exchange when restored instead of replaying notifications', () => {
  const failed = { ...exchange, answer: { ...exchange.answer!, error: true, errorText: 'Provider offline' } };
  for (let mount = 0; mount < 2; mount += 1) {
    const view = render(<AiBlock exchange={failed} conversationId="conversation" presentation="conversation" />);
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
    view.unmount();
  }
});

it('shows an external reply failure immediately and retries through its owning session', () => {
  const retry = vi.fn();
  const failed = { ...exchange, answer: { ...exchange.answer!, error: true,
    errorSummary: 'Service quota exhausted', errorText: '402: Insufficient Balance' } };
  render(<AiBlock exchange={failed} allowExchangeActions={false} onRetry={retry} presentation="conversation" />);
  expect(screen.getByRole('alert')).toHaveTextContent('Service quota exhausted');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
});

it('uses the tool summary treatment for reasoning and keeps its disclosure usable', () => {
  const reasoning = 'Inspect the build configuration first.\n\nThen check the dependencies.';
  const { container } = render(<AiBlock exchange={{ ...exchange, answer: { ...exchange.answer!, reasoning } }}
    presentation="conversation" conversationId="conversation" />);
  const thinking = container.querySelector('.ai-thinking')!;
  expect(thinking).toHaveClass('ai-tool-card');
  const summary = within(thinking as HTMLElement).getByRole('button', { name: /思考过程/ });
  expect(summary).toHaveClass('ai-tool-summary');
  expect(summary.lastElementChild?.tagName.toLowerCase()).toBe('svg');
  expect(summary).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(summary);
  expect(summary).toHaveAttribute('aria-expanded', 'true');
  expect(within(thinking as HTMLElement).getByText('Then check the dependencies.')).toBeVisible();
  fireEvent.click(summary);
  expect(container.querySelector('.ai-thinking-body')).toBeNull();
});

it('renders panel answers as plain conversation content with message actions', () => {
  useChatStore.setState({ sendingTabs: [] });
  const { container } = render(<AiBlock exchange={exchange} conversationId="conversation" presentation="conversation" />);
  expect(container.querySelector('.chat-exchange')).not.toBeNull();
  expect(container.querySelector('.command-block')).toBeNull();
  expect(container.querySelector('.ai-block-heading')).toBeNull();
  expect(screen.getByText('configuration')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '收起回答' })).not.toBeInTheDocument();
  // The reply's actions stay in the open instead of hiding in a menu.
  const actions = container.querySelector('.chat-answer-actions')!;
  expect(within(actions as HTMLElement).getAllByRole('button').map(button => button.getAttribute('aria-label')))
    .toEqual(['复制', '重新生成', '编辑重发', '删除']);
  // The sent message carries its clock time and a copy target.
  expect(container.querySelector('.chat-question-meta')).toHaveTextContent(/\d{1,2}:\d{2}/);
  expect(screen.getByTestId('chat-question-copy')).toBeInTheDocument();
});

it('keeps question selection separate from explicit reply collapse', () => {
  useChatStore.setState({ sendingTabs: [] });
  render(<AiBlock exchange={exchange} conversationId="conversation" />);
  fireEvent.click(screen.getByText('Why did the build fail?'));
  expect(screen.getByText('configuration')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '收起回答' }));
  expect(screen.queryByText('configuration')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '展开回答' }));
  expect(screen.getByText('configuration')).toBeInTheDocument();
});

it('rotates the disclosure chevron a quarter turn instead of pointing it sideways', () => {
  useChatStore.setState({ sendingTabs: [] });
  const { container } = render(<AiBlock exchange={exchange} conversationId="conversation" />);
  const arrow = () => container.querySelector('.ai-block-actions svg') as SVGElement;
  // Points up when expanded (▴ = the down arrow rotated 180°) and down when collapsed (▾); every AI panel disclosure follows this rule
  expect(arrow().style.transform).toBe('rotate(90deg)');
  fireEvent.click(screen.getByRole('button', { name: '收起回答' }));
  expect(arrow().style.transform).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '展开回答' }));
  expect(arrow().style.transform).toBe('rotate(90deg)');
});

it.each(['', ' \n '])('keeps an attachment-only message without an empty text bubble (%j)', content => {
  const { container } = render(<AiBlock conversationId="conversation" presentation="conversation" exchange={{ ...exchange,
    question: { ...exchange.question!, content, attachments: [{ id: 'paste', kind: 'paste', name: 'Pasted log', mime: 'text/plain', size: 5, textContent: 'hello' }] },
  }} />);
  expect(container.querySelector('.ai-block-question')).toBeNull();
  expect(screen.queryByTestId('chat-question-copy')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pasted log' }));
  expect(screen.getByText('hello')).toBeVisible();
  expect(screen.getByText('configuration')).toBeVisible();
});

it('keeps approval actions and failures visible without timeline nodes', () => {
  const { container } = render(<AiBlock conversationId="conversation" exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [
    { kind: 'tool', tool: { toolCallId: 'approval', toolName: 'run_command', input: { command: 'npm run build' }, state: 'approval-pending', startedAt: 1 } },
    { kind: 'tool', tool: { toolCallId: 'failure', toolName: 'read_file', input: { path: '/project/missing' }, state: 'error', startedAt: 1, error: 'Missing file' } },
  ] } }} />);
  expect(screen.getByRole('button', { name: '运行' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /读取文件.*失败/ }));
  expect(container.querySelector('.ai-tool-verdict')).toHaveTextContent('Missing file');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(container.querySelectorAll('.ai-tool-card')).toHaveLength(2);
  expect(container.querySelector('[style*="position: absolute"]')).toBeNull();
});

it('opens a restored failure inside the card and collapses it again', () => {
  const { container } = render(<AiBlock conversationId="conversation" presentation="conversation" exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [
    { kind: 'tool', tool: { toolCallId: 'failure', toolName: 'run_command', input: { command: 'cat /etc/hosts' }, state: 'error', startedAt: 1, error: 'Exit code 2' } },
  ] } }} />);
  const summary = () => container.querySelector('.ai-tool-summary') as HTMLElement;
  expect(screen.queryByRole('alert')).toBeNull();
  expect(summary()).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(summary());
  expect(container.querySelector('.ai-tool-verdict')).toHaveTextContent('Exit code 2');
  expect(summary()).toHaveAttribute('aria-expanded', 'true');
  expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
  fireEvent.click(summary());
  expect(container.querySelector('.ai-tool-verdict')).toBeNull();
  expect(summary()).toHaveAttribute('aria-expanded', 'false');
});

it('retains a late failure for explicit review after the row was collapsed', () => {
  const running: ToolRun = { toolCallId: 'late', toolName: 'run_command', input: { command: 'npm run build' }, state: 'running', startedAt: 1 };
  const view = (tool: ToolRun) => (
    <AiBlock conversationId="conversation" presentation="conversation"
      exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [{ kind: 'tool', tool }] } }} />
  );
  // The row is collapsed while the command is still running ...
  const { container, rerender } = render(view(running));
  fireEvent.click(container.querySelector('.ai-tool-summary')!);
  expect(screen.queryByRole('alert')).toBeNull();
  // The row exposes its failed state without interrupting the conversation.
  rerender(view({ ...running, state: 'error', error: 'Exit code 2' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(container.querySelector('.ai-tool-state')).toHaveTextContent('失败');
  fireEvent.click(container.querySelector('.ai-tool-summary')!);
  expect(container.querySelector('.ai-tool-verdict')).toHaveTextContent('Exit code 2');
  expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
});

const commandPart = { kind: 'tool' as const, tool: {
  toolCallId: 'command', toolName: 'run_command', input: { command: 'npm run build' }, state: 'done' as const,
  startedAt: 1, output: JSON.stringify({ exitCode: 0, output: 'built' }),
} };

function outputSurface(container: HTMLElement): HTMLElement {
  fireEvent.click(container.querySelector('.ai-tool-summary')!);
  return container.querySelector('.ai-tool-output [data-selectable]') as HTMLElement;
}

it('keeps panel tool output inside the shared frame without a second terminal surface or scroll container', () => {
  const { container } = render(<AiBlock conversationId="conversation" presentation="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [commandPart] } }} />);
  const surface = outputSurface(container);
  expect(surface.style.padding).toBe('0px');
  // The box owns scrolling; the snapshot inside must not cap its own height.
  expect(surface.style.maxHeight).toBe('');
});

it('keeps the terminal surface for inline AI blocks', () => {
  const { container } = render(<AiBlock conversationId="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [commandPart] } }} />);
  const surface = outputSurface(container);
  expect(surface.style.padding).toBe('2px 8px 8px');
  expect(surface.style.maxHeight).toBe('');
  // The copy target belongs to the panel frame only.
  expect(container.querySelector('[data-testid="tool-output-copy"]')).toBeNull();
});

it('copies the panel tool output from the frame corner', async () => {
  writeClipboardTextMock.mockClear();
  const { container } = render(<AiBlock conversationId="conversation" presentation="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [commandPart] } }} />);
  outputSurface(container);
  const copy = screen.getByTestId('tool-output-copy');
  expect(copy).toHaveAttribute('data-tip', '复制输出');
  expect(container.querySelector('.ai-tool-frame > .ai-tool-output')).not.toBeNull();

  fireEvent.click(copy);

  await waitFor(() => expect(writeClipboardTextMock).toHaveBeenCalledWith('built'));
  expect(copy).toHaveAttribute('data-tip', '已复制');
});

it('copies the tool log when a stopped reply has no answer text yet', async () => {
  writeClipboardTextMock.mockClear();
  render(<AiBlock conversationId="conversation" presentation="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, content: '', stopped: true, parts: [commandPart] } }} />);
  fireEvent.click(screen.getByTestId('chat-answer-copy'));
  await waitFor(() => expect(writeClipboardTextMock).toHaveBeenCalledWith('[执行命令: npm run build → 成功]'));
});

it('copies ACP text parts when the flat answer content is empty', async () => {
  writeClipboardTextMock.mockClear();
  render(<AiBlock conversationId="conversation" presentation="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, content: '', parts: [
      { kind: 'text', text: 'First paragraph.' },
      { kind: 'text', text: 'Second paragraph.' },
    ] } }} />);
  fireEvent.click(screen.getByTestId('chat-answer-copy'));
  await waitFor(() => expect(writeClipboardTextMock).toHaveBeenCalledWith('First paragraph.\n\nSecond paragraph.'));
});

it('keeps this exchange actionable while a background conversation answers', () => {
  // The single send slot is taken by a scheduled (background) conversation: this exchange is idle.
  useChatStore.setState({ sendingTabs: ['background-conversation'] });
  render(<AiBlock exchange={exchange} conversationId="conversation" presentation="conversation" />);
  expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '编辑重发' })).toBeInTheDocument();
});

it('hides regenerate and edit while its own conversation answers', () => {
  useChatStore.setState({ sendingTabs: ['conversation'] });
  render(<AiBlock exchange={exchange} conversationId="conversation" presentation="conversation" />);
  expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑重发' })).toBeNull();
});

it('explains a reply whose provider sent its tool call as plain text', () => {
  const leaked = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="run_command">\ndir\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  const view = (content: string) => (
    <AiBlock conversationId="conversation" presentation="conversation"
      exchange={{ ...exchange, answer: { ...exchange.answer!, content } }} />
  );
  const { container, rerender } = render(view(leaked));
  expect(screen.getByTestId('chat-leaked-tool-call')).toHaveTextContent('本次没有执行任何工具');
  // The raw text stays readable — the note explains it instead of hiding it.
  expect(container.textContent).not.toContain('DSML');

  rerender(view('I ran `dir` and it lists four files.'));
  expect(screen.queryByTestId('chat-leaked-tool-call')).toBeNull();
});

it('keeps a refusal inside the expanded card without a footer error', () => {
  const { container } = render(<AiBlock conversationId="conversation" exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [
    { kind: 'tool', tool: { toolCallId: 'denied', toolName: 'run_command', input: { command: 'rm -rf /' }, state: 'denied', startedAt: 1, danger: '等待 5 分钟无人应答，已自动拒绝本次操作。' } },
  ] } }} />);
  // The result retains its state; explicit review expands its reason in the transcript.
  expect(container.querySelector('.ai-tool-summary')).toHaveTextContent('已拒绝');
  expect(screen.queryByTestId('tool-denied-reason')).toBeNull();
  expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
  fireEvent.click(container.querySelector<HTMLButtonElement>('.ai-tool-summary')!);
  expect(container.querySelector('.ai-tool-verdict')).toHaveTextContent('已自动拒绝本次操作');
  expect(document.querySelector('#app-notifications [role="alert"]')).toBeNull();
  expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull();
});

it('labels the narrowest approval with the shape and keeps the wider one out of the way', () => {
  render(<AiBlock conversationId="conversation" exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [
    { kind: 'tool', tool: { toolCallId: 'shape', toolName: 'run_command', input: { command: 'npm run build' }, state: 'approval-pending', startedAt: 1, shape: 'npm run' } },
  ] } }} />);
  // The narrowest grant lives in the approval options menu; while a shape exists the whole-tool
  // session grant is not offered there.
  fireEvent.click(screen.getByRole('button', { name: '审批选项' }));
  expect(screen.getByRole('menuitem', { name: '本会话允许「npm run」' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: '本会话允许' })).toBeNull();
  expect(screen.getByRole('button', { name: '运行' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
});

it('shows a terminal tool row as the bare command without a prompt marker', () => {
  render(<AiBlock conversationId="conversation" presentation="conversation"
    exchange={{ ...exchange, answer: { ...exchange.answer!, parts: [commandPart] } }} />);
  // The terminal icon already states the tool type, so no `$` prompt prefix is needed.
  expect(screen.getByText('npm run build')).toHaveClass('ai-tool-description');
  expect(screen.queryByText('$ npm run build')).toBeNull();
});

it('explains a reply whose provider sent its tool call as plain text', () => {
  const leaked = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="run_command">\ndir\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  const view = (content: string) => (
    <AiBlock conversationId="conversation" presentation="conversation"
      exchange={{ ...exchange, answer: { ...exchange.answer!, content } }} />
  );
  const { container, rerender } = render(view(leaked));
  expect(screen.getByTestId('chat-leaked-tool-call')).toHaveTextContent('本次没有执行任何工具');
  // The raw text stays readable — the note explains it instead of hiding it.
  expect(container.textContent).not.toContain('DSML');

  rerender(view('I ran `dir` and it lists four files.'));
  expect(screen.queryByTestId('chat-leaked-tool-call')).toBeNull();
});
