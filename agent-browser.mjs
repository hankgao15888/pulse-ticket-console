export class BrowserDriver {
  constructor(chromium) { this.chromium = chromium; this.browser = null; this.pages = new Map(); }

  async pageFor(job) {
    if (this.pages.has(job.id)) {
      const page = this.pages.get(job.id);
      if (!page.isClosed()) return page;
      throw new Error('Page closed');
    }
    if (!this.browser?.isConnected()) this.browser = await this.chromium.launch({ channel: 'msedge', headless: false });
    // Use a separate context per task so unrelated accounts and jobs cannot mix.
    const context = await this.browser.newContext();
    const page = await context.newPage();
    this.pages.set(job.id, page);
    context.on('page', (next) => this.pages.set(job.id, next));
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  }

  async scan(page) {
    return page.locator('input, textarea, select').evaluateAll((elements) => elements.map((element, index) => {
      const style = getComputedStyle(element);
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      const label = (Array.from(element.labels || []).map((item) => item.innerText).join(' ') || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.name || element.id || '').trim().slice(0, 100);
      return {
        id: String(index), label, type, tag: element.tagName.toLowerCase(),
        fingerprint: [element.tagName, element.id, element.name, type, label].join('|'),
        visible: !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none',
        blocked: element.disabled || element.readOnly || !['text', 'tel', 'email', 'number', 'date', 'search', ''].includes(type)
          || /搜索|search|密码|验证码|短信|支付|银行卡|password|captcha|otp|card number/i.test(label),
      };
    }).filter((item) => item.visible && item.label && !item.blocked).slice(0, 80));
  }

  async blocked(page) {
    const text = (await page.locator('body').innerText()).slice(0, 20000);
    const verification = /拖动.{0,15}滑块|完成.{0,8}验证|验证.{0,8}后继续|扫码登录|请先登录|正在排队|排队中|安全验证|访问过于频繁|验证码|verify you are human/i.test(text);
    const password = await page.locator('input[type="password"]:visible').count();
    return verification || password > 0;
  }

  async inspect(job) {
    const page = await this.pageFor(job);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    return { origin: new URL(page.url()).origin, blocked: await this.blocked(page), candidates: await this.scan(page) };
  }

  async fill(job) {
    const page = this.pages.get(job.id);
    let filled = 0;
    if (!page || page.isClosed()) throw new Error('Page closed');
    for (const field of job.fields) {
      if (job.status === 'cancelled') break;
      if (new URL(page.url()).origin !== new URL(job.url).origin || await this.blocked(page)) break;
      const approved = job.candidates.find((item) => item.id === job.mappings[field.key]);
      const current = (await this.scan(page)).filter((item) => item.fingerprint === approved?.fingerprint);
      if (current.length !== 1) break;
      const target = page.locator('input, textarea, select').nth(Number(current[0].id));
      // Never click order/checkout/payment controls or accept hidden consent fields.
      if (current[0].tag === 'select') await target.selectOption({ label: field.value }, { timeout: 1500 });
      else await target.fill(field.value, { timeout: 1500 });
      filled++;
    }
    return { filled };
  }

  async close() { await this.browser?.close(); }
}
