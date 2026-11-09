(() => {
  'use strict';
  const local = location.origin === 'http://127.0.0.1:4180';
  const $ = (s) => document.querySelector(s);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
  const labels = { fullName: '姓名', phone: '手机号', documentNumber: '证件号码', quantity: '票数' };
  const states = { draft: '等待准备', preparing: '正在识别', needs_mapping: '待确认字段', needs_verification: '待登录或验证', origin_changed: '待核对域名', queued: '已预约', running: '正在填写', completed: '已填写 · 待手动下单', partial: '部分填写 · 请接管', failed: '执行失败', cancelled: '已取消', missed: '错过执行时间' };
  let key = '';
  let jobs = [];
  let currentEvent = null;
  let polling = false;
  const selections = new Map();
  const pending = new Set();

  const panel = document.createElement('section');
  panel.className = 'panel section-shell agent-panel';
  panel.id = 'agent-panel';
  panel.innerHTML = `
    <div class="panel-heading"><div><p class="kicker">LOCAL ASSISTANT / BETA</p><h2>本机定时填表代理</h2></div><span id="agent-connection" class="agent-badge">${local ? '连接中' : '网页版 · 未连接代理'}</span></div>
    <p class="panel-intro">添加链接、开售时间和资料，先在官方页面完成登录、选好票档，再识别并确认填写位置。到时自动填入已确认的字段，提交订单与付款由你完成。</p>
    <div class="agent-guide"><span>01 添加资料</span><span>02 打开并识别</span><span>03 确认并预约</span><span>04 核对并下单</span></div>
    <div class="agent-actions"><a class="button button-dark" href="http://127.0.0.1:4180" target="_blank" rel="noreferrer">打开本机代理 ↗</a><a class="button button-outline" href="https://github.com/hankgao15888/pulse-ticket-console" target="_blank" rel="noreferrer">GitHub 项目</a><a class="button button-outline" href="https://github.com/hankgao15888/pulse-ticket-console/archive/refs/heads/main.zip">下载代理程序</a><button class="button button-outline" id="agent-damai" type="button">添加这场大麦</button>${local ? '<button class="button button-outline" id="agent-demo" type="button">本机演练</button>' : ''}</div>
    <p class="agent-help">解压后双击 start.cmd，需要 Node.js 22+ 和 Microsoft Edge。任务运行期间请保持代理程序和购票浏览器开启，电脑不能休眠。资料只保存在代理内存，退出程序后清除。</p>
    <p id="agent-feedback" class="agent-feedback" role="status"></p><div id="agent-jobs" class="agent-jobs"></div>`;
  $('.metrics').before(panel);

  const fields = document.createElement('fieldset');
  fields.className = 'agent-fields field full';
  fields.innerHTML = `
    <legend>定时填表</legend>
    <label class="agent-toggle"><input id="agent-enabled" type="checkbox" ${local ? '' : 'disabled'}> 保存为本机代理任务</label>
    <p class="agent-help">${local ? '姓名、手机号和证件号不会进入场次备份；保存后清空表单，只留在本机代理内存。' : 'GitHub 网页无法控制购票网站。先下载并启动代理，在本机控制台添加资料。'}</p>
    <div id="agent-person-fields" class="form-grid" hidden>
      <label class="field"><span>姓名</span><input id="agent-fullName" type="text" autocomplete="off" maxlength="60" placeholder="与官方实名信息一致"></label>
      <label class="field"><span>手机号</span><input id="agent-phone" type="tel" autocomplete="off" maxlength="25"></label>
      <label class="field full"><span>证件号码（可选）</span><input id="agent-documentNumber" type="password" autocomplete="off" maxlength="100"><small>只有你确认了官方目标字段，才会填入该字段。</small></label>
      <label class="field"><span>票数</span><input id="agent-quantity" type="number" min="1" max="6" value="1"></label>
      <p class="agent-help" id="agent-existing"></p>
    </div>`;
  $('#event-notes').closest('label').before(fields);
  const linkField = $('#event-url').closest('label');
  linkField.parentElement.prepend(linkField);
  $('#event-url').addEventListener('change', () => {
    try {
      const url = new URL($('#event-url').value);
      if (url.hostname === 'detail.damai.cn') {
        $('#event-type').value = 'concert';
        if (!$('#event-name').value.trim()) $('#event-name').value = `大麦场次 · ${url.searchParams.get('id') || '待核对'}`;
      } else if (url.hostname === '12306.cn' || url.hostname.endsWith('.12306.cn')) $('#event-type').value = 'train';
    } catch { /* The main form validates the URL before saving. */ }
  });
  $('#agent-enabled').addEventListener('change', () => { $('#agent-person-fields').hidden = !$('#agent-enabled').checked; });

  function feedback(text, error = false) {
    $('#agent-feedback').textContent = text;
    $('#agent-feedback').classList.toggle('error', error);
  }

  async function api(path, data) {
    if (!local) throw new Error('请在本机代理控制台操作。');
    if (!key) {
      const session = await fetch('/api/session', { cache: 'no-store' });
      if (!session.ok) throw new Error('本机代理未启动。');
      key = (await session.json()).token;
    }
    const response = await fetch(`/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-Pulse-Key': key, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) { if (response.status === 403) key = ''; throw new Error(result.error || '代理请求失败。'); }
    return result;
  }

  function renderJobs() {
    const active = document.activeElement;
    if ($('#agent-jobs').contains(active) && active?.tagName === 'SELECT') return;
    $('#agent-jobs').innerHTML = jobs.map((job) => {
      const terminal = ['completed', 'partial', 'failed', 'cancelled', 'missed'].includes(job.status);
      const waiting = pending.has(job.id);
      const remembered = selections.get(job.id) || job.mappings;
      const mappings = job.status === 'needs_mapping' && job.candidates.length ? `<div class="agent-mappings">${job.fields.map((field) => `
        <label class="field"><span>${esc(labels[field.key] || field.key)} → 官方字段</span><select data-job="${esc(job.id)}" data-map="${esc(field.key)}"><option value="">请选择目标字段</option>${job.candidates.map((candidate) => `<option value="${esc(candidate.id)}" ${remembered[field.key] === candidate.id ? 'selected' : ''}>${esc(candidate.label)} · ${esc(candidate.tag)} (${esc(candidate.id)})</option>`).join('')}</select></label>`).join('')}</div>` : '';
      return `<article class="agent-job"><div class="agent-job-head"><h3>${esc(job.name)}</h3><span class="agent-badge ${job.status === 'queued' ? 'ready' : ''}">${esc(states[job.status] || job.status)}</span></div>
        <p class="agent-origin">${esc(job.currentOrigin || job.origin)} · ${esc(new Date(job.saleAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</p>
        <p>${esc(job.message)}</p>${mappings}
        <div class="agent-actions">${!terminal && job.status !== 'queued' && job.status !== 'running' ? `<button class="button button-outline" data-agent-action="inspect" data-job="${esc(job.id)}" ${waiting ? 'disabled' : ''}>${waiting ? '正在处理…' : '打开页面 / 重新识别'}</button>` : ''}
        ${job.status === 'needs_mapping' && job.candidates.length ? `<button class="button button-accent" data-agent-action="arm" data-job="${esc(job.id)}" ${waiting ? 'disabled' : ''}>确认字段并预约</button>` : ''}
        ${job.status === 'origin_changed' ? `<button class="button button-accent" data-agent-action="approve-origin" data-job="${esc(job.id)}" ${waiting ? 'disabled' : ''}>核对并授权当前域名</button>` : ''}
        ${!terminal ? `<button class="button button-quiet" data-agent-action="cancel" data-job="${esc(job.id)}">取消任务</button>` : ''}</div></article>`;
    }).join('') || '<p class="agent-help">暂无代理任务。在“添加场次”中启用定时填表，保存后会显示在这里。</p>';
  }

  async function refresh() {
    if (!local || polling) return;
    polling = true;
    try {
      jobs = (await api('jobs')).jobs;
      $('#agent-connection').textContent = '本机代理已连接';
      renderJobs();
    } catch { $('#agent-connection').textContent = '代理未连接 · 请启动 start.cmd'; }
    finally { polling = false; }
  }

  $('#agent-jobs').addEventListener('change', (event) => {
    const input = event.target.closest('[data-map]');
    if (!input) return;
    const job = jobs.find((item) => item.id === input.dataset.job);
    const saved = selections.get(job.id) || { ...job.mappings };
    saved[input.dataset.map] = input.value;
    selections.set(job.id, saved);
  });

  $('#agent-jobs').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-agent-action]');
    if (!button) return;
    const id = button.dataset.job;
    const action = button.dataset.agentAction;
    if (pending.has(id) && action !== 'cancel') return;
    const job = jobs.find((item) => item.id === id);
    if (action === 'approve-origin' && !confirm(`请确认资料可以填入这个官方域名：\n${job.currentOrigin}\n仅限同一票务平台。`)) return;
    if (action === 'arm' && !confirm(`在北京时间 ${new Date(job.saleAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 自动将资料填入\n${job.origin}\n请确认目标字段和页面正确。此任务不提交订单或付款。`)) return;
    pending.add(id); renderJobs();
    try {
      await api(`jobs/${id}/${action}`, action === 'arm' ? { mappings: selections.get(id) || job.mappings } : action === 'approve-origin' ? { origin: job.currentOrigin } : {});
      if (action === 'inspect') selections.delete(id);
      feedback(action === 'arm' ? '任务已预约；关闭控制台网页后仍由本机代理执行。' : '任务状态已更新。');
    } catch (error) { feedback(error.message, true); }
    finally { pending.delete(id); await refresh(); }
  });

  function clearPersonalFields() {
    for (const field of ['fullName', 'phone', 'documentNumber']) $(`#agent-${field}`).value = '';
  }

  window.PulseAgent = {
    reset(event) {
      currentEvent = event;
      clearPersonalFields();
      $('#agent-enabled').checked = local && Boolean(event?.agentJobId);
      $('#agent-person-fields').hidden = !$('#agent-enabled').checked;
      $('#agent-quantity').value = 1;
      $('#agent-existing').textContent = event?.agentJobId ? '已关联代理任务。更改链接、时间或资料时，需重新填写资料并重新预约。' : '';
    },
    clearPersonalFields,
    async cancel(id) {
      try { await api(`jobs/${id}/cancel`, {}); }
      catch (error) { if (!error.message.includes('不存在')) throw error; }
      await refresh();
    },
    async save(event) {
      const previous = currentEvent;
      if (!$('#agent-enabled').checked) {
        if (previous?.agentJobId) await this.cancel(previous.agentJobId);
        return null;
      }
      const person = Object.fromEntries(['fullName', 'phone', 'documentNumber'].map((name) => [name, $(`#agent-${name}`).value.trim()]));
      if (!Object.values(person).some(Boolean) && previous?.agentJobId) {
        const existing = jobs.find((job) => job.id === previous.agentJobId);
        if (existing && event.url === previous.url && event.saleAt === previous.saleAt) return existing.id;
        throw new Error('修改或恢复代理任务时，请重新输入个人资料。');
      }
      if (!event.url) throw new Error('代理任务必须填写官方链接。');
      const created = (await api('jobs', { eventId: event.id, name: event.name, saleAt: event.saleAt, url: event.url, person, quantity: Number($('#agent-quantity').value) })).job;
      try { if (previous?.agentJobId) await this.cancel(previous.agentJobId); }
      catch (error) { await this.cancel(created.id); throw error; }
      await refresh();
      feedback('资料已交给本机代理。请打开页面、识别字段并确认预约。');
      return created.id;
    },
  };

  $('#agent-demo')?.addEventListener('click', () => {
    document.querySelector('[data-open-event-modal]').click();
    $('#event-name').value = '本机填表演练';
    $('#event-type').value = 'other';
    $('#event-url').value = 'http://127.0.0.1:4180/demo.html';
    const future = new Date(Date.now() + 5 * 60000 + 8 * 3600000).toISOString().slice(0, 16);
    $('#event-sale-at').value = future;
    $('#agent-enabled').checked = true;
    $('#agent-person-fields').hidden = false;
    $('#agent-fullName').value = '演练用户';
    $('#agent-phone').value = '13800000000';
    $('#agent-documentNumber').value = 'DEMO-NOT-A-REAL-ID';
  });

  $('#agent-damai').addEventListener('click', () => {
    document.querySelector('[data-open-event-modal]').click();
    $('#event-name').value = '卓沅2026 K.E.Y · 上海站（待核对）';
    $('#event-type').value = 'concert';
    $('#event-url').value = 'https://detail.damai.cn/item.htm?id=1092331547013';
    $('#event-place').value = '上海 · 请在官方页面核对场次与票档';
    if (local) { $('#agent-enabled').checked = true; $('#agent-person-fields').hidden = false; }
  });

  refresh();
  if (local) setInterval(refresh, 2500);
})();
