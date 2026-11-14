import { test, expect, type Page } from '@playwright/test';
import { mockAnthropic, paceLlmStream, setupTauriMock, ensureTabsOpen, ptyWrites, ensureChatSettingsOpen } from './tauri-mock';
import { fillHistorySearch } from './history-search';

async function boot(page: Page, reply = 'The build is fixed.') {
  await mockAnthropic(page, reply);
  await setupTauriMock(page, {});
  await page.goto('/');
  await expect(page.locator('[data-terminal-input]')).toBeVisible();
  await page.locator('[data-dock-btn="chat"]').click();
  await expect(page.locator('[data-chat-composer]:visible')).toBeVisible();
  await expect(page.getByRole('button', { name: '会话设置' })).toBeVisible();
}

test('conversation drafts survive terminal navigation, settings and closing the final terminal', async ({ page }) => {
  await boot(page);
  const composer = page.locator('[data-chat-composer]:visible');
  await composer.fill('Fix the project build');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('[data-dock-btn="chat"]')).toBeVisible();
  await ensureTabsOpen(page);
  await page.getByTestId('tab-row-t1').click();
  await page.getByRole('button', { name: '关闭当前终端', exact: true }).click();
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue('Fix the project build');
  await composer.press('Enter');
  await expect(page.getByText('The build is fixed.', { exact: true })).toBeVisible();
});

