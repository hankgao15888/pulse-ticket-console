import { randomUUID } from 'node:crypto';

const OFFICIAL = ['12306.cn', 'damai.cn', 'maoyan.com', 'showstart.com', 'bilibili.com'];
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'missed']);
const ALIASES = {
  fullName: ['姓名', '真实姓名', '联系人', '联系人姓名', '观演人姓名', '乘车人姓名', 'name', 'full name'],
  phone: ['手机号', '手机号码', '联系电话', '联系人手机', '电话', 'phone', 'mobile'],
  documentNumber: ['证件号码', '身份证号', '身份证号码', '证件号', 'id number'],
  quantity: ['数量', '票数', '张数', 'quantity'],
};

export function validateTarget(raw, allowDemo = false) {
  const url = new URL(raw);
  const demo = allowDemo && url.origin === 'http://127.0.0.1:4180' && url.pathname === '/demo.html';
  if (!demo && (url.protocol !== 'https:' || !OFFICIAL.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))) {
    throw new Error('请使用 12306、大麦、猫眼、秀动或 B 站的 HTTPS 官方链接。');
  }
  if (url.username || url.password || (url.port && !demo)) throw new Error('链接格式不受支持。');
  return url.href;
}

export function validateDraft(input, { allowDemo = false, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('任务格式无效。');
  const at = Date.parse(input.saleAt);
  if (!Number.isFinite(at) || at < now - 60000 || at > now + 90 * 86400000) throw new Error('预约时间必须在当前时间至未来 90 天内。');
  const person = input.person || {};
  const fields = [];
  for (const key of ['fullName', 'phone', 'documentNumber']) {
    const value = String(person[key] || '').trim();
    if (value.length > 100) throw new Error('个人资料过长。');
    if (key === 'phone' && value && !/^\+?[0-9 ()-]{6,25}$/.test(value)) throw new Error('请输入有效手机号。');
    if (value) fields.push({ key, value });
  }
  const quantity = Number(input.quantity || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 6) throw new Error('票数应为 1 至 6 张。');
  if (!fields.length) throw new Error('至少填写一项个人资料。');
  fields.push({ key: 'quantity', value: String(quantity) });
  return {
    eventId: String(input.eventId || '').slice(0, 100),
    name: String(input.name || '填表任务').slice(0, 80),
    url: validateTarget(input.url, allowDemo),
    saleAt: new Date(at).toISOString(),
    quantity,
    fields,
  };
}

export function suggestMappings(fields, candidates) {
  return Object.fromEntries(fields.map((field) => {
    const aliases = ALIASES[field.key] || [];
    const matches = candidates.filter((candidate) => !candidate.blocked && aliases.includes(candidate.label.trim().toLowerCase()));
    return [field.key, matches.length === 1 ? matches[0].id : ''];
  }));
}

// Sensitive field values stay in process memory and never enter summaries or logs.
export class TicketAgent {
  constructor(driver, { now = Date.now, allowDemo = false } = {}) {
    this.driver = driver;
    this.now = now;
    this.allowDemo = allowDemo;
    this.jobs = new Map();
  }

  create(input) {
    if ([...this.jobs.values()].filter((job) => !TERMINAL.has(job.status)).length >= 10) throw new Error('最多同时保留 10 个任务。');
    const draft = validateDraft(input, { allowDemo: this.allowDemo, now: this.now() });
    const job = { ...draft, id: randomUUID(), status: 'draft', message: '等待打开官方页面并识别字段。', candidates: [], mappings: {}, updatedAt: this.now() };
    this.jobs.set(job.id, job);
    return this.summary(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('任务不存在；代理重启后请重新录入。');
    return job;
  }

  summary(job) {
    return {
      id: job.id, eventId: job.eventId, name: job.name, url: job.url,
      saleAt: job.saleAt, status: job.status, message: job.message,
      origin: new URL(job.url).origin,
      currentOrigin: job.currentOrigin || '',
      fields: job.fields.map(({ key }) => ({ key })),
      candidates: job.candidates, mappings: job.mappings,
      filled: job.filled || 0, updatedAt: job.updatedAt,
    };
  }

  list() { return [...this.jobs.values()].map((job) => this.summary(job)); }

  async inspect(id) {
    const job = this.get(id);
    if (job.busy || job.status === 'queued' || TERMINAL.has(job.status)) throw new Error('请先取消预约或新建任务。');
    job.busy = true;
    job.status = 'preparing';
    try {
      const report = await this.driver.inspect(job);
      if (job.status === 'cancelled') return this.summary(job);
      job.currentOrigin = report.origin;
      job.candidates = report.candidates;
      job.mappings = suggestMappings(job.fields, report.candidates);
      job.status = report.origin !== new URL(job.url).origin ? 'origin_changed' : report.blocked ? 'needs_verification' : 'needs_mapping';
      job.message = report.origin !== new URL(job.url).origin
        ? '页面域名已改变；请核对并明确授权当前域名后重新识别。'
        : report.blocked ? '请在官方浏览器完成登录、验证码或排队，再重新识别。'
        : report.candidates.length ? '核对每项资料的目标字段，再预约执行。'
        : '当前页没有可填写字段；请在官方页面登录、选择场次及票档后重新识别。';
    } catch {
      if (job.status !== 'cancelled') {
        job.status = 'needs_mapping';
        job.message = '页面打开或识别失败。请检查 Edge 安装、网络和官方页面，再重新识别。';
      }
    } finally { job.busy = false; job.updatedAt = this.now(); }
    return this.summary(job);
  }

  async approveOrigin(id, origin) {
    const job = this.get(id);
    if (job.busy || job.status !== 'origin_changed' || !origin || origin !== job.currentOrigin) throw new Error('请先识别页面并确认当前域名。');
    const next = new URL(origin);
    const previous = new URL(job.url);
    const platform = OFFICIAL.find((host) => previous.hostname === host || previous.hostname.endsWith(`.${host}`));
    if (!platform || !(next.hostname === platform || next.hostname.endsWith(`.${platform}`))) throw new Error('只能授权同一官方平台的域名。');
    job.url = validateTarget(origin, this.allowDemo);
    return this.inspect(id);
  }

  arm(id, mappings) {
    const job = this.get(id);
    if (job.busy || job.status !== 'needs_mapping') throw new Error('请先完成页面识别。');
    if (Date.parse(job.saleAt) <= this.now()) throw new Error('预约时间已过，请编辑场次并设置未来时间。');
    const used = new Set();
    const approved = {};
    for (const field of job.fields) {
      const value = mappings?.[field.key];
      const target = job.candidates.find((candidate) => candidate.id === value && !candidate.blocked);
      if (!target || used.has(value)) throw new Error('每项个人资料必须对应一个不同、可填写的字段。');
      used.add(value);
      approved[field.key] = value;
    }
    job.mappings = approved;
    job.status = 'queued';
    job.message = '已预约。电脑和本机代理须保持运行；可关闭控制台网页。';
    job.updatedAt = this.now();
    return this.summary(job);
  }

  cancel(id) {
    const job = this.get(id);
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.message = '已停止后续填写；已经填写的内容请在官方页面核对。';
    } else { job.status = 'cancelled'; job.message = '任务已取消，个人资料已从代理内存清除。'; }
    job.fields = [];
    job.updatedAt = this.now();
    return this.summary(job);
  }

  async tick() {
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || Date.parse(job.saleAt) > this.now()) continue;
      job.status = 'running';
      job.updatedAt = this.now();
      if (this.now() - Date.parse(job.saleAt) > 60000) {
        job.status = 'missed'; job.message = '电脑可能休眠或任务延迟，已停止自动填写，请手动处理。'; job.fields = []; continue;
      }
      try {
        const result = await this.driver.fill(job);
        if (job.status === 'cancelled') continue;
        job.filled = result.filled;
        job.status = result.filled === job.fields.length ? 'completed' : 'partial';
        job.message = result.filled === job.fields.length
          ? '资料已填入官方页面。请核对票档、人数及金额，并自行提交订单和付款。'
          : '页面可能已变化或需要验证，已停止后续填写，请接管官方页面。';
      } catch {
        if (job.status !== 'cancelled') { job.status = 'failed'; job.message = '页面已关闭、域名改变或字段失效。已停止填写，请手动处理。'; }
      } finally { job.fields = []; job.updatedAt = this.now(); }
    }
  }
}
