import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserDriver } from './agent-browser.mjs';
import { TicketAgent } from './agent-core.mjs';

test('scheduled local demo fills only the approved visible form fields', async () => {
  const driver = new BrowserDriver(chromium);
  try {
    const agent = new TicketAgent(driver, { allowDemo: true });
    const job = agent.create({ name: 'Local browser test', url: 'http://127.0.0.1:4180/demo.html', saleAt: new Date(Date.now() + 60000).toISOString(), person: { fullName: 'DEMO USER', phone: '13800000000', documentNumber: 'FAKE-DEMO-ID' }, quantity: 2 });
    const scanned = await agent.inspect(job.id);
    assert.equal(scanned.status, 'needs_mapping');
    assert.equal(Object.values(scanned.mappings).filter(Boolean).length, 4);
    agent.get(job.id).saleAt = new Date(Date.now() + 300).toISOString();
    agent.arm(job.id, scanned.mappings);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await agent.tick();
    assert.equal(agent.get(job.id).status, 'completed');
    const page = driver.pages.get(job.id);
    assert.equal(await page.getByLabel('姓名', { exact: true }).inputValue(), 'DEMO USER');
    assert.equal(await page.getByLabel('手机号', { exact: true }).inputValue(), '13800000000');
    assert.equal(await page.getByLabel('证件号码', { exact: true }).inputValue(), 'FAKE-DEMO-ID');
    assert.equal(await page.getByLabel('票数', { exact: true }).inputValue(), '2');
    assert.deepEqual(agent.get(job.id).fields, []);
  } finally { await driver.close(); }
});