test('history owns separate drafts and messages and restores them after reload', async ({ page }) => {
  await boot(page);
  const composer = page.locator('[data-chat-composer]:visible');
  await composer.fill('Fix the build');
  await composer.press('Enter');
  await expect(page.getByText('The build is fixed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(composer).toHaveValue('');
  await composer.fill('Second draft');
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await page.getByRole('combobox', { name: '侧栏对话', exact: true }).click();
  await page.getByRole('option', { name: 'Fix the build', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('The build is fixed.', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await page.getByRole('combobox', { name: '侧栏对话', exact: true }).click();
  await page.getByRole('option', { name: '新对话', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('Second draft');
  await page.getByRole('button', { name: 'AI 对话历史', exact: true }).click();
  const history = page.getByTestId('unified-history-page');
  await expect(history).toBeVisible();
  await expect(history.locator('[data-history-kind="conversation"]').filter({ hasText: '新对话' })).toHaveCount(0);
  await history.locator('[data-history-kind="conversation"]').filter({ hasText: 'Fix the build' }).click();
  await page.reload();
  await page.getByTestId('workspace-area-ai').click();
  await expect(page.getByText('The build is fixed.', { exact: true })).toBeVisible();
});

test('the execution environment stays fixed and a closed terminal stays disconnected', async ({ page }) => {
  await boot(page);
  await ensureChatSettingsOpen(page);
  await page.getByRole('combobox', { name: '选择执行终端' }).click();
  await page.getByRole('listbox', { name: '选择执行终端' }).getByRole('option').filter({ hasNotText: '不操作终端' }).first().click();
  const chip = page.getByTestId('chat-execution-target');
  await expect(chip).toBeVisible();
  const selected = await chip.textContent();
  await page.getByTestId('tab-new-btn').click();
  await page.getByRole('button', { name: /Bash/ }).click();
  await ensureChatSettingsOpen(page);
  await expect(chip).toHaveText(selected!);
  await ensureTabsOpen(page);
  await page.getByTestId('tab-row-t1').click();
  await page.getByRole('button', { name: '关闭当前终端', exact: true }).click();
  await ensureChatSettingsOpen(page);
  await expect(chip).toContainText('已断开');
  await expect(page.getByText('终端已断开，选择终端后可继续执行。')).toBeVisible();
});

test('the picker opens the new-tab panel and binds the terminal it creates', async ({ page }) => {
  await boot(page);
  await ensureChatSettingsOpen(page);
  const target = page.getByRole('combobox', { name: '选择执行终端' });
  await expect(target).toContainText('不操作终端');
  await ensureTabsOpen(page);
  const tabsBefore = await page.locator('[data-tab-kind="session"]').count();
  await ensureChatSettingsOpen(page);
  await target.click();
  await page.locator('.ui-select-menu').getByRole('button', { name: '新建标签页' }).click();
  // The panel comes first; picking a type creates the tab and binds it to the conversation.
  await page.getByRole('button', { name: /Bash/ }).click();
  await expect(page.locator('[data-tab-kind="session"]')).toHaveCount(tabsBefore + 1);
  await ensureChatSettingsOpen(page);
  await expect(target).not.toContainText('不操作终端');
  await expect(page.getByTestId('chat-conversation-context')).toHaveCount(0);
});

test('rename and delete manage conversation history independently of terminals', async ({ page }) => {
  await boot(page);
  await page.locator('[data-chat-composer]:visible').fill('Investigate the build');
  await page.locator('[data-chat-composer]:visible').press('Enter');
  await expect(page.getByText('The build is fixed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重命名对话' }).click();
  const title = page.getByRole('textbox', { name: '对话标题' });
  await title.fill('Build investigation');
  await title.press('Enter');
  await expect(page.locator('.chat-conversation-title')).toHaveText('Build investigation');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: 'AI 对话历史' }).click();
  const history = page.getByTestId('unified-history-page');
  await expect(page.locator('[data-tab-kind="ai-history"]')).toHaveCount(1);
  const row = history.locator('[data-history-kind="conversation"]').filter({ hasText: 'Build investigation' });
  await fillHistorySearch(page, 'unified-history-search', 'Build investigation');
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-tab-kind="session"]')).toHaveCount(1);
  await page.getByTestId('workspace-area-terminal').click();
  await expect(page.locator('[data-terminal-input]')).toBeVisible();
  await page.reload();
  if (!await page.getByRole('button', { name: 'AI 对话历史' }).isVisible()) await page.locator('[data-dock-btn="chat"]').click();
  await page.getByRole('button', { name: 'AI 对话历史' }).click();
  await expect(page.getByTestId('unified-history-page').locator('[data-history-kind="conversation"]')
    .filter({ hasText: 'Build investigation' })).toHaveCount(0);
});

test('command analysis stages a reference before sending and never changes terminal input', async ({ page }) => {
  await boot(page, 'This is a command snapshot.');
  const terminal = page.locator('[data-terminal-input]');
  await terminal.fill('echo reference-source');
  await terminal.press('Enter');
  const block = page.locator('.command-block').filter({ hasText: 'echo reference-source' }).first();
  await expect(block).toBeVisible();
  await block.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '发给 AI 分析' }).click();
  const composer = page.locator('[data-chat-composer]:visible');
  await expect(composer).toHaveValue('帮我分析这条命令的执行结果。');
  await expect(page.getByText('This is a command snapshot.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '会话设置' })).toBeVisible();
  await expect(page.getByTestId('chat-conversation-context')).toHaveCount(0);
  await expect(page.locator('.chat-composer .chat-reference-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.chat-composer .chat-reference-body')).toContainText('reference-source');
  await composer.press('Enter');
  await expect(page.getByText('This is a command snapshot.', { exact: true })).toBeVisible();
  expect(await ptyWrites(page)).not.toContain('帮我分析这条命令的执行结果。\n');
  await expect(block).toBeVisible();
});

for (const themePalette of ['dark', 'light'] as const) {
  test(`plain conversation answers remain readable in ${themePalette}`, async ({ page }) => {
    await mockAnthropic(page, 'The build failed because the configuration is missing.\n\n```sh\nnpm run build\n```\n\n| 监听地址 | 含义 |\n| --- | --- |\n| `0.0.0.0:80` | 全网卡、外部可达 |\n| `127.0.0.1:3306` | 仅本机 |\n\nCheck the configuration and run the build again.');
    await setupTauriMock(page, {});
    await page.addInitScript(theme => localStorage.setItem('vrykell-theme-mode', theme), themePalette);
    await page.goto('/');
    await page.locator('[data-dock-btn="chat"]').click();
    await page.locator('[data-chat-composer]:visible').fill('Why did the build fail?');
    await page.locator('[data-chat-composer]:visible').press('Enter');
    const exchange = page.locator('.ai-block:visible');
    await expect(exchange.getByText('Check the configuration and run the build again.')).toBeVisible();
    await expect(exchange).not.toHaveClass(/command-block/);
    await expect(exchange).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await exchange.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
    await expect(exchange.locator('.ai-block-heading')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', themePalette);
    // A table uses the same frame as a code block so the answer reads as one system.
    const frames = await exchange.evaluate(element => ({
      code: getComputedStyle(element.querySelector('.md pre')!.parentElement as HTMLElement).borderTopColor,
      table: getComputedStyle(element.querySelector('.md table') as HTMLElement).borderTopColor,
    }));
    expect(frames.table).not.toBe('');
    expect(frames.table).toBe(frames.code);
    // The frame ends where the columns end: a stretched block would paint an empty surface next
    // to the table at a wide panel.
    const widths = await exchange.evaluate(element => {
      const table = element.querySelector('.md table') as HTMLElement;
      const row = table.querySelector('tr') as HTMLElement;
      return { box: table.getBoundingClientRect().width, row: row.getBoundingClientRect().width };
    });
    expect(widths.box - widths.row).toBeLessThanOrEqual(4);
    await exchange.locator('.ai-block-question').click();
    await expect(exchange.locator('.ai-block-answer')).toBeVisible();
    await page.locator('.ai-chat-panel:visible').screenshot({ path: `.cache/ai-chat-redesign-${themePalette}.png` });
    await expect(exchange.getByRole('button', { name: '收起回答' })).toHaveCount(0);
    // The reply's actions are expanded under the answer rather than hidden in a menu.
    const actions = exchange.locator('.chat-answer-actions');
    await expect(actions.getByRole('button', { name: '复制', exact: true })).toBeVisible();
    await expect(actions.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
    // The sent message reveals its clock time and a copy target on hover.
    await exchange.locator('.ai-block-question').hover();
    await expect(exchange.locator('.chat-question-meta')).toContainText(/\d{1,2}:\d{2}/);
    await expect(exchange.getByTestId('chat-question-copy')).toHaveCSS('opacity', '1');
    await expect(exchange.locator('.ai-block-answer')).toBeVisible();
  });
}

test('tool activity stays available within the plain conversation flow', async ({ page }) => {
  await setupTauriMock(page, {});
  await page.goto('/');
  await page.evaluate(async () => {
    const now = Date.now();
    const id = 'tool-row-review';
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
    await invoke('save_conversation', { id, title: 'Server discovery', createdAt: now, updatedAt: now, environment: 'null' });
    await invoke('append_conversation_message', { id: 'tool-question', conversationId: id, role: 'user',
      content: 'Help me inspect the services deployed on this server.', createdAt: now, parts: '', attachments: '', paneId: null, context: '{}' });
    const parts = [
      ...['hostname; uname -a', 'ss -tulnp'].map((command, index) => ({ kind: 'tool', tool: {
        toolCallId: `tool-${index}`, toolName: 'run_command', input: { command }, state: 'done', startedAt: now + index,
        endedAt: now + index + 1, output: JSON.stringify({ ok: true, exitCode: 0, output: 'Example output' }),
      } })),
      { kind: 'tool', tool: { toolCallId: 'tool-failed', toolName: 'run_command', input: { command: 'cat /etc/hosts' },
        state: 'error', startedAt: now + 3, error: 'Exit code 2' } },
    ];
    await invoke('append_conversation_message', { id: 'tool-answer', conversationId: id, role: 'assistant', content: '',
      createdAt: now + 1, parts: JSON.stringify(parts), attachments: '', paneId: null, context: '{}' });
    localStorage.setItem('active-ai-conversation', id);
  });
  await page.reload();
  await page.getByTestId('workspace-history').click();
  await page.getByTestId('unified-history-conversation:tool-row-review').click();
  const rows = page.locator('.ai-tool-card:visible');
  await expect(rows).toHaveCount(3);
  const presentation = await rows.first().evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
    borderTop: getComputedStyle(element).borderTopStyle,
  }));
  expect(presentation).toMatchObject({ radius: '8px', borderTop: 'none' });
  expect(presentation.background).not.toBe('rgba(0, 0, 0, 0)');
  await expect(rows.first().locator('.ai-tool-label')).toHaveText('运行命令');
  await expect(rows.first().locator('.ai-tool-state')).toHaveText('退出码 0');
  // Expanded output reuses the markdown code-block frame instead of a hairline.
  await rows.first().locator('.ai-tool-summary').click();
  await expect(rows.first().locator('.ai-tool-input')).toContainText('hostname; uname -a');
  await expect(rows.first().locator('.ai-tool-section-label')).toHaveText(['输入', '输出']);
  const output = rows.first().locator('.ai-tool-output');
  await expect(output).toBeVisible();
  const frame = await output.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
    borderTop: getComputedStyle(element).borderTopStyle,
    paddingLeft: getComputedStyle(element).paddingLeft,
  }));
  expect(frame).toMatchObject({ radius: '8px', borderTop: 'solid', paddingLeft: '12px' });
  expect(frame.background).not.toBe('rgba(0, 0, 0, 0)');
  // One scroll container only: the framed box scrolls, the terminal snapshot inside does not.
  const scroll = await output.evaluate(element => ({
    wrapper: getComputedStyle(element).overflowY,
    inner: getComputedStyle(element.firstElementChild as HTMLElement).overflowY,
  }));
  expect(scroll).toEqual({ wrapper: 'auto', inner: 'hidden' });
  // History stays quiet until a stored failure is explicitly expanded in its card.
  const failed = rows.nth(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(failed.locator('.ai-tool-summary')).toHaveAttribute('aria-expanded', 'false');
  await failed.locator('.ai-tool-summary').click();
  await expect(failed.locator('.ai-tool-verdict')).toContainText('Exit code 2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The copy target sits in the frame corner and appears with the hovered output.
  const copy = page.getByTestId('tool-output-copy');
  await expect(copy).toHaveCSS('opacity', '0');
  await output.hover();
  await expect(copy).toHaveCSS('opacity', '1');
  await expect(copy).toHaveAttribute('data-tip', '复制输出');
  await page.locator('.ai-chat-panel:visible').screenshot({ path: '.cache/ai-tool-frame.png' });
  await expect(page.locator('.ai-block:visible')).not.toHaveClass(/command-block/);
  await expect(page.locator('.ai-block-question')).toHaveCSS('word-break', 'normal');
});

test('reading earlier content pauses automatic scroll until the user returns to the latest reply', async ({ page }) => {
  await boot(page, Array.from({ length: 100 }, (_, index) => `Paragraph ${index}: review the project configuration.\n\n`).join(''));
  await page.locator('[data-chat-composer]:visible').fill('Explain the project');
  await page.locator('[data-chat-composer]:visible').press('Enter');
  const transcript = page.locator('.chat-transcript:visible');
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight)).toBeGreaterThan(1000);
  await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: '回到最新回复' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  expect(await transcript.evaluate(element => element.scrollTop)).toBeLessThan(10);
  await page.getByRole('button', { name: '回到最新回复' }).click();
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(25);
});

