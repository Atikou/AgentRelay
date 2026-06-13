const feed = document.getElementById("feed");
const modelSelect = document.getElementById("model-select");
const systemInput = document.getElementById("system-input");
const sensitiveInput = document.getElementById("sensitive-input");
const autoConfirmInput = document.getElementById("autoconfirm-input");
const modeSelect = document.getElementById("mode-select");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const profileTag = document.getElementById("profile-tag");
const sidebarHistoryList = document.getElementById("sidebar-history-list");

let appConfig = null;
const ACTIVE_SESSION_KEY = "agentrelay.activeSessionId";
let activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || undefined;

function setActiveSessionId(sessionId) {
  activeSessionId = sessionId || undefined;
  if (activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
}

function sessionMeta() {
  return activeSessionId ? ` · session ${activeSessionId.slice(0, 8)}…` : "";
}

function clearWelcome() {
  feed.querySelectorAll(".welcome, .home-page, .test-page-shell").forEach((el) => el.remove());
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function renderHomeHistory() {
  renderWelcome();
  await loadHistorySessions();
}

function renderWelcome() {
  feed.innerHTML = `
    <div class="welcome">
      <div class="welcome-kicker">AgentRelay</div>
      <h1>Agent 编排控制台</h1>
      <p>模型路由、工具执行、上下文记忆、后台任务和调度触发集中在一个本地后端里。</p>
      <div class="welcome-actions">
        <button class="action-btn" data-action="check-models">检测模型</button>
        <a class="action-btn secondary" href="/test-cases.html">测试用例</a>
        <button class="action-btn secondary" data-action="view-config">查看配置</button>
      </div>
      <div class="welcome-grid">
        <div class="welcome-tile"><span>Run 编排</span><strong>统一追踪</strong></div>
        <div class="welcome-tile"><span>本地优先</span><strong>模型路由</strong></div>
        <div class="welcome-tile"><span>测试验收</span><strong>用例工作台</strong></div>
        <div class="welcome-tile"><span>上下文</span><strong>历史会话</strong></div>
      </div>
    </div>`;
}

async function loadHistorySessions() {
  const list = sidebarHistoryList;
  if (!list) return;
  try {
    const data = await api("/api/context/sessions");
    const sessions = [...(data.sessions || [])].sort(
      (a, b) => new Date(b.updatedAt || b.updated_at || 0) - new Date(a.updatedAt || a.updated_at || 0),
    );
    if (sessions.length === 0) {
      list.innerHTML = `
        <div class="sidebar-history-empty">
          暂无历史会话
        </div>`;
      return;
    }

    list.innerHTML = sessions
      .map((s) => {
        const updated = s.updatedAt ?? s.updated_at;
        const created = s.createdAt ?? s.created_at;
        const active = s.id === activeSessionId ? " active" : "";
        const title = s.title || "未命名会话";
        return `
          <button class="sidebar-session${active}" data-action="resume-session" data-session-id="${escapeHtml(s.id)}">
            <span>${escapeHtml(title)}</span>
            <small>${escapeHtml(formatDateTime(updated))} · ${escapeHtml(s.id.slice(0, 8))}</small>
          </button>`;
      })
      .join("");
  } catch (err) {
    list.innerHTML = `<div class="sidebar-history-empty is-error">${escapeHtml(String(err.message || err))}</div>`;
  }
}

function scrollToBottom() {
  feed.scrollTo({ top: feed.scrollHeight, behavior: "auto" });
}

function scrollToBottomAfterLayout() {
  requestAnimationFrame(() => {
    scrollToBottom();
    requestAnimationFrame(() => {
      const last =
        feed.querySelector(".conversation-scroll-anchor") ||
        feed.querySelector(".history-message:last-of-type") ||
        feed.lastElementChild;
      last?.scrollIntoView({ block: "end" });
    });
  });
}

function roleLabel(role) {
  return {
    user: "用户",
    assistant: "助手",
    tool: "工具",
    system: "系统",
  }[role] || role;
}

function messageClass(role) {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function renderStoredMessage(message) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${messageClass(message.role)} history-message`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = message.content || "";
  wrap.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = `${roleLabel(message.role)} · ${formatDateTime(message.createdAt ?? message.created_at)}`;
  wrap.appendChild(meta);
  return wrap;
}

async function renderSessionConversation(sessionId) {
  feed.innerHTML = `
    <div class="conversation-head">
      <div>
        <p class="eyebrow">历史会话</p>
        <h1>读取会话中…</h1>
      </div>
    </div>`;
  try {
    const data = await api(`/api/context/sessions/${encodeURIComponent(sessionId)}`);
    const session = data.session || {};
    const messages = data.messages || [];
    feed.innerHTML = `
      <div class="conversation-head">
        <div>
          <p class="eyebrow">历史会话</p>
          <h1>${escapeHtml(session.title || "未命名会话")}</h1>
          <div class="conversation-meta">
            <span>${escapeHtml(session.status || "active")}</span>
            <span>更新 ${escapeHtml(formatDateTime(session.updatedAt ?? session.updated_at))}</span>
            <code>${escapeHtml(session.id || sessionId)}</code>
          </div>
        </div>
      </div>`;
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "这个会话还没有历史消息。";
      feed.appendChild(empty);
    } else {
      for (const message of messages) {
        feed.appendChild(renderStoredMessage(message));
      }
      const anchor = document.createElement("div");
      anchor.className = "conversation-scroll-anchor";
      feed.appendChild(anchor);
    }
    scrollToBottomAfterLayout();
  } catch (err) {
    feed.innerHTML = `<div class="history-empty is-error">${escapeHtml(String(err.message || err))}</div>`;
  }
}

function addMessage(role, content, meta, opts) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (content instanceof Node) bubble.appendChild(content);
  else bubble.textContent = content;
  wrap.appendChild(bubble);
  if (meta) {
    const m = document.createElement("div");
    m.className = "msg-meta";
    m.textContent = meta;
    wrap.appendChild(m);
  }
  feed.appendChild(wrap);
  if (opts?.scroll === "start") {
    wrap.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    scrollToBottom();
  }
  return wrap;
}

function addSystemError(text) {
  const wrap = addMessage("system", text);
  wrap.classList.add("error");
  return wrap;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

async function loadConfig() {
  try {
    const cfg = await api("/api/config");
    appConfig = cfg;
    if (profileTag) profileTag.textContent = `profile: ${cfg.profile}`;
    statusDot.classList.remove("bad");
    statusDot.classList.add("ok");
    statusText.textContent = `已连接 · 默认 ${cfg.defaultModel} · 策略 ${cfg.routing.strategy}`;
    return cfg;
  } catch (err) {
    statusDot.classList.add("bad");
    statusText.textContent = "连接后端失败";
    addSystemError(String(err.message || err));
    return null;
  }
}

/** 仅用可用模型填充下拉框；默认模型可用时额外提供「自动」选项。 */
function updateModelOptions(rows) {
  const available = rows.filter((r) => r.available);
  const prev = modelSelect.value;
  modelSelect.innerHTML = "";

  if (available.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "无可用模型";
    modelSelect.appendChild(opt);
    modelSelect.disabled = true;
    sendBtn.disabled = true;
    return;
  }

  const defaultName = appConfig?.defaultModel;
  if (defaultName && available.some((r) => r.name === defaultName)) {
    const opt = document.createElement("option");
    opt.value = "__default__";
    opt.textContent = `自动（默认：${defaultName}）`;
    modelSelect.appendChild(opt);
  }

  for (const r of available) {
    const opt = document.createElement("option");
    opt.value = r.name;
    opt.textContent = `${r.name}（${r.location} / ${r.model}）`;
    modelSelect.appendChild(opt);
  }

  // 尽量保留用户之前的选择。
  if (prev && [...modelSelect.options].some((o) => o.value === prev)) {
    modelSelect.value = prev;
  }
  modelSelect.disabled = false;
  sendBtn.disabled = false;
}

/** 拉取一次可用性，刷新下拉框；返回原始行用于其它展示。 */
async function refreshModels() {
  modelSelect.innerHTML = '<option value="">检测中…</option>';
  modelSelect.disabled = true;
  sendBtn.disabled = true;
  try {
    const rows = await api("/api/models/check");
    updateModelOptions(rows);
    return rows;
  } catch (err) {
    modelSelect.innerHTML = '<option value="">检测失败</option>';
    addSystemError(String(err.message || err));
    return null;
  }
}

function renderConfigCard(cfg) {
  const lines = [
    `profile      : ${cfg.profile}`,
    `workspace    : ${cfg.workspaceRoot}`,
    `默认模型     : ${cfg.defaultModel}`,
    `路由策略     : ${cfg.routing.strategy}（fallback=${cfg.routing.fallback}）`,
    `已配置客户端 : ${cfg.clients.length}（下方对话框只列出实际可用的）`,
    ...cfg.clients.map((c) => `  - ${c.name} [${c.location}] ${c.provider} :: ${c.model}`),
  ];
  addMessage("system", lines.join("\n"));
}

function renderModelTable(rows) {
  clearWelcome();
  const table = document.createElement("table");
  table.className = "model-table";
  table.innerHTML = `
    <thead><tr><th>名称</th><th>位置</th><th>provider</th><th>模型</th><th>状态</th></tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const pill = r.available
      ? '<span class="pill ok">可用</span>'
      : '<span class="pill bad">不可用</span>';
    tr.innerHTML = `<td>${r.name}</td><td>${r.location}</td><td>${r.provider}</td><td>${r.model}</td><td>${pill}</td>`;
    tbody.appendChild(tr);
  }
  addMessage("system", table);
}

async function handleCheckModels() {
  const loading = addMessage("system", "正在检测模型可用性…");
  const rows = await refreshModels();
  loading.remove();
  if (rows) renderModelTable(rows);
}

function renderMetrics(data) {
  clearWelcome();
  const stats = data.stats || [];
  if (stats.length === 0) {
    addMessage("system", "暂无调用统计，先发送几条消息再查看。");
    return;
  }
  const table = document.createElement("table");
  table.className = "model-table";
  table.innerHTML = `
    <thead><tr><th>客户端</th><th>位置</th><th>调用</th><th>失败率</th><th>均延迟</th><th>token(in/out)</th><th>成本($)</th></tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  for (const s of stats) {
    const tr = document.createElement("tr");
    const rate = `${(s.failureRate * 100).toFixed(0)}%`;
    tr.innerHTML = `<td>${s.clientName}</td><td>${s.location}</td><td>${s.calls}</td><td>${rate}</td><td>${s.avgLatencyMs}ms</td><td>${s.totalInputTokens}/${s.totalOutputTokens}</td><td>${s.totalCostUsd}</td>`;
    tbody.appendChild(tr);
  }
  addMessage("system", table);
}

async function handleMetrics() {
  try {
    const data = await api("/api/metrics");
    renderMetrics(data);
  } catch (err) {
    addSystemError(String(err.message || err));
  }
}

function renderRoutingLogRows(routes, detailsEl) {
  if (!routes.length) {
    return `<div class="history-empty">暂无模型路由记录。发送一次自动路由对话后再刷新。</div>`;
  }
  const rows = routes
    .map((r) => {
      const strategy = r.executionStrategy || "-";
      const model = r.finalModelId || r.selectedModelId || r.reviewModelId || r.draftModelId || "-";
      const risk = r.risk || "-";
      const created = formatDateTime(r.createdAt);
      return `
        <tr>
          <td><code>${escapeHtml(r.id)}</code></td>
          <td>${escapeHtml(created)}</td>
          <td>${escapeHtml(r.taskType || "-")}</td>
          <td>${escapeHtml(strategy)}</td>
          <td>${escapeHtml(model)}</td>
          <td>${escapeHtml(risk)}</td>
          <td>
            <button class="action-btn secondary routing-detail-btn" data-route-log-id="${escapeHtml(r.id)}">详情</button>
          </td>
        </tr>`;
    })
    .join("");
  detailsEl.textContent = "选择一条记录查看 calls / collaborations / fallbacks。";
  return `
    <table class="model-table routing-log-table">
      <thead>
        <tr><th>routeId</th><th>时间</th><th>任务</th><th>策略</th><th>模型</th><th>风险</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function handleRoutingLogs() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel routing-log-panel";

  const title = document.createElement("div");
  title.className = "tool-desc";
  title.textContent = "查看 SmartModelRouter 的最近决策，以及单条记录关联的模型调用、协作与 fallback 链。";
  panel.appendChild(title);

  const row = document.createElement("div");
  row.className = "tool-row";

  const limitInput = document.createElement("input");
  limitInput.className = "system-input routing-limit-input";
  limitInput.type = "number";
  limitInput.min = "1";
  limitInput.max = "100";
  limitInput.value = "20";
  limitInput.title = "最近记录数量";

  const sessionInput = document.createElement("input");
  sessionInput.className = "system-input routing-session-input";
  sessionInput.placeholder = "sessionId 过滤（可选）";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新";

  const statsBtn = document.createElement("button");
  statsBtn.className = "action-btn secondary";
  statsBtn.textContent = "运行统计";

  const evalBtn = document.createElement("button");
  evalBtn.className = "action-btn secondary";
  evalBtn.textContent = "离线评测";

  row.appendChild(limitInput);
  row.appendChild(sessionInput);
  row.appendChild(refreshBtn);
  row.appendChild(statsBtn);
  row.appendChild(evalBtn);
  panel.appendChild(row);

  const statsBox = document.createElement("div");
  statsBox.className = "tool-result routing-stats-box";
  statsBox.style.display = "none";
  panel.appendChild(statsBox);

  const evalBox = document.createElement("div");
  evalBox.className = "tool-result routing-eval-box";
  evalBox.style.display = "none";
  panel.appendChild(evalBox);

  const list = document.createElement("div");
  list.className = "tool-result routing-log-list";
  list.style.display = "block";
  panel.appendChild(list);

  const details = document.createElement("div");
  details.className = "tool-result routing-log-details";
  details.style.display = "block";
  panel.appendChild(details);

  const loadList = async () => {
    const limit = Math.min(100, Math.max(1, Number(limitInput.value) || 20));
    const sessionId = sessionInput.value.trim();
    const query = new URLSearchParams({ limit: String(limit) });
    if (sessionId) query.set("sessionId", sessionId);
    list.classList.remove("err");
    details.classList.remove("err");
    list.textContent = "加载路由日志中…";
    try {
      const data = await api(`/api/routing/logs?${query.toString()}`);
      const routes = data.routes || [];
      list.innerHTML = renderRoutingLogRows(routes, details);
    } catch (err) {
      list.classList.add("err");
      list.textContent = String(err.message || err);
    }
  };

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".routing-detail-btn");
    if (!btn) return;
    const routeLogId = btn.dataset.routeLogId;
    details.style.display = "block";
    details.classList.remove("err");
    details.textContent = "加载详情中…";
    try {
      const data = await api(`/api/routing/logs?routeLogId=${encodeURIComponent(routeLogId)}`);
      details.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      details.classList.add("err");
      details.textContent = String(err.message || err);
    }
  });

  refreshBtn.addEventListener("click", loadList);
  statsBtn.addEventListener("click", async () => {
    statsBox.style.display = "block";
    statsBox.classList.remove("err");
    statsBox.textContent = "加载运行统计中…";
    try {
      const data = await api("/api/routing/stats?limit=200");
      const suggestions = (data.suggestions || [])
        .map(
          (s) =>
            `<li class="routing-suggestion routing-suggestion-${s.severity}"><strong>[${s.severity}]</strong> ${escapeHtml(s.message)}</li>`,
        )
        .join("");
      const models = (data.models || [])
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.modelId)}</td><td>${m.calls}</td><td>${(m.errorRate * 100).toFixed(1)}%</td><td>${m.fallbackFromCount}</td><td>${m.fallbackToCount}</td></tr>`,
        )
        .join("");
      statsBox.innerHTML = `
        <div class="routing-stats-summary">
          <span>路由 ${data.summary?.routeCount ?? 0}</span>
          <span>fallback ${((data.summary?.fallbackRate ?? 0) * 100).toFixed(1)}%</span>
          <span>evaluator ${data.summary?.evaluatorOverrides ?? 0}</span>
        </div>
        ${suggestions ? `<ul class="routing-suggestion-list">${suggestions}</ul>` : "<p>暂无调优建议。</p>"}
        ${models ? `<table class="model-table routing-stats-table"><thead><tr><th>模型</th><th>调用</th><th>错误率</th><th>fallback 源</th><th>fallback 目标</th></tr></thead><tbody>${models}</tbody></table>` : ""}
        <details class="routing-stats-raw"><summary>原始 JSON</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
    } catch (err) {
      statsBox.classList.add("err");
      statsBox.textContent = String(err.message || err);
    }
  });
  evalBtn.addEventListener("click", async () => {
    evalBox.style.display = "block";
    evalBox.classList.remove("err");
    evalBox.textContent = "运行离线评测中…";
    try {
      const data = await api("/api/routing/eval/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "rule", setName: "testbench-default" }),
      });
      const failed = (data.results || []).filter((r) => r.verdict === "fail");
      evalBox.innerHTML = `
        <div class="routing-stats-summary">
          <span>通过 ${data.passed}/${data.total}</span>
          <span>失败 ${data.failed}</span>
          <span>跳过 ${data.skipped}</span>
          <span>runId ${escapeHtml(data.runId)}</span>
        </div>
        ${failed.length ? `<pre class="routing-eval-failures">${escapeHtml(JSON.stringify(failed, null, 2))}</pre>` : "<p>全部通过。</p>"}
        <details class="routing-stats-raw"><summary>完整结果</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
    } catch (err) {
      evalBox.classList.add("err");
      evalBox.textContent = String(err.message || err);
    }
  });
  addMessage("system", panel);
  await loadList();
}

const RUN_TIMELINE_CATEGORY_LABEL = {
  run: "Run",
  model: "模型",
  tool: "工具",
  agent: "Agent",
  task: "任务",
  routing: "路由",
  fallback: "Fallback",
  notification: "通知",
  background: "后台",
  subagent: "子Agent",
  other: "其他",
};

function renderRunTimelineRows(timeline, usageEl) {
  if (!timeline.length) {
    usageEl.textContent = "该 Run 暂无时间线事件。";
    return `<div class="history-empty">暂无时间线条目。先执行一次智能体/对话/任务 Run 后再查看。</div>`;
  }
  const rows = timeline
    .map((entry) => {
      const cat = RUN_TIMELINE_CATEGORY_LABEL[entry.category] ?? entry.category;
      const time = formatDateTime(entry.time);
      const status = entry.status ? `<span class="pill">${escapeHtml(entry.status)}</span>` : "";
      const detail = entry.detail ? `<div class="run-timeline-detail">${escapeHtml(entry.detail)}</div>` : "";
      return `
        <div class="run-timeline-item" data-category="${escapeHtml(entry.category)}">
          <div class="run-timeline-head">
            <span class="run-timeline-time">${escapeHtml(time)}</span>
            <span class="run-timeline-cat">${escapeHtml(cat)}</span>
            ${status}
          </div>
          <div class="run-timeline-title">${escapeHtml(entry.title)}</div>
          ${detail}
        </div>`;
    })
    .join("");
  return `<div class="run-timeline">${rows}</div>`;
}

async function handleRunReports() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel run-report-panel";

  const title = document.createElement("div");
  title.className = "tool-desc";
  title.textContent = "按时间线查看 Run 的模型调用、工具审计、任务状态、路由决策与 fallback。";
  panel.appendChild(title);

  const row = document.createElement("div");
  row.className = "tool-row";

  const runInput = document.createElement("input");
  runInput.className = "system-input";
  runInput.placeholder = "Run ID（可留空，从列表选择）";
  row.appendChild(runInput);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新 Run 列表";
  row.appendChild(refreshBtn);

  const loadBtn = document.createElement("button");
  loadBtn.className = "action-btn secondary";
  loadBtn.textContent = "加载报告";
  loadBtn.style.marginLeft = "8px";
  row.appendChild(loadBtn);

  panel.appendChild(row);

  const list = document.createElement("div");
  list.className = "run-report-list";
  panel.appendChild(list);

  const usage = document.createElement("div");
  usage.className = "run-report-usage";
  panel.appendChild(usage);

  const timelineBox = document.createElement("div");
  timelineBox.className = "run-report-timeline";
  panel.appendChild(timelineBox);

  const loadRuns = async () => {
    list.textContent = "加载中…";
    try {
      const data = await api("/api/runs?limit=15");
      const runs = data.runs || [];
      if (!runs.length) {
        list.innerHTML = `<div class="history-empty">暂无 Run 记录。</div>`;
        return;
      }
      list.innerHTML = runs
        .map(
          (r) => `
          <button class="run-report-pick action-btn secondary" data-run-id="${escapeHtml(r.id)}">
            <span>${escapeHtml(r.kind)} · ${escapeHtml(r.status)}</span>
            <small>${escapeHtml(formatDateTime(r.createdAt))} · ${escapeHtml(r.id.slice(0, 8))}…</small>
          </button>`,
        )
        .join("");
    } catch (err) {
      list.textContent = String(err.message || err);
    }
  };

  const loadReport = async (runId) => {
    const id = (runId || runInput.value || "").trim();
    if (!id) {
      usage.textContent = "请输入或选择 Run ID。";
      return;
    }
    runInput.value = id;
    usage.textContent = "加载报告中…";
    timelineBox.innerHTML = "";
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}/report`);
      const report = data.report || {};
      const u = report.usage || {};
      usage.innerHTML = `
        <strong>用量摘要</strong> · 事件 ${report.eventCount ?? 0} 条 ·
        模型 ${u.modelTurns ?? 0} 轮 · 工具 ${u.toolCalls ?? 0} 次（失败 ${u.toolFailures ?? 0}） ·
        tokens ${u.totalInputTokens ?? 0}/${u.totalOutputTokens ?? 0} · $${u.totalCostUsd ?? 0}`;
      timelineBox.innerHTML = renderRunTimelineRows(report.timeline || [], usage);
    } catch (err) {
      usage.textContent = String(err.message || err);
      timelineBox.innerHTML = "";
    }
  };

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".run-report-pick");
    if (!btn) return;
    void loadReport(btn.dataset.runId);
  });

  refreshBtn.addEventListener("click", () => loadRuns());
  loadBtn.addEventListener("click", () => loadReport());
  addMessage("system", panel);
  await loadRuns();
}

