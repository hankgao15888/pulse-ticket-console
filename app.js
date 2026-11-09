(() => {
  "use strict";

  const STORAGE_KEY = "pulse-ticket-events-v1";
  const SETTINGS_KEY = "pulse-ticket-settings-v1";
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const DAY = 24 * HOUR;

  const TYPE_META = {
    train: { label: "火车票", long: "铁路出行", fallbackUrl: "https://www.12306.cn/index/" },
    concert: { label: "演唱会", long: "现场演出", fallbackUrl: "https://www.damai.cn/" },
    exhibition: { label: "展览", long: "展览 / 展演", fallbackUrl: "https://www.maoyan.com/" },
    sports: { label: "赛事", long: "体育赛事", fallbackUrl: "https://www.damai.cn/" },
    other: { label: "其他", long: "其他票务", fallbackUrl: "" },
  };

  const CHECK_ITEMS = [
    {
      id: "account",
      title: "官方账号已登录",
      detail: "确认账号可正常进入购票页，提前退出异常设备。",
    },
    {
      id: "identity",
      title: "实名信息已添加",
      detail: "观演人、乘车人、联系人信息已核验。",
    },
    {
      id: "payment",
      title: "支付链路已确认",
      detail: "余额、免密、银行卡限额与收货地址均可用。",
    },
    {
      id: "network",
      title: "网络与备用设备",
      detail: "稳定 Wi-Fi 加一部 5G 手机，关闭后台占网。",
    },
    {
      id: "official",
      title: "官方入口已收藏",
      detail: "场次页、官方 App 和公告页放到最容易点到的位置。",
    },
    {
      id: "strategy",
      title: "票档策略已决定",
      detail: "首选档位、可接受档位、备选日期和回流窗口都已明确。",
    },
  ];

  const emptyChecks = () =>
    Object.fromEntries(CHECK_ITEMS.map((item) => [item.id, false]));

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const state = {
    events: [],
    settings: {
      filter: "all",
      notifications: "default",
      sent: {},
    },
    editingId: null,
    featuredId: null,
    lastSaleState: "",
  };

  function uid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      // Invalid user URLs fall back to the task's official platform.
    }
    return "";
  }

  function chinaParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    return Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
  }

  function chinaWallTimeToIso(wallTime) {
    const match = String(wallTime).match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
    );
    if (!match) return "";
    const [, year, month, day, hour, minute] = match.map(Number);
    return new Date(
      Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0),
    ).toISOString();
  }

  function isoToChinaWallTime(iso) {
    const parts = chinaParts(new Date(iso));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }

  function futureChinaIso(daysAhead, hour, minute = 0) {
    const parts = chinaParts();
    return new Date(
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day) + daysAhead,
        hour - 8,
        minute,
        0,
        0,
      ),
    ).toISOString();
  }

  function formatDate(iso, options = {}) {
    if (!iso) return "时间待定";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      weekday: options.weekday ? "short" : undefined,
    }).format(new Date(iso));
  }

  function formatTime(iso) {
    if (!iso) return "--:--";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  }

  function formatDateTime(iso) {
    return `${formatDate(iso, { weekday: true })} ${formatTime(iso)}`;
  }

  function pad(value, length = 2) {
    return String(Math.max(0, value)).padStart(length, "0");
  }

  function splitDuration(milliseconds) {
    const safe = Math.max(0, milliseconds);
    return {
      days: Math.floor(safe / DAY),
      hours: Math.floor((safe % DAY) / HOUR),
      minutes: Math.floor((safe % HOUR) / MINUTE),
      seconds: Math.floor((safe % MINUTE) / 1000),
    };
  }

  function compactDuration(milliseconds) {
    if (milliseconds <= 0) return "已开售";
    const value = splitDuration(milliseconds);
    if (value.days > 0) return `${value.days}天 ${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
    return `${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
  }

  function cardDuration(milliseconds) {
    if (milliseconds <= 0) {
      const elapsed = Math.abs(milliseconds);
      if (elapsed < HOUR) return `已开售 ${Math.max(1, Math.floor(elapsed / MINUTE))} 分钟`;
      return `已开售 ${Math.floor(elapsed / HOUR)} 小时`;
    }
    const value = splitDuration(milliseconds);
    if (value.days > 0) return `${value.days}天 ${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
    return `${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
  }

  function statusFor(event, now = Date.now()) {
    const diff = new Date(event.saleAt).getTime() - now;
    if (diff > HOUR) return { key: "upcoming", label: "待开售", className: "" };
    if (diff > 0) return { key: "soon", label: "即将开售", className: "hot" };
    if (diff > -2 * HOUR) return { key: "live", label: "已开售 / 盯回流", className: "live" };
    return { key: "past", label: "已开售", className: "done" };
  }

  function normalizeEvent(input) {
    const type = TYPE_META[input?.type] ? input.type : "other";
    const saleAt = Number.isNaN(new Date(input?.saleAt).getTime())
      ? futureChinaIso(1, 12)
      : new Date(input.saleAt).toISOString();
    const checks = emptyChecks();
    for (const item of CHECK_ITEMS) {
      checks[item.id] = Boolean(input?.checks?.[item.id]);
    }
    return {
      id: String(input?.id || uid()),
      name: String(input?.name || "未命名场次").slice(0, 80),
      type,
      saleAt,
      place: String(input?.place || "").slice(0, 100),
      url: safeUrl(input?.url),
      notes: String(input?.notes || "").slice(0, 240),
      checks,
      createdAt: input?.createdAt || new Date().toISOString(),
    };
  }

  function sampleEvents() {
    return [
      normalizeEvent({
        id: uid(),
        name: "示例 · 周末高铁票",
        type: "train",
        saleAt: futureChinaIso(2, 8),
        place: "北京南 → 上海虹桥 · 二等座优先",
        url: "https://www.12306.cn/index/",
        notes: "示例任务：可编辑成你的常用路线。提前确认乘车人并设置候补。",
        checks: { identity: true, payment: true },
      }),
      normalizeEvent({
        id: uid(),
        name: "示例 · 城市音乐节",
        type: "concert",
        saleAt: futureChinaIso(4, 12),
        place: "上海 · 内场票优先",
        url: "https://www.damai.cn/",
        notes: "示例任务：提前决定票档，不要只盯最热门价位。",
        checks: { account: true },
      }),
    ];
  }

  function loadState() {
    const savedEvents = localStorage.getItem(STORAGE_KEY);
    if (savedEvents === null) {
      state.events = sampleEvents();
      saveEvents();
    } else {
      try {
        const parsed = JSON.parse(savedEvents);
        state.events = Array.isArray(parsed) ? parsed.map(normalizeEvent) : [];
      } catch {
        state.events = sampleEvents();
        saveEvents();
      }
    }

    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        state.settings.filter = parsed.filter || "all";
        state.settings.notifications = parsed.notifications || "default";
        state.settings.sent = parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {};
      } catch {
        // Keep defaults when settings are malformed.
      }
    }

    if (window.Notification) {
      state.settings.notifications = Notification.permission;
    }
  }

  function saveEvents() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.events));
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function pruneSentRecords(now = Date.now()) {
    const cutoff = now - 7 * DAY;
    let changed = false;
    for (const [key, timestamp] of Object.entries(state.settings.sent)) {
      if (Number(timestamp) < cutoff) {
        delete state.settings.sent[key];
        changed = true;
      }
    }
    if (changed) saveSettings();
  }

  function upcomingEvents() {
    const now = Date.now();
    return state.events
      .filter((event) => new Date(event.saleAt).getTime() > now)
      .sort((a, b) => new Date(a.saleAt) - new Date(b.saleAt));
  }

  function featuredEvent() {
    const upcoming = upcomingEvents();
    if (upcoming.length) return upcoming[0];
    const recent = [...state.events]
      .filter((event) => new Date(event.saleAt).getTime() <= Date.now())
      .sort((a, b) => new Date(b.saleAt) - new Date(a.saleAt));
    return recent[0] || null;
  }

  function getEvent(id) {
    return state.events.find((event) => event.id === id) || null;
  }

  function officialUrlFor(event) {
    return event?.url || TYPE_META[event?.type]?.fallbackUrl || "";
  }

  function domainFor(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "待添加";
    }
  }

  function renderFeatured() {
    const event = featuredEvent();
    state.featuredId = event?.id || null;

    const category = $("#featured-category");
    const status = $("#featured-status");
    const name = $("#featured-name");
    const place = $("#featured-place");
    const saleDate = $("#featured-sale-date");
    const saleTime = $("#featured-sale-time");
    const typeLong = $("#featured-type-long");
    const domain = $("#featured-domain");
    const launch = $("#featured-launch");
    const edit = $("#featured-edit");

    if (!event) {
      category.textContent = "暂无任务";
      status.textContent = "等待添加";
      name.textContent = "还差一个目标";
      place.textContent = "添加你的第一个开售场次，倒计时会出现在这里。";
      saleDate.textContent = "--月--日";
      saleTime.textContent = "--:--";
      typeLong.textContent = "未选择";
      domain.textContent = "待添加";
      launch.innerHTML = '打开官方入口 <span aria-hidden="true">↗</span>';
      edit.disabled = true;
      updateFeaturedCountdown(null);
      return;
    }

    const meta = TYPE_META[event.type];
    const eventStatus = statusFor(event);
    const url = officialUrlFor(event);

    category.textContent = meta.label;
    status.textContent = eventStatus.label;
    status.className = eventStatus.className;
    name.textContent = event.name;
    place.textContent = event.place || "尚未填写地点或座位需求";
    saleDate.textContent = formatDate(event.saleAt, { weekday: true });
    saleTime.textContent = formatTime(event.saleAt);
    typeLong.textContent = meta.long;
    domain.textContent = url ? domainFor(url) : "待添加";
    launch.innerHTML = `${url ? "打开官方入口" : "先添加官方链接"} <span aria-hidden="true">↗</span>`;
    edit.disabled = false;
    updateFeaturedCountdown(event);
  }

  function updateFeaturedCountdown(event) {
    const values = event
      ? splitDuration(new Date(event.saleAt).getTime() - Date.now())
      : { days: 0, hours: 0, minutes: 0, seconds: 0 };

    const safeValues = {
      days: Math.min(999, values.days),
      hours: values.hours,
      minutes: values.minutes,
      seconds: values.seconds,
    };

    $$("[data-countdown]").forEach((node) => {
      const unit = node.dataset.countdown;
      node.textContent = pad(safeValues[unit]);
    });

    let compact = "--:--:--";
    if (event) {
      const diff = new Date(event.saleAt).getTime() - Date.now();
      compact = diff > 0 ? compactDuration(diff) : "ALREADY LIVE";
    }
    $("#next-countdown-compact").textContent = compact;
  }

  function renderMetrics() {
    const now = Date.now();
    const upcoming = state.events.filter((event) => {
      const diff = new Date(event.saleAt).getTime() - now;
      return diff > 0 && diff <= 90 * DAY;
    });
    const live = state.events.filter((event) => {
      const diff = new Date(event.saleAt).getTime() - now;
      return diff <= 0 && diff > -6 * HOUR;
    });
    const featured = featuredEvent();
    const completed = featured
      ? CHECK_ITEMS.filter((item) => featured.checks?.[item.id]).length
      : 0;
    const readiness = featured ? Math.round((completed / CHECK_ITEMS.length) * 100) : 0;

    $("#metric-upcoming").textContent = upcoming.length;
    $("#metric-readiness").textContent = `${readiness}%`;
    $("#metric-backflow").textContent = live.length;
  }

  function renderChecklist() {
    const event = featuredEvent();
    const container = $("#checklist-items");

    if (!event) {
      container.innerHTML = `
        <div class="empty-state" style="min-height:160px">
          <div>
            <strong>先添加一场任务</strong>
            <p>检查项会绑定到下一场开售任务，方便你逐项确认。</p>
            <button class="button button-accent" data-open-event-modal type="button">添加场次</button>
          </div>
        </div>
      `;
      $("#checklist-label").textContent = "0 / 6";
      $("#checklist-progress").style.width = "0%";
      return;
    }

    container.innerHTML = CHECK_ITEMS.map((item) => {
      const checked = Boolean(event.checks?.[item.id]);
      return `
        <label class="check-item">
          <input type="checkbox" data-check-id="${item.id}" ${checked ? "checked" : ""} />
          <span class="check-box" aria-hidden="true">${checked ? "✓" : ""}</span>
          <span class="check-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.detail)}</small>
          </span>
        </label>
      `;
    }).join("");

    const completed = CHECK_ITEMS.filter((item) => event.checks?.[item.id]).length;
    $("#checklist-label").textContent = `${completed} / ${CHECK_ITEMS.length}`;
    $("#checklist-progress").style.width = `${(completed / CHECK_ITEMS.length) * 100}%`;
  }

  function renderFilters() {
    $$("#filter-row .filter").forEach((button) => {
      const filter = button.dataset.filter;
      const count =
        filter === "all"
          ? state.events.length
          : state.events.filter((event) => event.type === filter).length;
      button.querySelector("span").textContent = count;
      button.classList.toggle("active", state.settings.filter === filter);
    });
  }

  function sortedEventsForDisplay() {
    const now = Date.now();
    return [...state.events].sort((a, b) => {
      const aTime = new Date(a.saleAt).getTime();
      const bTime = new Date(b.saleAt).getTime();
      const aFuture = aTime > now;
      const bFuture = bTime > now;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      return aFuture ? aTime - bTime : bTime - aTime;
    });
  }

  function renderEvents() {
    const grid = $("#event-grid");
    const filtered = sortedEventsForDisplay().filter(
      (event) => state.settings.filter === "all" || event.type === state.settings.filter,
    );

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div>
            <strong>${state.events.length ? "这个分类还没有任务" : "作战板还是空的"}</strong>
            <p>${state.events.length ? "切换分类，或添加另一个目标。" : "把下一张火车票、演出票或赛事票放进来，PULSE 会替你盯住倒计时。"}</p>
            <button class="button button-accent" data-open-event-modal type="button">添加场次</button>
          </div>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map((event, index) => {
      const meta = TYPE_META[event.type];
      const status = statusFor(event);
      const url = officialUrlFor(event);
      const diff = new Date(event.saleAt).getTime() - Date.now();
      const isPast = diff <= 0;
      const completed = CHECK_ITEMS.filter((item) => event.checks?.[item.id]).length;
      return `
        <article class="event-card ${isPast ? "is-past" : ""}" style="animation-delay:${Math.min(index * 45, 220)}ms" data-event-id="${escapeHtml(event.id)}">
          <div class="event-card-top">
            <span class="category-chip">${escapeHtml(meta.label)}</span>
            <span class="event-status ${status.className}">${escapeHtml(status.label)}</span>
          </div>
          <h3>${escapeHtml(event.name)}</h3>
          <p class="event-place">${escapeHtml(event.place || "地点 / 座位需求待补充")}</p>
          ${event.notes ? `<p class="event-note">${escapeHtml(event.notes)}</p>` : ""}
          <div class="event-date-row">
            <div class="event-date">
              <span>SALE / ${completed} OF 6 READY</span>
              <strong>${formatDateTime(event.saleAt)}</strong>
            </div>
            <strong class="event-card-countdown ${status.key === "soon" ? "hot" : ""}" data-event-countdown="${escapeHtml(event.id)}">
              ${cardDuration(diff)}
            </strong>
          </div>
          <div class="event-card-actions">
            <button class="button button-dark" type="button" data-launch-event="${escapeHtml(event.id)}" ${url ? "" : "disabled"}>
              官方入口 <span aria-hidden="true">↗</span>
            </button>
            <button class="mini-action" type="button" data-edit-event="${escapeHtml(event.id)}" aria-label="编辑 ${escapeHtml(event.name)}">✎</button>
            <button class="mini-action delete" type="button" data-delete-event="${escapeHtml(event.id)}" aria-label="删除 ${escapeHtml(event.name)}">×</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderRadar() {
    const event = featuredEvent();
    const status = $("#radar-status");
    const steps = $$(".radar-step");
    steps.forEach((step) => step.classList.remove("active"));

    if (!event) {
      status.textContent = "添加并开售后，这里会显示当前可关注的回流窗口。";
      return;
    }

    const diff = Date.now() - new Date(event.saleAt).getTime();
    if (diff < 0) {
      status.textContent = `距开售还有 ${compactDuration(-diff)}。建议先完成上方六项检查。`;
      return;
    }

    const elapsedMinutes = diff / MINUTE;
    let activeWindow = null;
    if (elapsedMinutes < 5) {
      status.textContent = "刚刚开售：先完成当前订单与支付，不要反复刷新排队页。";
    } else if (elapsedMinutes < 10) {
      activeWindow = 5;
      status.textContent = "现在关注 +05 分钟窗口：首批未支付订单可能开始释放。";
    } else if (elapsedMinutes < 15) {
      activeWindow = 10;
      status.textContent = "现在关注 +10 分钟窗口：留意官方页面刷新与分批放票。";
    } else if (elapsedMinutes < 30) {
      activeWindow = 15;
      status.textContent = "现在关注 +15 分钟窗口：退票和官方候补可能开始兑现。";
    } else if (elapsedMinutes < 60) {
      activeWindow = 30;
      status.textContent = "现在关注 +30 分钟窗口：做最后一次回流检查。";
    } else {
      status.textContent = "开售已超过 1 小时：继续关注官方退票、候补或后续场次公告。";
    }

    if (activeWindow) {
      const active = steps.find(
        (step) => Number(step.dataset.window) === activeWindow,
      );
      active?.classList.add("active");
    }
  }

  function renderAll() {
    renderFeatured();
    renderMetrics();
    renderChecklist();
    renderFilters();
    renderEvents();
    renderRadar();
    renderNotificationState();
    updateClocks();
  }

  function renderNotificationState() {
    const button = $("#notification-button");
    if (!window.Notification) {
      button.textContent = "浏览器不支持提醒";
      button.disabled = true;
      return;
    }

    if (Notification.permission === "granted") {
      button.innerHTML = '<span class="button-icon" aria-hidden="true">●</span> 提醒已开启';
    } else if (Notification.permission === "denied") {
      button.innerHTML = '<span class="button-icon" aria-hidden="true">×</span> 通知被阻止';
    } else {
      button.innerHTML = '<span class="button-icon" aria-hidden="true">◉</span> 开启提醒';
    }
    state.settings.notifications = Notification.permission;
  }

  function updateClocks() {
    const now = new Date();
    const parts = chinaParts(now);
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;
    $("#header-clock").textContent = time;
    $("#hero-clock").textContent = time;
    $("#hero-date").textContent = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(now);
  }

  function updateLiveTimes() {
    const event = featuredEvent();
    updateFeaturedCountdown(event);
    updateClocks();

    $$("[data-event-countdown]").forEach((node) => {
      const event = getEvent(node.dataset.eventCountdown);
      if (!event) return;
      const diff = new Date(event.saleAt).getTime() - Date.now();
      node.textContent = cardDuration(diff);
      node.classList.toggle("hot", diff > 0 && diff <= HOUR);
    });

    const currentState = event ? statusFor(event).key : "none";
    if (state.lastSaleState && state.lastSaleState !== currentState) {
      renderAll();
    }
    state.lastSaleState = currentState;
    renderRadar();
  }

  function showToast(message, type = "success") {
    const region = $("#toast-region");
    const toast = document.createElement("div");
    toast.className = `toast ${type === "error" ? "error" : ""}`;
    toast.innerHTML = `
      <span class="toast-mark" aria-hidden="true">${type === "error" ? "!" : "✓"}</span>
      <span>${escapeHtml(message)}</span>
    `;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4600);
  }

  function openOfficial(event) {
    const url = officialUrlFor(event);
    if (!url) {
      showToast("这个场次还没有官方链接，先编辑补充。", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openEventDialog(id = null) {
    const event = id ? getEvent(id) : null;
    state.editingId = event?.id || null;
    $("#event-form").reset();
    $("#event-id").value = event?.id || "";
    $("#event-name").value = event?.name || "";
    $("#event-type").value = event?.type || "train";
    $("#event-sale-at").value = event ? isoToChinaWallTime(event.saleAt) : "";
    $("#event-place").value = event?.place || "";
    $("#event-url").value = event?.url || "";
    $("#event-notes").value = event?.notes || "";
    $("#dialog-kicker").textContent = event ? "Edit mission" : "New mission";
    $("#dialog-title").textContent = event ? "编辑场次" : "添加场次";

    const dialog = $("#event-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    window.setTimeout(() => $("#event-name").focus(), 50);
  }

  function closeEventDialog() {
    const dialog = $("#event-dialog");
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    state.editingId = null;
  }

  function submitEvent(formData) {
    const saleAt = chinaWallTimeToIso(String(formData.get("saleAt") || ""));
    if (!saleAt) {
      showToast("请填写有效的开售日期与时间。", "error");
      return;
    }

    const name = String(formData.get("name") || "").trim();
    if (!name) {
      showToast("场次名称不能为空。", "error");
      return;
    }

    const urlInput = String(formData.get("url") || "").trim();
    const url = safeUrl(urlInput);
    if (urlInput && !url) {
      showToast("链接必须是 http 或 https 官方地址。", "error");
      return;
    }

    const existing = state.editingId ? getEvent(state.editingId) : null;
    const event = normalizeEvent({
      id: existing?.id || uid(),
      name,
      type: formData.get("type"),
      saleAt,
      place: formData.get("place"),
      url,
      notes: formData.get("notes"),
      checks: existing?.checks || emptyChecks(),
      createdAt: existing?.createdAt,
    });

    if (existing) {
      state.events = state.events.map((item) =>
        item.id === existing.id ? event : item,
      );
      showToast("场次已更新。");
    } else {
      state.events.push(event);
      showToast("场次已加入作战板。");
    }

    saveEvents();
    closeEventDialog();
    renderAll();
  }

  function deleteEvent(id) {
    const event = getEvent(id);
    if (!event) return;
    if (!window.confirm(`删除“${event.name}”？\n该场次的本地检查记录也会一并删除。`)) return;
    state.events = state.events.filter((item) => item.id !== id);
    saveEvents();
    renderAll();
    showToast("场次已删除。");
  }

  function toggleCheck(checkId, checked) {
    const event = featuredEvent();
    if (!event || !CHECK_ITEMS.some((item) => item.id === checkId)) return;
    event.checks[checkId] = checked;
    saveEvents();
    renderChecklist();
    renderMetrics();
    renderEvents();
  }

  function resetChecklist() {
    const event = featuredEvent();
    if (!event) return;
    event.checks = emptyChecks();
    saveEvents();
    renderAll();
    showToast("下一场任务的检查项已重置。");
  }

  async function requestNotifications() {
    if (!window.Notification) {
      showToast("当前浏览器不支持系统通知。", "error");
      return;
    }
    if (Notification.permission === "denied") {
      showToast("通知已被浏览器阻止，请在网站设置中重新允许。", "error");
      return;
    }
    const permission = await Notification.requestPermission();
    state.settings.notifications = permission;
    saveSettings();
    renderNotificationState();
    if (permission === "granted") {
      new Notification("PULSE 提醒已开启", {
        body: "页面打开期间，会在开售前 60、10、1 分钟提醒你。",
        icon: "./pulse-mark.svg",
      });
      showToast("已开启 T-60 / T-10 / T-1 分钟提醒。");
    } else {
      showToast("没有获得通知权限，仍可查看页面倒计时。", "error");
    }
  }

  function notifyEvent(event, offsetMinutes) {
    const title =
      offsetMinutes === 0
        ? `现在开售：${event.name}`
        : `T-${offsetMinutes} 分钟：${event.name}`;
    const body = `开售时间 ${formatDateTime(event.saleAt)}。请回到官方 App / 页面完成操作。`;

    if (window.Notification && Notification.permission === "granted") {
      new Notification(title, {
        body,
        icon: "./pulse-mark.svg",
        tag: `${event.id}-${offsetMinutes}`,
      });
    }
    showToast(`${title}。${body}`);
  }

  function checkReminders() {
    const now = Date.now();
    const reminderOffsets = [60, 10, 1, 0];

    for (const event of state.events) {
      const saleAt = new Date(event.saleAt).getTime();
      const diff = saleAt - now;
      if (diff < -5 * 1000 || diff > 60 * MINUTE) continue;

      for (const offset of reminderOffsets) {
        const target = offset * MINUTE;
        const key = `${event.id}:${new Date(event.saleAt).getTime()}:${offset}`;
        const shouldFire =
          diff <= target && diff > target - 4500 && !state.settings.sent[key];
        if (!shouldFire) continue;
        state.settings.sent[key] = now;
        notifyEvent(event, offset);
      }
    }

    saveSettings();
  }

  function exportData() {
    const payload = {
      app: "PULSE",
      version: 1,
      exportedAt: new Date().toISOString(),
      events: state.events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = chinaParts().day + chinaParts().month + chinaParts().year;
    link.href = url;
    link.download = `pulse-tickets-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("本地数据已导出。");
  }

  async function importData(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const importedEvents = Array.isArray(parsed) ? parsed : parsed.events;
      if (!Array.isArray(importedEvents)) throw new Error("Invalid backup");
      const normalized = importedEvents.map(normalizeEvent);
      if (!normalized.length) throw new Error("No events");
      if (
        !window.confirm(
          `导入 ${normalized.length} 个场次？这会替换当前浏览器中的所有场次。`,
        )
      ) {
        return;
      }
      state.events = normalized;
      saveEvents();
      renderAll();
      showToast(`已导入 ${normalized.length} 个场次。`);
    } catch {
      showToast("备份文件无法读取，请选择 PULSE 导出的 JSON 文件。", "error");
    } finally {
      $("#import-data").value = "";
    }
  }

  function clearAllData() {
    if (
      !window.confirm(
        "清空所有场次、检查项和提醒记录？\n此操作只影响当前浏览器，无法撤销。",
      )
    ) {
      return;
    }
    state.events = [];
    state.settings.sent = {};
    saveEvents();
    saveSettings();
    renderAll();
    showToast("本地数据已清空。");
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const addButton = event.target.closest("[data-open-event-modal]");
      if (addButton) {
        openEventDialog();
        return;
      }

      const editButton = event.target.closest("[data-edit-event]");
      if (editButton) {
        openEventDialog(editButton.dataset.editEvent);
        return;
      }

      const deleteButton = event.target.closest("[data-delete-event]");
      if (deleteButton) {
        deleteEvent(deleteButton.dataset.deleteEvent);
        return;
      }

      const launchButton = event.target.closest("[data-launch-event]");
      if (launchButton) {
        const task = getEvent(launchButton.dataset.launchEvent);
        if (task) openOfficial(task);
        return;
      }

      const filterButton = event.target.closest(".filter");
      if (filterButton) {
        state.settings.filter = filterButton.dataset.filter;
        saveSettings();
        renderFilters();
        renderEvents();
      }
    });

    $("#event-form").addEventListener("submit", (event) => {
      event.preventDefault();
      submitEvent(new FormData(event.currentTarget));
    });

    $("#dialog-close").addEventListener("click", closeEventDialog);
    $("#dialog-cancel").addEventListener("click", closeEventDialog);

    $("#event-dialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeEventDialog();
    });

    $("#checklist-items").addEventListener("change", (event) => {
      const input = event.target.closest("[data-check-id]");
      if (input) toggleCheck(input.dataset.checkId, input.checked);
    });

    $("#reset-checklist").addEventListener("click", resetChecklist);
    $("#notification-button").addEventListener("click", requestNotifications);

    $("#featured-launch").addEventListener("click", () => {
      const event = featuredEvent();
      if (event) openOfficial(event);
      else openEventDialog();
    });

    $("#featured-edit").addEventListener("click", () => {
      if (state.featuredId) openEventDialog(state.featuredId);
    });

    $("#export-data").addEventListener("click", exportData);
    $("#import-data").addEventListener("change", (event) =>
      importData(event.target.files?.[0]),
    );
    $("#clear-all").addEventListener("click", clearAllData);

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      loadState();
      renderAll();
    });
  }

  function init() {
    loadState();
    pruneSentRecords();
    bindEvents();
    renderAll();
    $("#footer-year").textContent = new Date().getFullYear();
    state.lastSaleState = featuredEvent() ? statusFor(featuredEvent()).key : "none";

    window.setInterval(() => {
      updateLiveTimes();
      checkReminders();
    }, 1000);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // The app remains fully usable without offline caching.
      });
    }
  }

  init();
})();
