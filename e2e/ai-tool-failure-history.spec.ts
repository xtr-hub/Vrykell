import { expect, test } from '@playwright/test';
import { setupTauriMock } from './tauri-mock';

test('keeps failed tool output and replies inside restored conversations across reloads', async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('e2e-conversations', JSON.stringify([{ id: 'failed-chat', title: 'Failed deployment', created_at: 1, updated_at: 2, environment: '{}' }]));
    localStorage.setItem('e2e-conversation-messages', JSON.stringify([
      { id: 'question', conversation_id: 'failed-chat', role: 'user', content: 'Check deployment', created_at: 1, parts: '', attachments: '', context: '{}' },
      { id: 'answer', conversation_id: 'failed-chat', role: 'assistant', content: '', created_at: 2, attachments: '', context: JSON.stringify({ error: true, errorText: 'Connection unavailable' }),
        parts: JSON.stringify([{ kind: 'tool', tool: { toolCallId: 'failed-command', toolName: 'run_command', state: 'error', input: { command: 'check-service' }, startedAt: 1, error: 'Exit code 3', output: JSON.stringify({ ok: false, exitCode: 3, output: 'service is inactive' }) } }]) },
    ]));
  });
  await setupTauriMock(page, {});
  await page.goto('/');
  for (let visit = 0; visit < 2; visit += 1) {
    await page.getByTestId('workspace-area-unified').click();
    await page.getByTestId('workspace-instance-bar').getByRole('button', { name: '全部历史', exact: true }).click();
    await page.getByTestId('unified-history-conversation:failed-chat').click();
    const workspace = page.getByTestId('unified-workspace');
    await expect(workspace.locator('.ai-tool-card[data-tool-state="error"]')).toBeVisible();
    await expect(workspace.getByText('回复未能完成', { exact: true })).toBeVisible();
    await expect(page.locator('#app-notifications [data-error-notification]')).toHaveCount(0);
    await workspace.locator('.ai-tool-summary').click();
    await expect(workspace.locator('.ai-tool-verdict')).toContainText('Exit code 3');
    await expect(workspace.locator('.ai-tool-output')).toContainText('service is inactive');
    await expect(page.locator('#app-notifications [data-error-notification]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`inline-failure-${visit}.png`) });
    if (visit === 0) await page.reload();
  }
});