test('pausing and resuming the follow never shifts the transcript layout', async ({ page }) => {
  await boot(page, Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: review the project configuration.\n\n`).join(''));
  await page.locator('[data-chat-composer]:visible').fill('Explain the project');
  await page.locator('[data-chat-composer]:visible').press('Enter');
  const transcript = page.locator('.chat-transcript:visible');
  const jump = page.getByTestId('ai-surface-side').locator('.chat-jump-latest');
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
  const layout = () => transcript.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      box: `${Math.round(rect.top)}/${Math.round(rect.height)}`,
      slot: element.closest('.ai-chat-panel')?.querySelector('.chat-jump-slot')?.getAttribute('data-active') ?? null,
    };
  });
  const following = await layout();
  expect(following.slot).toBeNull();
  await expect(jump).toHaveCSS('visibility', 'hidden');
  // Pausing the follow must not add or remove a row above the transcript: the jump target
  // keeps its reserved height so the content cannot bob up and down.
  await transcript.evaluate(element => { element.scrollTop -= 120; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(async () => (await layout()).slot).toBe('true');
  expect((await layout()).box).toBe(following.box);
  await expect(jump).toHaveCSS('visibility', 'visible');
  await jump.hover();
  const hoverAlpha = await jump.evaluate(element => {
    const alpha = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    return alpha.length === 4 ? alpha[3] : 1;
  });
  expect(hoverAlpha).toBe(1);
  await jump.click();
  await expect.poll(async () => (await layout()).slot).toBeNull();
  expect((await layout()).box).toBe(following.box);
});

test('a small scroll while the reply streams keeps the reading position', async ({ page }) => {
  // A mouse wheel moves far enough to leave the "still near the bottom" window, but a
  // trackpad nudges a few pixels at a time: the follow has to pause on the input itself.
  await mockAnthropic(page, Array.from({ length: 60 }, (_, index) => `Paragraph ${index}: review the project configuration.`).join('\n\n'));
  await paceLlmStream(page, 60);
  await setupTauriMock(page, {});
  await page.goto('/');
  await expect(page.locator('[data-terminal-input]')).toBeVisible();
  await page.locator('[data-dock-btn="chat"]').click();
  const composer = page.locator('[data-chat-composer]:visible');
  await composer.fill('Explain the project');
  await composer.press('Enter');

  const transcript = page.locator('.chat-transcript:visible');
  const distance = () => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight), { timeout: 30_000 }).toBeGreaterThan(200);
  await transcript.hover();
  await page.mouse.wheel(0, -18);

  // The follow pauses on the input itself rather than on the distance from the bottom.
  const slot = page.locator('.chat-jump-slot:visible');
  await expect.poll(() => slot.getAttribute('data-active'), { timeout: 15_000 }).toBe('true');
  // Streamed content keeps arriving; the reading position must not be pulled back down.
  await expect.poll(distance, { timeout: 15_000 }).toBeGreaterThan(100);
  const before = await distance();
  await page.waitForTimeout(800);
  expect(await distance()).toBeGreaterThanOrEqual(before);
  await expect(page.locator('.ai-pending-cursor')).toHaveCount(1);
  await expect(slot.locator('.chat-jump-latest')).toHaveCSS('visibility', 'visible');
});
