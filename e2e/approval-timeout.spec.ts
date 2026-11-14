/**
 * Approval timeout e2e: an approval card nobody answers denies itself, says why, and the turn
 * finishes instead of holding the single send slot open.
 */
import { test, expect } from '@playwright/test';
import { setupTauriMock, mockAnthropic, mockAnthropicToolCall } from './tauri-mock';

test.describe('approval timeout', () => {
  test('a card nobody answers is denied, explained and lets the next turn start', async ({ page }) => {
    await mockAnthropic(page, '已记录');
    // The model asks to write a file; the write is gated behind the approval card.
    await mockAnthropicToolCall(page, 'write_file', { path: '/home/e2e/project/note.txt', content: 'hi' });
    // A three-second deadline keeps the test quick; the setting itself offers whole minutes.
    await page.addInitScript(() => {
      localStorage.setItem('vrykell-permissions', JSON.stringify({
        version: 3,
        state: { levels: {}, mode: 'standard', approvalTimeoutSeconds: 3 },
      }));
    });
    await setupTauriMock(page, {});
    await page.goto('/');

    // A terminal tab exists, so the agent has a pane to run commands in.
    await expect(page.getByPlaceholder(/输入命令/)).toBeVisible({ timeout: 5000 });
    await page.locator('[data-dock-btn="chat"]').click();
    const composer = page.getByTestId('ai-sidebar-content').getByPlaceholder(/自然语言描述/);
    await expect(composer).toBeVisible({ timeout: 3000 });
    await composer.fill('写个便签');
    await composer.press('Enter');

    // The card asks, and nothing answers it.
    await expect(page.getByRole('button', { name: '允许一次' })).toBeVisible({ timeout: 10000 });

    const denied = page.getByTestId('ai-sidebar-content').locator('.ai-tool-card[data-tool-state="denied"]');
    await expect(denied).toBeVisible({ timeout: 15000 });
    await denied.locator('.ai-tool-summary').click();
    await expect(denied.locator('.ai-tool-verdict')).toContainText('已自动拒绝');
    await expect(denied.locator('.ai-tool-verdict')).toContainText('无人应答');
    await expect(page.locator('#app-notifications [data-error-notification]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '允许一次' })).toHaveCount(0);

    // The turn continued with the reply, so the model learns why its step never ran ...
    await expect(page.getByText('已记录')).toBeVisible({ timeout: 10000 });
    // ... and the send slot is free again instead of staying taken by the silent card.
    await expect(composer).toBeEnabled();
    await composer.fill('再来一次');
    await composer.press('Enter');
    await expect(page.getByText('已记录')).toHaveCount(2, { timeout: 10000 });
  });
});
