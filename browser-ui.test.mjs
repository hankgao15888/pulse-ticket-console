import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('local form creates an agent job without persisting personal values in event backups', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:4180');
    await page.getByRole('button', { name: '本机演练', exact: true }).click();
    await page.locator('#agent-fullName').fill('PRIVATE-TEST-PERSON');
    await page.getByRole('button', { name: /保存场次/ }).click();
    await page.locator('#event-dialog').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => localStorage.getItem('pulse-ticket-events-v1'));
    assert(!saved.includes('PRIVATE-TEST-PERSON'));
    assert(!saved.includes('13800000000'));
    assert(!saved.includes('DEMO-NOT-A-REAL-ID'));
    assert.equal(await page.locator('#agent-fullName').inputValue(), '');
    const row = page.locator('.agent-job').filter({ hasText: '本机填表演练' }).last();
    await row.getByRole('button', { name: '打开页面 / 重新识别', exact: true }).click();
    await row.getByRole('button', { name: '确认字段并预约', exact: true }).waitFor({ state: 'visible', timeout: 35000 });
    assert.equal(await row.locator('select').count(), 4);
    await page.locator('#agent-panel').screenshot({ path: '../../outputs/pulse-agent-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '本机演练', exact: true }).click();
    assert(await page.locator('#agent-person-fields').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: '../../outputs/pulse-agent-mobile.png' });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await row.getByRole('button', { name: '取消任务', exact: true }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