const STATUS_LABEL = {
  pending: "待执行",
  running: "执行中",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function renderPlanPreview(data) {
  clearWelcome();
  const card = document.createElement("div");
  card.className = "plan-card";
  card.dataset.planId = data.planId ?? "";
  card.dataset.planVersion = String(data.version ?? 1);

  if (data.previewMarkdown) {
    const pre = document.createElement("pre");
    pre.className = "plan-markdown-preview";
    pre.textContent = data.previewMarkdown;
    card.appendChild(pre);
  } else if (data.publicPlanJson) {
    card.appendChild(document.createTextNode(JSON.stringify(data.publicPlanJson, null, 2)));
  }

  if (data.warning) {
    const warn = document.createElement("p");
    warn.className = "plan-warn";
    warn.textContent = data.warning;
    card.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const autoLabel = document.createElement("label");
  autoLabel.className = "field";
  autoLabel.innerHTML = '<input type="checkbox" class="auto-confirm" checked /> <span>自动确认高风险步骤（dry-run）</span>';
  const runBtn = document.createElement("button");
  runBtn.className = "action-btn";
  runBtn.textContent = "dry-run 执行（planId）";
  const approveBtn = document.createElement("button");
  approveBtn.className = "action-btn secondary";
  approveBtn.textContent = "审批计划";
  actions.appendChild(autoLabel);
  actions.appendChild(approveBtn);
  actions.appendChild(runBtn);
  card.appendChild(actions);

  approveBtn.addEventListener("click", async () => {
    if (!data.planId) return;
    try {
      await api(`/api/plans/${data.planId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: data.version ?? 1, comment: "测试台审批" }),
      });
      addMessage("system", "计划已审批");
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  runBtn.addEventListener("click", async () => {
    if (!data.planId) return;
    runBtn.disabled = true;
    try {
      await api(`/api/plans/${data.planId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: data.version ?? 1 }),
      }).catch(() => undefined);
      const exec = await api(`/api/plans/${data.planId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: data.version ?? 1,
          dryRun: true,
          autoConfirm: autoLabel.querySelector("input").checked,
        }),
      });
      addMessage("system", `dry-run 完成 runId=${exec.runId ?? ""}`);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      runBtn.disabled = false;
    }
  });

  addMessage("system", card);
}

function renderPlan(plan) {
  clearWelcome();
  const card = document.createElement("div");
  card.className = "plan-card";

  const list = (arr) => arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  const header = document.createElement("div");
  header.innerHTML = `
    <div class="plan-goal">目标：${escapeHtml(plan.goal)}</div>
    <div class="plan-grid">
      <div><b>纳入范围</b><ul>${list(plan.scope.inScope) || "<li>-</li>"}</ul></div>
      <div><b>不做</b><ul>${list(plan.scope.outOfScope) || "<li>-</li>"}</ul></div>
      <div><b>风险</b><ul>${list(plan.risks) || "<li>-</li>"}</ul></div>
      <div><b>依赖</b><ul>${list(plan.dependencies) || "<li>-</li>"}</ul></div>
    </div>`;
  card.appendChild(header);

  const stepsWrap = document.createElement("div");
  stepsWrap.className = "plan-steps";
  card.appendChild(stepsWrap);

  function paintSteps(steps) {
    stepsWrap.innerHTML = "";
    steps.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "plan-step";
      const perms = s.requiredPermissions.join(", ");
      const conf = s.needsConfirmation ? '<span class="tag-warn">需确认</span>' : "";
      const err = s.error ? `<div class="plan-err">${escapeHtml(s.error)}</div>` : "";
      row.innerHTML = `
        <div class="plan-step-head">
          <span class="status status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span class="plan-step-title">${i + 1}. ${escapeHtml(s.title)}</span>
          ${conf}
          <span class="plan-perms">${perms}</span>
        </div>
        <div class="plan-step-desc">${escapeHtml(s.description || "")}</div>
        ${err}`;
      stepsWrap.appendChild(row);
    });
  }
  paintSteps(plan.steps);

  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const autoLabel = document.createElement("label");
  autoLabel.className = "field";
  autoLabel.innerHTML = '<input type="checkbox" class="auto-confirm" /> <span>自动确认高风险步骤</span>';
  const runBtn = document.createElement("button");
  runBtn.className = "action-btn";
  runBtn.textContent = "任务模式 dry-run 执行";
  actions.appendChild(autoLabel);
  actions.appendChild(runBtn);
  card.appendChild(actions);

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    runBtn.textContent = "执行中…";
    try {
      const data = await api("/api/task/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, autoConfirm: autoLabel.querySelector("input").checked }),
      });
      paintSteps(data.plan.steps);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "任务模式 dry-run 执行";
    }
  });

  addMessage("system", card);
}

async function handlePlanReport(message) {
  addMessage("user", message);
  messageInput.value = "";
  autoGrow();
  sendBtn.disabled = true;
  const thinking = addMessage("assistant", "正在只读分析并生成计划报告…");
  try {
    const data = await api("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        mode: "plan",
        clientName: modelSelect.value,
        sessionId: activeSessionId,
        system: systemInput.value,
        sensitive: sensitiveInput.checked,
        autoConfirm: false,
      }),
    });
    thinking.remove();
    if (data.sessionId) {
      setActiveSessionId(data.sessionId);
      void loadHistorySessions();
    }
    renderAgentRun(data);
  } catch (err) {
    thinking.remove();
    addSystemError(String(err.message || err));
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

const TOOL_PLACEHOLDERS = {
  read_file: '{\n  "path": "package.json"\n}',
  list_files: '{\n  "root": ".",\n  "recursive": false\n}',
  search_text: '{\n  "query": "ModelRouter",\n  "root": "src"\n}',
  write_file: '{\n  "path": "data/tool-demo.txt",\n  "content": "hello from tool"\n}',
  apply_patch: '{\n  "path": "README.md",\n  "search": "旧文本",\n  "replace": "新文本"\n}',
  diff_file: '{\n  "path": "package.json",\n  "against": "git"\n}',
  backup_file: '{\n  "paths": ["package.json"],\n  "reason": "manual"\n}',
  rollback_change: '{\n  "changeId": "粘贴 changeId"\n}',
  shell_run: '{\n  "command": "node -v"\n}',
  git_status: '{}',
  git_diff: '{\n  "path": "package.json"\n}',
};

async function handleTools() {
  let data;
  try {
    data = await api("/api/tools");
  } catch (err) {
    addSystemError(String(err.message || err));
    return;
  }
  const tools = data.tools || [];
  if (tools.length === 0) {
    addMessage("system", "没有已注册的工具。");
    return;
  }

  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel";

  const row = document.createElement("div");
  row.className = "tool-row";
  const select = document.createElement("select");
  for (const t of tools) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
  const runBtn = document.createElement("button");
  runBtn.className = "action-btn";
  runBtn.textContent = "执行";
  row.appendChild(select);
  row.appendChild(runBtn);
  panel.appendChild(row);

  const desc = document.createElement("div");
  desc.className = "tool-desc";
  panel.appendChild(desc);

  const input = document.createElement("textarea");
  input.className = "tool-input";
  input.spellcheck = false;
  panel.appendChild(input);

  const result = document.createElement("div");
  result.className = "tool-result";
  result.style.display = "none";
  panel.appendChild(result);

  const syncMeta = () => {
    const t = tools.find((x) => x.name === select.value);
    const sideEffect = t.hasSideEffect ? "（有副作用，执行前需确认）" : "（只读）";
    desc.innerHTML = `${escapeHtml(t.description)} <span class="tool-perm">权限：${t.permission} · 入参：${escapeHtml(t.inputHint || "-")}</span> ${sideEffect}`;
    input.value = TOOL_PLACEHOLDERS[t.name] || "{}";
  };
  syncMeta();
  select.addEventListener("change", syncMeta);

  const showResult = (text, isErr) => {
    result.style.display = "block";
    result.textContent = text;
    result.classList.toggle("err", !!isErr);
  };

  const runTool = async (confirm) => {
    let parsedInput;
    try {
      parsedInput = input.value.trim() ? JSON.parse(input.value) : {};
    } catch (e) {
      showResult(`入参不是合法 JSON：${e.message}`, true);
      return;
    }
    runBtn.disabled = true;
    runBtn.textContent = "执行中…";
    try {
      const res = await api("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: select.value, input: parsedInput, confirm }),
      });
      if (res.needsConfirmation) {
        const riskText = res.risk
          ? `\n\n风险等级：${res.risk.tier}\n摘要：${res.risk.summary}\n原因：${(res.risk.reasons || []).join("；")}`
          : "";
        const ok = window.confirm(
          `工具「${res.tool}」属于高风险权限「${res.permission}」，确认执行？${riskText}`,
        );
        if (ok) {
          await runTool(true);
          return;
        }
        showResult("已取消执行。", true);
        return;
      }
      if (res.ok) {
        showResult(`耗时 ${res.durationMs}ms\n\n${JSON.stringify(res.output, null, 2)}`, false);
      } else {
        const riskText = res.risk
          ? `\n风险：${res.risk.tier} / ${res.risk.summary}`
          : "";
        showResult(`[${res.code}] ${res.error}${riskText}`, true);
      }
    } catch (err) {
      showResult(String(err.message || err), true);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "执行";
    }
  };

  runBtn.addEventListener("click", () => runTool(false));
  addMessage("system", panel);
}

function renderAgentRun(result) {
  clearWelcome();
  const card = document.createElement("div");
  card.className = "plan-card";

  if (result.steps && result.steps.length) {
    const stepsWrap = document.createElement("div");
    stepsWrap.className = "plan-steps";
    result.steps.forEach((s) => {
      const row = document.createElement("div");
      row.className = "plan-step";
      const state = s.blocked
        ? '<span class="status status-blocked">已阻塞</span>'
        : s.ok
          ? '<span class="status status-completed">成功</span>'
          : '<span class="status status-failed">失败</span>';
      const dur = s.durationMs != null ? `<span class="plan-perms">${s.durationMs}ms</span>` : "";
      const thought = s.thought ? `<div class="plan-step-desc">想法：${escapeHtml(s.thought)}</div>` : "";
      const io = `入参 ${escapeHtml(JSON.stringify(s.input))}`;
      const out = s.ok
        ? `结果 ${escapeHtml(truncate(JSON.stringify(s.output), 400))}`
        : escapeHtml(s.error || "");
      const riskTag = s.risk
        ? `<span class="tag-warn">${escapeHtml(s.risk.tier)}</span> <span class="plan-perms">${escapeHtml(s.risk.summary)}</span>`
        : "";
      row.innerHTML = `
        <div class="plan-step-head">
          ${state}
          <span class="plan-step-title">#${s.iteration} ${escapeHtml(s.tool)}</span>
          ${dur}
          ${riskTag}
        </div>
        ${thought}
        <div class="plan-step-desc">${io}</div>
        <div class="plan-step-desc">${out}</div>`;
      stepsWrap.appendChild(row);
    });
    card.appendChild(stepsWrap);
  }

  if (result.notifications && result.notifications.length) {
    const notes = document.createElement("div");
    notes.className = "plan-step-desc";
    notes.style.marginBottom = "8px";
    notes.innerHTML = `<strong>安全点消费的通知</strong><br>${result.notifications
      .map((n) => escapeHtml(`[${n.source}] ${n.message}`))
      .join("<br>")}`;
    card.appendChild(notes);
  }

  if (result.executionMeta) {
    const m = result.executionMeta;
    const b = m.budget || {};
    const u = m.usage || {};
    const metaBox = document.createElement("div");
    metaBox.className = "plan-step-desc";
    metaBox.style.marginBottom = "8px";
    const locationInfo = m.location
      ? `\nlocation=${m.location.usedLocateSteps ?? 0} steps · found=${(m.location.locatedFiles || []).slice(0, 4).join(",") || "-"} · continue=${m.location.needsContinue ? "yes" : "no"}`
      : "";
    metaBox.innerHTML = `<strong>执行元信息</strong><br>${escapeHtml(
      `mode=${m.mode} · stop=${m.stopReason}${m.budgetExhausted ? `(${m.budgetExhausted})` : ""} · model=${u.modelTurns ?? m.usedModelTurns}/${b.maxModelTurns ?? "-"} · tools=${u.toolCalls ?? m.usedToolCalls}/${b.maxToolCalls ?? "-"} · read=${u.readCalls ?? m.usedReadCalls}/${b.maxReadCalls ?? "-"} · write=${u.writeCalls ?? m.usedWriteCalls}/${b.maxWriteCalls ?? "-"} · shell=${u.shellCalls ?? m.usedShellCalls}/${b.maxShellCalls ?? "-"} · runtime=${u.runtimeMs ?? 0}/${b.maxRuntimeMs ?? "-"}ms${
        m.needsMoreBudget && m.suggestedBudget
          ? ` · 建议预算=${formatBudget(m.suggestedBudget)}`
          : ""
      }${locationInfo}`,
    )}`;
    card.appendChild(metaBox);
  }

  const ans = document.createElement("div");
  ans.className = "plan-goal";
  ans.style.marginTop = result.steps && result.steps.length ? "12px" : "0";
  ans.textContent = "最终回答";
  card.appendChild(ans);
  const answer = document.createElement("div");
  answer.className = "plan-step-desc";
  answer.style.whiteSpace = "pre-wrap";
  answer.textContent = result.answer;
  card.appendChild(answer);

  const metaInfo = result.executionMeta;
  const meta = `模型轮次 ${result.iterations} · 工具请求 ${result.steps ? result.steps.length : 0} 次${metaInfo ? ` · ${metaInfo.mode}/${metaInfo.stopReason}` : ""}${result.reachedLimit ? " · 已达预算" : ""}${sessionMeta()}`;
  addMessage("assistant", card, meta);
}

function formatBudget(budget) {
  return [
    `model=${budget.maxModelTurns}`,
    `tool=${budget.maxToolCalls}`,
    `read=${budget.maxReadCalls}`,
    `write=${budget.maxWriteCalls}`,
    `shell=${budget.maxShellCalls}`,
    `runtime=${budget.maxRuntimeMs}ms`,
  ].join("/");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function handleBackground() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel";

  const row = document.createElement("div");
  row.className = "tool-row";
  const input = document.createElement("input");
  input.className = "system-input";
  input.placeholder = '后台命令，如 node -v 或 npm run typecheck';
  input.style.flex = "1";
  const startBtn = document.createElement("button");
  startBtn.className = "action-btn";
  startBtn.textContent = "后台启动";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新列表";
  row.appendChild(input);
  row.appendChild(startBtn);
  row.appendChild(refreshBtn);
  panel.appendChild(row);

  const list = document.createElement("div");
  list.className = "tool-result";
  list.style.display = "block";
  panel.appendChild(list);

  const renderTasks = (tasks) => {
    if (!tasks.length) {
      list.textContent = "暂无后台任务。";
      return;
    }
    list.innerHTML = tasks
      .map((t) => {
        const tail = truncate((t.stdout || t.stderr || "").trim(), 120);
        return `<div class="plan-step" style="margin-top:8px">
          <div class="plan-step-head">
            <span class="status status-${t.status === "completed" ? "completed" : t.status === "running" ? "running" : "failed"}">${escapeHtml(t.status)}</span>
            <span class="plan-step-title">${escapeHtml(t.command)}</span>
            ${t.status === "running" ? `<button type="button" class="action-btn cancel-bg" data-id="${escapeHtml(t.id)}">取消</button>` : ""}
          </div>
          <div class="plan-step-desc">id: ${escapeHtml(t.id)} · pid: ${t.pid ?? "-"} · exit: ${t.exitCode ?? "-"}</div>
          ${tail ? `<div class="plan-step-desc">${escapeHtml(tail)}</div>` : ""}
        </div>`;
      })
      .join("");
    list.querySelectorAll(".cancel-bg").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/background/${btn.dataset.id}/cancel`, { method: "POST" });
          await loadTasks();
        } catch (err) {
          addSystemError(String(err.message || err));
        }
      });
    });
  };

  const loadTasks = async () => {
    try {
      const data = await api("/api/background");
      renderTasks(data.tasks || []);
    } catch (err) {
      list.textContent = String(err.message || err);
    }
  };

  startBtn.addEventListener("click", async () => {
    const command = input.value.trim();
    if (!command) return;
    startBtn.disabled = true;
    try {
      await api("/api/background/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      input.value = "";
      await loadTasks();
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      startBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener("click", loadTasks);
  addMessage("system", panel);
  await loadTasks();
}

async function handleNotifications() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel";
  const row = document.createElement("div");
  row.className = "tool-row";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新待处理";
  const consumeBtn = document.createElement("button");
  consumeBtn.className = "action-btn";
  consumeBtn.textContent = "手动消费（安全点）";
  row.appendChild(refreshBtn);
  row.appendChild(consumeBtn);
  panel.appendChild(row);

  const list = document.createElement("div");
  list.className = "tool-result";
  list.style.display = "block";
  panel.appendChild(list);

  const load = async (pendingOnly) => {
    try {
      const data = await api(`/api/notifications${pendingOnly ? "?pending=1" : ""}`);
      const notes = data.notifications || [];
      if (!notes.length) {
        list.textContent = pendingOnly ? "暂无待处理通知。" : "暂无通知记录。";
        return;
      }
      list.innerHTML = notes
        .map(
          (n) =>
            `<div class="plan-step-desc">[${escapeHtml(n.source)}/${escapeHtml(n.level)}] ${escapeHtml(n.timestamp)} — ${escapeHtml(n.message)}${n.consumed ? " (已消费)" : ""}</div>`,
        )
        .join("");
    } catch (err) {
      list.textContent = String(err.message || err);
    }
  };

  refreshBtn.addEventListener("click", () => load(true));
  consumeBtn.addEventListener("click", async () => {
    try {
      const data = await api("/api/notifications/consume", { method: "POST" });
      addMessage("system", `已消费 ${(data.consumed || []).length} 条通知。`);
      await load(true);
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  addMessage("system", panel);
  await load(true);
}

async function handleScheduler() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel";
  panel.innerHTML =
    "<h3>定时与事件触发 (M8)</h3><p>触发器到期后写入通知队列（需主 Agent 安全点消费），不直接执行工具。</p>";

  const row = document.createElement("div");
  row.className = "tool-row";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新列表";
  const onceBtn = document.createElement("button");
  onceBtn.className = "action-btn";
  onceBtn.textContent = "注册一次性（+2分钟）";
  row.appendChild(refreshBtn);
  row.appendChild(onceBtn);
  panel.appendChild(row);

  const list = document.createElement("div");
  list.className = "tool-result";
  list.style.display = "block";
  panel.appendChild(list);

  const queueTitle = document.createElement("h4");
  queueTitle.textContent = "待办队列（scheduler 通知）";
  queueTitle.style.marginTop = "12px";
  panel.appendChild(queueTitle);

  const queue = document.createElement("div");
  queue.className = "tool-result";
  queue.style.display = "block";
  panel.appendChild(queue);

  const loadQueue = async () => {
    try {
      const data = await api("/api/notifications?pending=1");
      const notes = (data.notifications || []).filter((n) => n.source === "scheduler");
      if (!notes.length) {
        queue.textContent = "暂无 scheduler 待办。";
        return;
      }
      queue.innerHTML = notes
        .map(
          (n) =>
            `<div class="plan-step-desc">${escapeHtml(n.timestamp)} — ${escapeHtml(n.message)}${n.payload?.requiresConfirmation === false ? " <em>(无人值守)</em>" : ""}</div>`,
        )
        .join("");
    } catch (err) {
      queue.textContent = String(err.message || err);
    }
  };

  const load = async () => {
    try {
      const data = await api("/api/scheduler/triggers");
      const triggers = data.triggers || [];
      if (!triggers.length) {
        list.textContent = "暂无触发器。";
      } else {
        list.innerHTML = triggers
          .map(
            (t) =>
              `<div class="plan-step-desc"><strong>${escapeHtml(t.name)}</strong> [${escapeHtml(t.kind)}/${escapeHtml(t.status)}] · 触发 ${t.fireCount} 次 · ${escapeHtml(t.goal)}</div>`,
          )
          .join("");
      }
      await loadQueue();
    } catch (err) {
      list.textContent = String(err.message || err);
    }
  };

  onceBtn.addEventListener("click", async () => {
    try {
      const at = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      await api("/api/scheduler/triggers", {
        method: "POST",
        body: JSON.stringify({
          name: `网页一次性 ${at.slice(11, 19)}`,
          kind: "once",
          goal: "检查测试台调度是否工作",
          at,
        }),
      });
      addMessage("system", `已注册一次性触发器，将于 ${at} 写入通知。`);
      await load();
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  refreshBtn.addEventListener("click", () => load());
  addMessage("system", panel);
  await load();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleSecurity() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel trace-replay-panel";

  const title = document.createElement("div");
  title.className = "tool-desc";
  title.textContent = "审计回放：按 runId / toolCallId / 类别过滤 trace，时间线复盘或导出 JSON。";
  panel.appendChild(title);

  const row = document.createElement("div");
  row.className = "tool-row";

  const runInput = document.createElement("input");
  runInput.className = "system-input";
  runInput.placeholder = "runId（可选）";
  row.appendChild(runInput);

  const toolCallInput = document.createElement("input");
  toolCallInput.className = "system-input";
  toolCallInput.placeholder = "toolCallId（可选）";
  row.appendChild(toolCallInput);

  const categorySelect = document.createElement("select");
  categorySelect.innerHTML = `
    <option value="">全部类别</option>
    <option value="run">Run</option>
    <option value="model">模型</option>
    <option value="tool">工具</option>
    <option value="agent">Agent</option>
    <option value="task">任务</option>
    <option value="background">后台</option>
    <option value="subagent">子Agent</option>
  `;
  row.appendChild(categorySelect);

  const limitInput = document.createElement("input");
  limitInput.className = "system-input routing-limit-input";
  limitInput.type = "number";
  limitInput.min = "1";
  limitInput.max = "500";
  limitInput.value = "50";
  row.appendChild(limitInput);

  panel.appendChild(row);

  const btnRow = document.createElement("div");
  btnRow.className = "tool-row";

  const replayBtn = document.createElement("button");
  replayBtn.className = "action-btn";
  replayBtn.textContent = "加载回放";
  btnRow.appendChild(replayBtn);

  const exportBtn = document.createElement("button");
  exportBtn.className = "action-btn secondary";
  exportBtn.textContent = "导出 JSON";
  exportBtn.style.marginLeft = "8px";
  btnRow.appendChild(exportBtn);

  const runReportBtn = document.createElement("button");
  runReportBtn.className = "action-btn secondary";
  runReportBtn.textContent = "打开 Run 报告";
  runReportBtn.style.marginLeft = "8px";
  btnRow.appendChild(runReportBtn);

  const recentBtn = document.createElement("button");
  recentBtn.className = "action-btn secondary";
  recentBtn.textContent = "最近 trace";
  recentBtn.style.marginLeft = "8px";
  btnRow.appendChild(recentBtn);

  panel.appendChild(btnRow);

  const summary = document.createElement("div");
  summary.className = "run-report-usage";
  panel.appendChild(summary);

  const timelineBox = document.createElement("div");
  timelineBox.className = "run-report-timeline";
  panel.appendChild(timelineBox);

  const rawBox = document.createElement("pre");
  rawBox.className = "tool-result trace-replay-raw";
  rawBox.style.display = "none";
  panel.appendChild(rawBox);

  const buildQuery = () => {
    const q = new URLSearchParams();
    const limit = Math.min(500, Math.max(1, Number(limitInput.value) || 50));
    q.set("limit", String(limit));
    const runId = runInput.value.trim();
    const toolCallId = toolCallInput.value.trim();
    const category = categorySelect.value;
    if (runId) q.set("runId", runId);
    if (toolCallId) q.set("toolCallId", toolCallId);
    if (category) q.set("category", category);
    return q;
  };

  const loadReplay = async () => {
    summary.textContent = "加载回放中…";
    timelineBox.innerHTML = "";
    rawBox.style.display = "none";
    try {
      const data = await api(`/api/trace/replay?${buildQuery().toString()}`);
      const s = data.summary || {};
      const typeText = Object.entries(s.types || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      summary.innerHTML = `
        <strong>回放</strong> · ${data.count ?? 0} 条
        ${data.filters?.runId ? ` · runId=${escapeHtml(String(data.filters.runId))}` : ""}
        ${data.filters?.toolCallId ? ` · toolCallId=${escapeHtml(String(data.filters.toolCallId))}` : ""}
        <br>${escapeHtml(typeText || "无事件")}`;
      timelineBox.innerHTML = renderRunTimelineRows(data.timeline || [], summary);
      rawBox.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      summary.textContent = String(err.message || err);
      timelineBox.innerHTML = "";
    }
  };

  replayBtn.addEventListener("click", () => loadReplay());
  exportBtn.addEventListener("click", async () => {
    try {
      const data = await api(`/api/trace/export?${buildQuery().toString()}`);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(`trace-export-${stamp}.json`, data);
      summary.textContent = `已导出 ${data.count ?? 0} 条事件到本地 JSON 文件。`;
    } catch (err) {
      summary.textContent = String(err.message || err);
    }
  });
  runReportBtn.addEventListener("click", async () => {
    const runId = runInput.value.trim();
    if (!runId) {
      summary.textContent = "请先填写 runId，再打开 Run 报告。";
      return;
    }
    document.querySelector('.sidebar [data-action="run-reports"]')?.click();
    setTimeout(() => {
      const input = document.querySelector(".run-report-panel input.system-input");
      const loadBtn = document.querySelector(".run-report-panel .action-btn.secondary");
      if (input) input.value = runId;
      loadBtn?.click();
    }, 200);
  });
  recentBtn.addEventListener("click", async () => {
    rawBox.style.display = "block";
    rawBox.classList.remove("err");
    try {
      const data = await api("/api/trace/recent?limit=20");
      rawBox.textContent = JSON.stringify(data, null, 2);
      summary.textContent = `最近 trace：${data.count ?? 0} 条（原始 JSON 见下方）。`;
    } catch (err) {
      rawBox.classList.add("err");
      rawBox.textContent = String(err.message || err);
    }
  });

  addMessage("system", panel);
}

async function handleContext() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel";

  const title = document.createElement("div");
  title.className = "tool-desc";
  title.textContent = "M6 上下文：SQLite 持久化、历史摘要、记忆检索（FTS5 + LanceDB）。";
  panel.appendChild(title);

  const row = document.createElement("div");
  row.className = "tool-row";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新会话列表";
  const createBtn = document.createElement("button");
  createBtn.className = "action-btn";
  createBtn.textContent = "新建会话";
  row.appendChild(refreshBtn);
  row.appendChild(createBtn);
  panel.appendChild(row);

  const sessionList = document.createElement("div");
  sessionList.className = "tool-result";
  sessionList.style.display = "block";
  sessionList.style.maxHeight = "160px";
  sessionList.style.overflow = "auto";
  panel.appendChild(sessionList);

  const memTitle = document.createElement("div");
  memTitle.className = "tool-desc";
  memTitle.style.marginTop = "12px";
  memTitle.textContent = "写入记忆（global / preference）";
  panel.appendChild(memTitle);

  const memInput = document.createElement("textarea");
  memInput.className = "tool-input";
  memInput.style.minHeight = "60px";
  memInput.placeholder = "例如：用户偏好使用中文回复与 TypeScript";
  panel.appendChild(memInput);

  const memBtn = document.createElement("button");
  memBtn.className = "action-btn";
  memBtn.style.marginTop = "8px";
  memBtn.textContent = "保存记忆";
  panel.appendChild(memBtn);

  const searchInput = document.createElement("input");
  searchInput.className = "system-input";
  searchInput.style.width = "100%";
  searchInput.style.marginTop = "12px";
  searchInput.placeholder = "关键词检索（FTS + 向量）";
  panel.appendChild(searchInput);

  const searchBtn = document.createElement("button");
  searchBtn.className = "action-btn";
  searchBtn.style.marginTop = "8px";
  searchBtn.textContent = "检索";
  panel.appendChild(searchBtn);

  const deactivateInput = document.createElement("input");
  deactivateInput.className = "system-input";
  deactivateInput.style.width = "100%";
  deactivateInput.style.marginTop = "12px";
  deactivateInput.placeholder = "记忆 ID（停用）";
  panel.appendChild(deactivateInput);

  const deactivateBtn = document.createElement("button");
  deactivateBtn.className = "action-btn";
  deactivateBtn.style.marginTop = "8px";
  deactivateBtn.textContent = "停用记忆";
  panel.appendChild(deactivateBtn);

  const result = document.createElement("div");
  result.className = "tool-result";
  result.style.display = "none";
  panel.appendChild(result);

  async function loadSessions() {
    sessionList.textContent = "加载中…";
    try {
      const data = await api("/api/context/sessions");
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        sessionList.textContent = "（暂无会话）";
        return;
      }
      sessionList.innerHTML = sessions
        .map(
          (s) =>
            `<div style="margin:4px 0"><strong>${escapeHtml(s.title)}</strong> <code>${escapeHtml(s.id.slice(0, 8))}…</code> <button type="button" class="action-btn" data-restore="${escapeHtml(s.id)}">恢复预览</button></div>`,
        )
        .join("");
      sessionList.querySelectorAll("[data-restore]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-restore");
          result.style.display = "block";
          result.textContent = "恢复中…";
          try {
            const data = await api(`/api/context/sessions/${id}/restore`);
            result.textContent = JSON.stringify(
              {
                phase: data.phase,
                contextPackage: data.contextPackage,
                renderedPrompt: data.renderedPrompt,
              },
              null,
              2,
            );
          } catch (err) {
            result.classList.add("err");
            result.textContent = String(err.message || err);
          }
        });
      });
    } catch (err) {
      sessionList.textContent = String(err.message || err);
    }
  }

  refreshBtn.addEventListener("click", loadSessions);
  createBtn.addEventListener("click", async () => {
    try {
      await api("/api/context/sessions", {
        method: "POST",
        body: JSON.stringify({ title: `会话 ${new Date().toLocaleString()}` }),
      });
      await loadSessions();
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });
  memBtn.addEventListener("click", async () => {
    const value = memInput.value.trim();
    if (!value) return;
    result.style.display = "block";
    result.classList.remove("err");
    try {
      const data = await api("/api/context/memories", {
        method: "POST",
        body: JSON.stringify({
          scope: "global",
          memoryType: "preference",
          value,
          summary: value.slice(0, 40),
        }),
      });
      const mid = data.memory?.id || "";
      result.textContent = mid ? `已保存记忆：${mid}` : "已保存记忆";
      if (mid) deactivateInput.value = mid;
    } catch (err) {
      result.classList.add("err");
      result.textContent = String(err.message || err);
    }
  });
  deactivateBtn.addEventListener("click", async () => {
    const id = deactivateInput.value.trim();
    if (!id) return;
    result.style.display = "block";
    result.classList.remove("err");
    try {
      const data = await api(`/api/context/memories/${encodeURIComponent(id)}/deactivate`, {
        method: "POST",
        body: JSON.stringify({ reason: "test-bench" }),
      });
      result.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      result.classList.add("err");
      result.textContent = String(err.message || err);
    }
  });
  searchBtn.addEventListener("click", async () => {
    const q = searchInput.value.trim();
    if (!q) return;
    result.style.display = "block";
    result.classList.remove("err");
    try {
      const data = await api(`/api/context/search?q=${encodeURIComponent(q)}`);
      result.textContent = JSON.stringify(data.hits, null, 2);
    } catch (err) {
      result.classList.add("err");
      result.textContent = String(err.message || err);
    }
  });

  addMessage("system", panel);
  await loadSessions();
}

async function handleSubAgent() {
  clearWelcome();
  let rolesData;
  try {
    rolesData = await api("/api/subagent/roles");
  } catch (err) {
    addSystemError(String(err.message || err));
    return;
  }
  const roles = rolesData.roles || [];

  const panel = document.createElement("div");
  panel.className = "tool-panel";

  const modeRow = document.createElement("div");
  modeRow.className = "tool-row";
  const modeSelect = document.createElement("select");
  modeSelect.innerHTML = `
    <option value="single">单个子 Agent</option>
    <option value="batch">并行派生（多角色）</option>`;
  modeRow.appendChild(modeSelect);
  panel.appendChild(modeRow);

  const roleRow = document.createElement("div");
  roleRow.className = "tool-row";
  roleRow.style.flexWrap = "wrap";
  roleRow.style.gap = "8px";
  const roleChecks = roles.map((r) => {
    const label = document.createElement("label");
    label.className = "field sensitive-field";
    label.style.fontSize = "13px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = r.id;
    cb.dataset.singleDefault = r.id === "code_review" ? "1" : "";
    if (r.id === "code_review") cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${r.title}`));
    roleRow.appendChild(label);
    return cb;
  });
  panel.appendChild(roleRow);

  const desc = document.createElement("div");
  desc.className = "tool-desc";
  panel.appendChild(desc);

  const taskInput = document.createElement("textarea");
  taskInput.className = "tool-input";
  taskInput.style.minHeight = "80px";
  taskInput.placeholder = "交给子 Agent 的任务描述，例如：审查 src/agent/AgentLoop.ts 的错误处理";
  panel.appendChild(taskInput);

  const ctxInput = document.createElement("input");
  ctxInput.className = "system-input";
  ctxInput.style.width = "100%";
  ctxInput.style.marginTop = "8px";
  ctxInput.placeholder = "附加上下文（可选，来自父 Agent）";
  panel.appendChild(ctxInput);

  const runBtn = document.createElement("button");
  runBtn.className = "action-btn";
  runBtn.style.marginTop = "10px";
  runBtn.textContent = "运行子 Agent";
  panel.appendChild(runBtn);

  const result = document.createElement("div");
  result.className = "tool-result";
  result.style.display = "none";
  panel.appendChild(result);

  const syncDesc = () => {
    const checked = roleChecks.filter((c) => c.checked);
    const lines = checked
      .map((c) => roles.find((r) => r.id === c.value))
      .filter(Boolean)
      .map((r) => `${r.title}：${r.description}（权限 ${r.allowedPermissions.join(", ")}）`);
    desc.textContent = lines.join(" · ") || "请至少选择一个角色";
  };

  modeSelect.addEventListener("change", () => {
    const single = modeSelect.value === "single";
    roleChecks.forEach((c) => {
      c.disabled = single;
      if (single) c.checked = c.dataset.singleDefault === "1";
    });
    syncDesc();
  });
  roleChecks.forEach((c) => c.addEventListener("change", syncDesc));
  syncDesc();

  runBtn.addEventListener("click", async () => {
    const task = taskInput.value.trim();
    if (!task) {
      result.style.display = "block";
      result.classList.add("err");
      result.textContent = "请填写任务描述";
      return;
    }
    const selectedRoles = roleChecks.filter((c) => c.checked).map((c) => c.value);
    if (selectedRoles.length === 0) {
      result.style.display = "block";
      result.classList.add("err");
      result.textContent = "请至少选择一个角色";
      return;
    }
    runBtn.disabled = true;
    runBtn.textContent = "运行中…";
    result.style.display = "block";
    result.classList.remove("err");
    result.textContent = "子 Agent 执行中（只读，可能需要模型）…";
    try {
      const primaryRole = roles.find((r) => r.id === selectedRoles[0]);
      const body = {
        task,
        context: ctxInput.value.trim() || undefined,
        sensitive: sensitiveInput.checked,
        budget: primaryRole?.defaultBudget,
        timeoutMs: primaryRole?.defaultTimeoutMs ?? 180000,
      };
      let data;
      if (modeSelect.value === "batch") {
        data = await api("/api/subagent/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            roles: selectedRoles,
            budget: mergeRoleBudgets(selectedRoles.map((id) => roles.find((r) => r.id === id)?.defaultBudget)),
          }),
        });
        result.textContent = `父任务 ${data.parentTaskId} · ${data.durationMs}ms\n\n${data.summary}`;
      } else {
        data = await api("/api/subagent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, role: selectedRoles[0] }),
        });
        const r = data.result;
        result.textContent = `[${r.role}] ${r.status} · ${r.durationMs}ms · 权限 ${r.grantedPermissions.join(",")}\n\n${r.answer}${r.error ? `\n\n错误：${r.error}` : ""}`;
      }
    } catch (err) {
      result.classList.add("err");
      result.textContent = String(err.message || err);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "运行子 Agent";
    }
  });

  addMessage("system", panel);
}

function mergeRoleBudgets(budgets) {
  const valid = budgets.filter(Boolean);
  if (!valid.length) return undefined;
  return {
    maxModelTurns: Math.max(...valid.map((b) => b.maxModelTurns ?? 0)),
    maxToolCalls: Math.max(...valid.map((b) => b.maxToolCalls ?? 0)),
    maxReadCalls: Math.max(...valid.map((b) => b.maxReadCalls ?? 0)),
    maxWriteCalls: Math.max(...valid.map((b) => b.maxWriteCalls ?? 0)),
    maxShellCalls: Math.max(...valid.map((b) => b.maxShellCalls ?? 0)),
    maxRuntimeMs: Math.max(...valid.map((b) => b.maxRuntimeMs ?? 0)),
  };
}

async function handleAgent(message) {
  addMessage("user", message);
  messageInput.value = "";
  autoGrow();
  sendBtn.disabled = true;
  const thinking = addMessage("assistant", "智能体运行中（读取/搜索/按需调用工具）…");
  try {
    const data = await api("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        clientName: modelSelect.value,
        sessionId: activeSessionId,
        system: systemInput.value,
        sensitive: sensitiveInput.checked,
        autoConfirm: autoConfirmInput.checked,
      }),
    });
    thinking.remove();
    if (data.sessionId) {
      setActiveSessionId(data.sessionId);
      void loadHistorySessions();
    }
    renderAgentRun(data);
  } catch (err) {
    thinking.remove();
    addSystemError(String(err.message || err));
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function handleSend() {
  const message = messageInput.value.trim();
  if (!message) return;
  if (!modelSelect.value) {
    addSystemError("当前没有可用模型，请先启动本地模型或配置远程 key，再点「检测模型可用性」。");
    return;
  }

  if (modeSelect.value === "plan") {
    await handlePlanReport(message);
    return;
  }

  if (modeSelect.value === "agent") {
    await handleAgent(message);
    return;
  }

  addMessage("user", message);
  messageInput.value = "";
  autoGrow();
  sendBtn.disabled = true;

  const thinking = addMessage("assistant", "思考中…");
  try {
    const data = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: modelSelect.value,
        sessionId: activeSessionId,
        system: systemInput.value,
        sensitive: sensitiveInput.checked,
        message,
      }),
    });
    thinking.remove();
    if (data.sessionId) {
      setActiveSessionId(data.sessionId);
      void loadHistorySessions();
    }
    const usage = data.usage
      ? ` · token in=${data.usage.inputTokens ?? "?"}/out=${data.usage.outputTokens ?? "?"}`
      : "";
    const routed = data.routed ? "（路由自选）" : "";
    addMessage(
      "assistant",
      data.content || "(空响应)",
      `${data.clientName}${routed} · ${data.modelName}（${data.location}） · ${data.latencyMs}ms${usage}${sessionMeta()}`,
    );
  } catch (err) {
    thinking.remove();
    addSystemError(String(err.message || err));
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

function autoGrow() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
}

document.querySelector(".sidebar").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "new-chat") {
    setActiveSessionId(undefined);
    await renderHomeHistory();
  } else if (action === "view-config") {
    const cfg = await loadConfig();
    if (cfg) renderConfigCard(cfg);
  } else if (action === "check-models") {
    await handleCheckModels();
  } else if (action === "metrics") {
    await handleMetrics();
  } else if (action === "routing-logs") {
    await handleRoutingLogs();
  } else if (action === "run-reports") {
    await handleRunReports();
  } else if (action === "tools") {
    await handleTools();
  } else if (action === "background") {
    await handleBackground();
  } else if (action === "notifications") {
    await handleNotifications();
  } else if (action === "subagent") {
    await handleSubAgent();
  } else if (action === "context") {
    await handleContext();
  } else if (action === "security") {
    await handleSecurity();
  } else if (action === "scheduler") {
    await handleScheduler();
  } else if (action === "refresh-models") {
    const rows = await refreshModels();
    if (rows) {
      const n = rows.filter((r) => r.available).length;
      addMessage("system", `已刷新：${n}/${rows.length} 个模型可用，下拉框仅显示可用模型。`);
    }
  } else if (action === "refresh-history") {
    await loadHistorySessions();
  } else if (action === "resume-session") {
    const sessionId = btn.dataset.sessionId;
    if (sessionId) {
      setActiveSessionId(sessionId);
      await loadHistorySessions();
      await renderSessionConversation(sessionId);
      messageInput.focus();
    }
  }
});

feed.addEventListener("click", (e) => {
  const btn = e.target.closest(".welcome button[data-action], .home-page button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "refresh-history") void loadHistorySessions();
  if (action === "resume-session") {
    const sessionId = btn.dataset.sessionId;
    if (sessionId) {
      setActiveSessionId(sessionId);
      void loadHistorySessions();
      void renderSessionConversation(sessionId);
      messageInput.focus();
    }
  }
  if (["check-models", "view-config"].includes(action)) {
    document.querySelector(`.sidebar [data-action="${action}"]`)?.click();
  }
});

sendBtn.addEventListener("click", handleSend);
messageInput.addEventListener("input", autoGrow);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

async function init() {
  await loadConfig();
  await renderHomeHistory();
  void refreshModels();
}

init();
