import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketAgent, validateTarget, suggestMappings } from './agent-core.mjs';
import { createApp } from './server.mjs';

const baseTime = Date.parse('2026-11-09T08:00:00Z');
const draft = () => ({ name: 'Test event', url: 'https://detail.damai.cn/item.htm?id=1092331547013', saleAt: new Date(baseTime + 5000).toISOString(), person: { fullName: 'TEST-PRIVATE-NAME', phone: '13800000000' }, quantity: 2 });
const candidates = [{ id: '0', label: '姓名', fingerprint: 'name' }, { id: '1', label: '手机号', fingerprint: 'phone' }, { id: '2', label: '票数', fingerprint: 'quantity' }];
const report = { origin: 'https://detail.damai.cn', blocked: false, candidates };

test('official URL rules reject lookalikes, credentials and local network targets', () => {
  for (const url of ['https://damai.cn.evil.example/', 'https://user:pass@damai.cn/', 'http://detail.damai.cn/', 'https://127.0.0.1/', 'file:///x', 'https://damai.cn:999/']) assert.throws(() => validateTarget(url));
  assert.equal(validateTarget('https://detail.damai.cn/item.htm?id=1'), 'https://detail.damai.cn/item.htm?id=1');
});

test('no personal data in summaries, require mapping, run exactly once at target time', async () => {
  let now = baseTime; let calls = 0;
  const agent = new TicketAgent({ inspect: async () => report, fill: async (job) => { calls++; assert.equal(job.fields[0].value, 'TEST-PRIVATE-NAME'); return { filled: job.fields.length }; } }, { now: () => now });
  const created = agent.create(draft());
  assert(!JSON.stringify(created).includes('TEST-PRIVATE-NAME'));
  assert(!JSON.stringify(created).includes('13800000000'));
  assert.throws(() => agent.arm(created.id, {}));
  await agent.inspect(created.id);
  assert.throws(() => agent.arm(created.id, { fullName: '0', phone: '0', quantity: '2' }));
  agent.arm(created.id, { fullName: '0', phone: '1', quantity: '2' });
  await agent.tick(); assert.equal(calls, 0);
  now += 5000;
  await Promise.all([agent.tick(), agent.tick()]);
  assert.equal(calls, 1); assert.equal(agent.get(created.id).status, 'completed');
  assert.deepEqual(agent.get(created.id).fields, []);
});

test('verification and origin changes cannot be armed', async () => {
  for (const inspected of [{ ...report, blocked: true }, { ...report, origin: 'https://passport.damai.cn' }]) {
    const agent = new TicketAgent({ inspect: async () => inspected }, { now: () => baseTime });
    const job = agent.create(draft()); await agent.inspect(job.id);
    assert.throws(() => agent.arm(job.id, { fullName: '0', phone: '1', quantity: '2' }));
  }
});

test('duplicate field suggestions require manual choice', () => {
  assert.equal(suggestMappings([{ key: 'fullName' }], [{ id: '0', label: '姓名' }, { id: '1', label: '姓名' }]).fullName, '');
});

test('cancel while inspecting cannot revive a task', async () => {
  let finish;
  const agent = new TicketAgent({ inspect: () => new Promise((resolve) => { finish = resolve; }) }, { now: () => baseTime });
  const job = agent.create(draft()); const inspecting = agent.inspect(job.id);
  agent.cancel(job.id); finish(report); await inspecting;
  assert.equal(agent.get(job.id).status, 'cancelled'); assert.deepEqual(agent.get(job.id).fields, []);
});

test('missed deadline and failures clear personal data', async () => {
  for (const missed of [true, false]) {
    let now = baseTime;
    const agent = new TicketAgent({ inspect: async () => report, fill: async () => { throw new Error('do not log profile'); } }, { now: () => now });
    const job = agent.create(draft()); await agent.inspect(job.id); agent.arm(job.id, { fullName: '0', phone: '1', quantity: '2' });
    now += missed ? 70000 : 5000; await agent.tick();
    assert.equal(agent.get(job.id).status, missed ? 'missed' : 'failed'); assert.deepEqual(agent.get(job.id).fields, []);
  }
});

test('loopback HTTP API rejects cross-origin requests and requires a session key', async (t) => {
  const agent = new TicketAgent({}, { now: () => baseTime });
  const server = createApp(agent, { port: 4187 });
  await new Promise((resolve) => server.listen(4187, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = 'http://127.0.0.1:4187';
  assert.equal((await fetch(`${root}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${root}/api/jobs`)).status, 403);
  const { token } = await (await fetch(`${root}/api/session`)).json();
  const created = await fetch(`${root}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulse-Key': token }, body: JSON.stringify(draft()) });
  assert.equal(created.status, 201); assert(!(await created.text()).includes('TEST-PRIVATE-NAME'));
  assert.equal((await fetch(`${root}/agent-core.mjs`)).status, 404);
  assert.equal((await fetch(`${root}/api/jobs`, { headers: { 'X-Pulse-Key': token } })).headers.get('cache-control'), 'no-store');
});
