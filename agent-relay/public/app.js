const feed = document.getElementById("feed");
const modelSelect = document.getElementById("model-select");
const systemInput = document.getElementById("system-input");
const sensitiveInput = document.getElementById("sensitive-input");
const permissionPolicySelect = document.getElementById("permission-policy-select");
const explicitModeSelect = document.getElementById("explicit-mode-select");
const streamAgentInput = document.getElementById("stream-agent-input");
const streamTokensInput = document.getElementById("stream-tokens-input");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const profileTag = document.getElementById("profile-tag");
const sidebarHistoryList = document.getElementById("sidebar-history-list");

let appConfig = null;
const ACTIVE_SESSION_KEY = "agentrelay.activeSessionId";
const PERMISSION_POLICY_KEY = "agentrelay.permissionPolicy";
let activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || undefined;

if (typeof marked !== "undefined") {
  marked.setOptions({ gfm: true, breaks: true });
}

const PERMISSION_POLICY_LABELS = {
  readOnly: "只读",
  confirmBeforeEdit: "修改前确认",
  autoEdit: "自动修改",
  confirmBeforeRun: "命令前确认",
  autoRun: "自动执行",
};

const WORKFLOW_STATUS_LABELS = {
  answerWorkflow: "普通回答",
  planWorkflow: "计划生成中",
  editWorkflow: "正在修改文件",
  runWorkflow: "正在执行命令",
  debugWorkflow: "正在调试修复",
  reviewWorkflow: "正在审阅代码",
  verifyWorkflow: "正在验证结果",
  summarizeWorkflow: "正在总结内容",
  searchWorkflow: "正在定位信息",
  refactorWorkflow: "正在规划重构",
  generateFileWorkflow: "正在生成文件",
};

const TASK_STATE_LABELS = {
  idle: "待命",
  planning: "内部规划中",
  waiting_confirmation: "等待确认",
  executing: "执行中",
  verifying: "验证中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const EXECUTION_STAGE_LABELS = {
  analyze: "分析阶段",
  plan: "规划阶段",
  execute: "执行阶段",
  verify: "验证阶段",
};

const INTENT_STATUS_LABELS = {
  answer: "问答",
  plan: "计划",
  edit: "修改",
  run: "运行",
  debug: "调试",
  review: "审阅",
  verify: "验证",
  summarize: "总结",
  search: "搜索",
  refactor: "重构",
  generate_file: "生成文件",
};

function setActiveSessionId(sessionId) {
  activeSessionId = sessionId || undefined;
  if (activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
}

function getSelectedPermissionPolicy() {
  return permissionPolicySelect?.value || "confirmBeforeEdit";
}

function getExplicitRunMode() {
  const value = explicitModeSelect?.value?.trim();
  return value || undefined;
}

function persistPermissionPolicy() {
  if (!permissionPolicySelect) return;
  localStorage.setItem(PERMISSION_POLICY_KEY, permissionPolicySelect.value);
}

function restorePermissionPolicy() {
  if (!permissionPolicySelect) return;
  const saved = localStorage.getItem(PERMISSION_POLICY_KEY);
  if (saved && PERMISSION_POLICY_LABELS[saved]) permissionPolicySelect.value = saved;
}

function positionAdvancedPanel() {
  const entry = document.querySelector(".advanced-entry");
  const summary = entry?.querySelector("summary");
  const panel = entry?.querySelector(".advanced-panel");
  if (!(entry instanceof HTMLDetailsElement) || !entry.open || !summary || !panel) return;
  const summaryRect = summary.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const mainRect = document.querySelector(".main")?.getBoundingClientRect();
  const margin = 12;
  const minLeft = (mainRect?.left ?? 0) + margin;
  const maxLeft = window.innerWidth - panelRect.width - margin;
  const left = Math.max(minLeft, Math.min(summaryRect.left, maxLeft));
  const top = Math.max(margin, summaryRect.top - panelRect.height - 8);
  panel.style.setProperty("--advanced-panel-left", `${Math.round(left)}px`);
  panel.style.setProperty("--advanced-panel-top", `${Math.round(top)}px`);
}

function bindAdvancedPanelPositioning() {
  const entry = document.querySelector(".advanced-entry");
  if (!(entry instanceof HTMLDetailsElement)) return;
  entry.addEventListener("toggle", () => {
    if (entry.open) requestAnimationFrame(positionAdvancedPanel);
  });
  window.addEventListener("resize", positionAdvancedPanel);
  window.addEventListener("scroll", positionAdvancedPanel, true);
}

function sessionMeta() {
  return activeSessionId ? ` · session ${activeSessionId.slice(0, 8)}…` : "";
}

function clearWelcome() {
  feed.querySelectorAll(".welcome, .home-page, .test-page-shell").forEach((el) => el.remove());
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // 无时区后缀的 SQLite/服务端 UTC 文本 → 按 UTC 解析后再转本地显示
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
      const d = new Date(`${trimmed.replace(" ", "T")}Z`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 将服务端时间戳格式化为浏览器当前系统时区的本地时间。 */
function formatDateTime(value) {
  const d = parseTimestamp(value);
  if (!d) return value == null || value === "" ? "-" : String(value);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
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
      <p>统一自动工作流入口：描述目标后系统自动识别意图、路由工作流，并由权限策略控制写文件与命令边界。</p>
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
  closeSessionMenu();
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
        const active = s.id === activeSessionId ? " active" : "";
        const title = s.title || "未命名会话";
        const wsKey = s.workspaceKey ?? s.workspace_key;
        const wsHint = wsKey ? ` · ${escapeHtml(workspaceLabel(wsKey))}` : "";
        return `
          <div class="sidebar-session-row${active}">
            <button class="sidebar-session" data-action="resume-session" data-session-id="${escapeHtml(s.id)}">
              <span>${escapeHtml(title)}</span>
              <small>${escapeHtml(formatDateTime(updated))}${wsHint} · ${escapeHtml(s.id.slice(0, 8))}</small>
            </button>
            <button type="button" class="sidebar-session-more" data-action="session-menu-toggle" data-session-id="${escapeHtml(s.id)}" data-session-title="${escapeHtml(title)}" aria-label="会话菜单" title="更多">⋯</button>
          </div>`;
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
  if (message.role === "assistant") {
    bubble.classList.add("structured-bubble", "history-answer-bubble");
    renderMarkdownInto(bubble, message.content || "");
  } else {
    bubble.textContent = message.content || "";
  }
  wrap.appendChild(bubble);
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = `${roleLabel(message.role)} · ${formatDateTime(message.createdAt ?? message.created_at)}`;
  wrap.appendChild(meta);
  return wrap;
}

function parseAgentActionJson(content) {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function stringifyAgentAnswer(answer) {
  if (typeof answer === "string") return answer;
  if (answer == null) return "";
  return JSON.stringify(answer, null, 2);
}

function extractFinalAnswerFromReplies(replies) {
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    const message = replies[i];
    if (message.role !== "assistant") continue;
    const action = parseAgentActionJson(message.content);
    if (action?.action === "final") {
      return stringifyAgentAnswer(action.answer);
    }
  }
  const lastAssistant = [...replies].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.content && !parseAgentActionJson(lastAssistant.content)) {
    return lastAssistant.content;
  }
  return "";
}

function turnHasThinkingTrail(replies) {
  if (!replies?.length) return false;
  let assistantCount = 0;
  for (const message of replies) {
    if (message.role === "tool") return true;
    if (message.role !== "assistant") continue;
    assistantCount += 1;
    const action = parseAgentActionJson(message.content);
    if (!action || action.action !== "final") return true;
  }
  return assistantCount > 1;
}

function formatHistoryThinkingEntry(message) {
  if (message.role === "assistant") {
    const action = parseAgentActionJson(message.content);
    if (action?.action === "tool") {
      return `【工具调用】${action.tool}\n${JSON.stringify(action.input ?? {}, null, 2)}`;
    }
    if (action) {
      return JSON.stringify(action, null, 2);
    }
    return message.content || "";
  }
  if (message.role === "tool") {
    const text = message.content || "";
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }
  return message.content || "";
}

function renderMarkdownInto(el, text) {
  if (typeof marked !== "undefined") {
    el.classList.add("markdown-body");
    el.innerHTML = marked.parse(text || "");
    return;
  }
  el.textContent = text || "";
}

function groupMessagesIntoTurns(messages) {
  const turns = [];
  let current = null;
  for (const message of messages) {
    if (message.role === "user") {
      if (current) turns.push(current);
      current = { user: message, replies: [] };
      continue;
    }
    if (message.role === "system") {
      turns.push({ user: null, replies: [message], systemOnly: true });
      continue;
    }
    if (current) {
      current.replies.push(message);
    } else {
      turns.push({ user: null, replies: [message] });
    }
  }
  if (current) turns.push(current);
  return turns;
}

function renderHistoryTurn(turn) {
  const frag = document.createDocumentFragment();
  if (turn.user) {
    frag.appendChild(renderStoredMessage(turn.user));
  }
  if (turn.systemOnly) {
    for (const message of turn.replies) {
      frag.appendChild(renderStoredMessage(message));
    }
    return frag;
  }

  const replies = turn.replies || [];
  if (replies.length === 0) return frag;

  const wrap = document.createElement("div");
  wrap.className = "msg assistant history-message history-assistant-turn";

  const bubble = document.createElement("div");
  bubble.className = "bubble structured-bubble history-answer-bubble";
  const finalAnswer = extractFinalAnswerFromReplies(replies);
  renderMarkdownInto(bubble, finalAnswer || "（无最终回答）");
  wrap.appendChild(bubble);

  if (turnHasThinkingTrail(replies)) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "history-thinking-toggle";
    toggle.textContent = "查看思考过程";
    toggle.setAttribute("aria-expanded", "false");

    const panel = document.createElement("div");
    panel.className = "history-thinking-panel";
    panel.hidden = true;

    for (const message of replies) {
      const entry = document.createElement("div");
      entry.className = "history-thinking-entry";
      const head = document.createElement("div");
      head.className = "history-thinking-entry-head";
      head.textContent = `${roleLabel(message.role)} · ${formatDateTime(message.createdAt ?? message.created_at)}`;
      const body = document.createElement("pre");
      body.className = "history-thinking-entry-body";
      body.textContent = formatHistoryThinkingEntry(message);
      entry.appendChild(head);
      entry.appendChild(body);
      panel.appendChild(entry);
    }

    toggle.addEventListener("click", () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      toggle.textContent = opening ? "隐藏思考过程" : "查看思考过程";
      toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    });

    wrap.appendChild(toggle);
    wrap.appendChild(panel);
  }

  const lastReply = replies[replies.length - 1];
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = `助手 · ${formatDateTime(lastReply?.createdAt ?? lastReply?.created_at)}`;
  wrap.appendChild(meta);
  frag.appendChild(wrap);
  return frag;
}

function renderHistoryMessages(messages) {
  const frag = document.createDocumentFragment();
  for (const turn of groupMessagesIntoTurns(messages)) {
    frag.appendChild(renderHistoryTurn(turn));
  }
  return frag;
}

let activeSessionMenu = null;

function ensureSessionMenuPopover() {
  let pop = document.getElementById("session-menu-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "session-menu-popover";
    pop.className = "session-menu-popover";
    pop.hidden = true;
    document.body.appendChild(pop);
    pop.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = e.target.closest("[data-session-menu-action]");
      if (!item || !activeSessionMenu) return;
      void handleSessionMenuAction(item.dataset.sessionMenuAction);
    });
  }
  return pop;
}

function closeSessionMenu() {
  const pop = document.getElementById("session-menu-popover");
  if (pop) pop.hidden = true;
  if (activeSessionMenu?.anchor) {
    activeSessionMenu.anchor.removeAttribute("aria-expanded");
  }
  activeSessionMenu = null;
}

function positionSessionMenu(anchor) {
  const pop = ensureSessionMenuPopover();
  pop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = pop.offsetWidth || 168;
  let left = rect.right - width + 4;
  let top = rect.bottom + 6;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const height = pop.offsetHeight || 120;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 6);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function openSessionMenu(anchor, sessionId, title) {
  activeSessionMenu = { sessionId, title: title || "未命名会话", anchor };
  anchor.setAttribute("aria-expanded", "true");
  renderSessionMenuPopover("menu");
  positionSessionMenu(anchor);
}

function renderSessionMenuPopover(mode) {
  const menu = activeSessionMenu;
  if (!menu) return;
  const pop = ensureSessionMenuPopover();
  if (mode === "menu") {
    pop.innerHTML = `
      <button type="button" class="session-menu-item" data-session-menu-action="rename">
        <span class="session-menu-icon" aria-hidden="true">✎</span>
        <span>重命名</span>
      </button>
      <div class="session-menu-sep" role="separator"></div>
      <button type="button" class="session-menu-item danger" data-session-menu-action="delete">
        <span class="session-menu-icon" aria-hidden="true">🗑</span>
        <span>删除</span>
      </button>`;
  } else if (mode === "rename") {
    pop.innerHTML = `
      <div class="session-menu-panel-title">重命名会话</div>
      <input class="session-menu-input" type="text" maxlength="120" value="${escapeHtml(menu.title)}" />
      <div class="session-menu-panel-actions">
        <button type="button" class="session-menu-btn" data-session-menu-action="rename-cancel">取消</button>
        <button type="button" class="session-menu-btn primary" data-session-menu-action="rename-save">保存</button>
      </div>`;
    const input = pop.querySelector(".session-menu-input");
    input?.focus();
    input?.select();
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        pop.querySelector('[data-session-menu-action="rename-save"]')?.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        renderSessionMenuPopover("menu");
        positionSessionMenu(menu.anchor);
      }
    });
  } else if (mode === "delete") {
    pop.innerHTML = `
      <div class="session-menu-panel-title">删除会话</div>
      <p class="session-menu-hint">将删除「${escapeHtml(menu.title)}」的消息、摘要与关联记录，且不可恢复。</p>
      <div class="session-menu-panel-actions">
        <button type="button" class="session-menu-btn" data-session-menu-action="delete-cancel">取消</button>
        <button type="button" class="session-menu-btn danger" data-session-menu-action="delete-confirm">删除</button>
      </div>`;
  }
  if (!pop.hidden && menu.anchor) positionSessionMenu(menu.anchor);
}

async function saveHistorySessionTitle(sessionId, title) {
  const trimmed = title.trim();
  if (!trimmed) {
    addSystemError("标题不能为空");
    return false;
  }
  await api(`/api/context/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: trimmed }),
  });
  closeSessionMenu();
  await loadHistorySessions();
  if (activeSessionId === sessionId) {
    await renderSessionConversation(sessionId);
  }
  return true;
}

async function performDeleteHistorySession(sessionId) {
  await api(`/api/context/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  closeSessionMenu();
  if (activeSessionId === sessionId) {
    setActiveSessionId(undefined);
    await renderHomeHistory();
    return;
  }
  await loadHistorySessions();
}

async function handleSessionMenuAction(action) {
  const menu = activeSessionMenu;
  if (!menu) return;
  const pop = ensureSessionMenuPopover();
  if (action === "rename") {
    renderSessionMenuPopover("rename");
    return;
  }
  if (action === "rename-cancel") {
    renderSessionMenuPopover("menu");
    return;
  }
  if (action === "rename-save") {
    const input = pop.querySelector(".session-menu-input");
    const title = input instanceof HTMLInputElement ? input.value : menu.title;
    try {
      await saveHistorySessionTitle(menu.sessionId, title);
    } catch (err) {
      addSystemError(String(err.message || err));
    }
    return;
  }
  if (action === "delete") {
    renderSessionMenuPopover("delete");
    return;
  }
  if (action === "delete-cancel") {
    renderSessionMenuPopover("menu");
    return;
  }
  if (action === "delete-confirm") {
    try {
      await performDeleteHistorySession(menu.sessionId);
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  }
}

function bindSessionMenuDismiss() {
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("session-menu-popover");
    if (!pop || pop.hidden) return;
    if (e.target.closest("#session-menu-popover") || e.target.closest(".sidebar-session-more")) return;
    closeSessionMenu();
  });
  window.addEventListener("resize", closeSessionMenu);
  window.addEventListener("scroll", closeSessionMenu, true);
}

async function renderSessionConversation(sessionId) {
  feed.innerHTML = `<div class="history-empty">读取会话中…</div>`;
  try {
    const data = await api(`/api/context/sessions/${encodeURIComponent(sessionId)}`);
    const messages = data.messages || [];
    feed.innerHTML = "";
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "这个会话还没有历史消息。";
      feed.appendChild(empty);
    } else {
      feed.appendChild(renderHistoryMessages(messages));
      const anchor = document.createElement("div");
      anchor.className = "conversation-scroll-anchor";
      feed.appendChild(anchor);
    }
    scrollToBottomAfterLayout();
  } catch (err) {
    feed.innerHTML = `<div class="history-empty is-error">${escapeHtml(String(err.message || err))}</div>`;
  }
}

function attachWorkflowBadgeToLastUserMessage(meta) {
  if (!meta) return;
  const label = getWorkflowStatusLabel(meta);
  if (!label) return;
  const userMsgs = feed.querySelectorAll(".msg.user");
  const last = userMsgs[userMsgs.length - 1];
  if (!last || last.querySelector(".msg-workflow-badge")) return;
  const badge = document.createElement("div");
  badge.className = "msg-workflow-badge";
  badge.innerHTML = renderWorkflowStatus(meta);
  last.appendChild(badge);
}

function addMessage(role, content, meta, opts) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (content instanceof Node) {
    bubble.classList.add("structured-bubble");
    bubble.appendChild(content);
  } else {
    bubble.textContent = content;
  }
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

function parseSseBlock(block) {
  let eventType = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return null;
  try {
    return { type: eventType, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

async function consumeSsePost(path, payload, onEvent, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `请求失败：${res.status}`);
  }
  if (!res.body) throw new Error("SSE 响应无 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const evt = parseSseBlock(part);
      if (evt) onEvent(evt);
    }
  }
}

function modelTurnLabel(turn) {
  if (turn.phase === "started") return `第 ${turn.iteration} 轮 · 等待模型…`;
  if (turn.phase === "parse_error") return `第 ${turn.iteration} 轮 · JSON 解析失败`;
  if (turn.action === "final") return `第 ${turn.iteration} 轮 · 生成最终答案`;
  if (turn.action === "tool") {
    const thought = turn.thought ? ` · ${turn.thought}` : "";
    return `第 ${turn.iteration} 轮 · 调用 ${turn.tool}${thought}`;
  }
  return `第 ${turn.iteration} 轮 · 完成`;
}

function buildAgentStepRow(s) {
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
  const confirmation = renderConfirmationRequest(s.confirmationRequest);
  row.innerHTML = `
    <div class="plan-step-head">
      ${state}
      <span class="plan-step-title">#${s.iteration} ${escapeHtml(s.tool)}</span>
      ${dur}
      ${riskTag}
    </div>
    ${thought}
    <div class="plan-step-desc">${io}</div>
    ${confirmation}
    <div class="plan-step-desc">${out}</div>`;
  return row;
}

const ACTIVITY_STEP_ICONS = {
  analysis: "💭",
  plan: "📋",
  todo: "☑️",
  tool_call: "🔧",
  file_search: "🔍",
  file_read: "📖",
  file_write: "✏️",
  file_patch: "🧩",
  shell: "💻",
  web_search: "🌐",
  validation: "🧪",
  summary: "✅",
  error: "⚠️",
  retry: "↻",
};

const ACTIVITY_STEP_STATUS_LABELS = {
  pending: "等待",
  running: "进行中",
  success: "完成",
  failed: "失败",
  skipped: "跳过",
};

function createActivityTimelinePanel(initialLabel) {
  const card = document.createElement("div");
  card.className = "plan-card activity-timeline-card";

  const header = document.createElement("div");
  header.className = "activity-timeline-header";
  header.innerHTML = `<strong>执行过程</strong> <span class="activity-timeline-status">${escapeHtml(initialLabel)}</span>`;
  card.appendChild(header);

  const goalEl = document.createElement("div");
  goalEl.className = "activity-run-goal";
  card.appendChild(goalEl);

  const stepsWrap = document.createElement("div");
  stepsWrap.className = "activity-steps";
  card.appendChild(stepsWrap);

  const summaryEl = document.createElement("div");
  summaryEl.className = "activity-summary";
  summaryEl.style.display = "none";
  card.appendChild(summaryEl);

  const stepNodes = new Map();

  function stepStatusClass(status) {
    return `activity-step-${status || "pending"}`;
  }

  function buildActivityStepRow(step) {
    const row = document.createElement("div");
    row.className = `activity-step ${stepStatusClass(step.status)}`;
    row.dataset.stepId = step.id;
    const icon = ACTIVITY_STEP_ICONS[step.type] || "•";
    const meta = step.metadata || {};
    let detailsHtml = "";
    if (meta.collapsible && (meta.args || meta.command)) {
      const body = meta.command
        ? escapeHtml(meta.command)
        : escapeHtml(JSON.stringify(meta.args, null, 2));
      detailsHtml = `
        <details class="activity-step-details">
          <summary>查看详情</summary>
          <pre>${body}</pre>
        </details>`;
    }
    const statusLabel = ACTIVITY_STEP_STATUS_LABELS[step.status] || step.status;
    row.innerHTML = `
      <div class="activity-step-head">
        <span class="activity-step-icon">${icon}</span>
        <span class="activity-step-title">${escapeHtml(step.title)}</span>
        <span class="activity-step-badge">${escapeHtml(statusLabel)}</span>
      </div>
      ${step.content ? `<div class="activity-step-content">${escapeHtml(step.content)}</div>` : ""}
      ${detailsHtml}`;
    return row;
  }

  function refreshActivityStepRow(row, step) {
    row.className = `activity-step ${stepStatusClass(step.status)}`;
    const badge = row.querySelector(".activity-step-badge");
    if (badge) badge.textContent = ACTIVITY_STEP_STATUS_LABELS[step.status] || step.status;
    let contentEl = row.querySelector(".activity-step-content");
    if (step.content) {
      if (!contentEl) {
        contentEl = document.createElement("div");
        contentEl.className = "activity-step-content";
        row.appendChild(contentEl);
      }
      contentEl.textContent = step.content;
    }
    if (step.metadata?.errorMessage && !row.querySelector(".activity-step-error")) {
      const err = document.createElement("div");
      err.className = "activity-step-error";
      err.textContent = step.metadata.errorMessage;
      row.appendChild(err);
    }
  }

  return {
    card,
    setStatus(text) {
      const el = header.querySelector(".activity-timeline-status");
      if (el) el.textContent = text;
    },
    handleEvent(event) {
      if (!event?.type) return;
      if (event.type === "run_started" && event.run) {
        goalEl.textContent = event.run.goal || "";
        this.setStatus("运行中");
      } else if (event.type === "step_started" && event.step) {
        const row = buildActivityStepRow(event.step);
        stepsWrap.appendChild(row);
        stepNodes.set(event.step.id, { row, step: { ...event.step } });
        scrollToBottom();
      } else if (event.type === "step_delta") {
        const node = stepNodes.get(event.stepId);
        if (node) {
          node.step.content = (node.step.content || "") + (event.contentDelta || "");
          refreshActivityStepRow(node.row, node.step);
        }
      } else if (event.type === "step_completed") {
        const node = stepNodes.get(event.stepId);
        if (node) {
          node.step.status = "success";
          if (event.result) node.step.content = event.result;
          refreshActivityStepRow(node.row, node.step);
        }
      } else if (event.type === "step_failed") {
        const node = stepNodes.get(event.stepId);
        if (node) {
          node.step.status = "failed";
          node.step.metadata = { ...node.step.metadata, errorMessage: event.error };
          refreshActivityStepRow(node.row, node.step);
        }
      } else if (event.type === "step_skipped") {
        const node = stepNodes.get(event.stepId);
        if (node) {
          node.step.status = "skipped";
          refreshActivityStepRow(node.row, node.step);
        }
      } else if (event.type === "run_completed") {
        this.setStatus("已完成");
        summaryEl.style.display = "block";
        summaryEl.textContent = event.summary || "";
      } else if (event.type === "run_failed") {
        this.setStatus("失败");
        summaryEl.style.display = "block";
        summaryEl.textContent = event.error || "";
      } else if (event.type === "run_cancelled") {
        this.setStatus("已取消");
        if (event.reason) {
          summaryEl.style.display = "block";
          summaryEl.textContent = event.reason;
        }
      }
      scrollToBottom();
    },
    finalize(result) {
      if (result?.answer && summaryEl.style.display === "none") {
        summaryEl.style.display = "block";
        summaryEl.textContent = result.answer;
      }
    },
  };
}

function createAgentStreamPanel(initialLabel) {
  const card = document.createElement("div");
  card.className = "plan-card thinking-stream-card";

  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `<strong>思考过程</strong> <span class="thinking-status">${escapeHtml(initialLabel)}</span>`;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "thinking-cancel-btn";
  cancelBtn.textContent = "取消运行";
  cancelBtn.style.display = "none";
  header.appendChild(cancelBtn);
  card.appendChild(header);

  const turnsWrap = document.createElement("div");
  turnsWrap.className = "thinking-turns";
  card.appendChild(turnsWrap);

  const stepsWrap = document.createElement("div");
  stepsWrap.className = "plan-steps thinking-steps";
  card.appendChild(stepsWrap);

  const tokensWrap = document.createElement("div");
  tokensWrap.className = "thinking-tokens";
  tokensWrap.style.display = "none";
  card.appendChild(tokensWrap);

  const answerTitle = document.createElement("div");
  answerTitle.className = "plan-goal";
  answerTitle.style.display = "none";
  answerTitle.textContent = "最终回答";
  card.appendChild(answerTitle);

  const answerBody = document.createElement("div");
  answerBody.className = "plan-step-desc thinking-answer";
  answerBody.style.whiteSpace = "pre-wrap";
  answerBody.style.display = "none";
  card.appendChild(answerBody);

  const metaBox = document.createElement("div");
  metaBox.className = "plan-step-desc thinking-meta";
  metaBox.style.display = "none";
  card.appendChild(metaBox);

  const turnNodes = new Map();
  let activeRunId = null;

  return {
    card,
    setStatus(text) {
      const el = header.querySelector(".thinking-status");
      if (el) el.textContent = text;
    },
    setRunId(runId) {
      activeRunId = runId;
      cancelBtn.style.display = runId ? "inline-block" : "none";
    },
    onCancel(handler) {
      cancelBtn.onclick = () => {
        if (activeRunId) {
          void fetch("/api/runs/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: activeRunId }),
          }).catch(() => {});
        }
        handler?.();
      };
    },
    showTokens(show) {
      tokensWrap.style.display = show ? "block" : "none";
    },
    addModelTurn(turn) {
      let row = turnNodes.get(turn.iteration);
      if (!row) {
        row = document.createElement("div");
        row.className = "thinking-turn";
        turnsWrap.appendChild(row);
        turnNodes.set(turn.iteration, row);
      }
      row.className = `thinking-turn thinking-turn-${turn.phase}${turn.action === "tool" ? " thinking-turn-tool" : ""}`;
      const modelHint =
        turn.clientName && turn.modelName
          ? ` <span class="plan-perms">${escapeHtml(turn.clientName)} / ${escapeHtml(turn.modelName)}${turn.latencyMs != null ? ` · ${turn.latencyMs}ms` : ""}</span>`
          : "";
      row.innerHTML = `<div class="thinking-turn-head">${escapeHtml(modelTurnLabel(turn))}${modelHint}</div>`;
      if (turn.contentPreview && turn.phase !== "started") {
        const preview = document.createElement("div");
        preview.className = "thinking-turn-preview";
        preview.textContent = turn.contentPreview;
        row.appendChild(preview);
      }
      scrollToBottom();
    },
    addStep(step) {
      stepsWrap.appendChild(buildAgentStepRow(step));
      scrollToBottom();
    },
    appendToken(delta) {
      if (!delta) return;
      tokensWrap.textContent += delta;
      scrollToBottom();
    },
    finalize(result) {
      cancelBtn.style.display = "none";
      const cancelled = result.executionMeta?.stopReason === "user_cancelled";
      this.setStatus(cancelled ? "已取消" : "已完成");
      if (result.notifications?.length) {
        const notes = document.createElement("div");
        notes.className = "plan-step-desc";
        notes.style.marginBottom = "8px";
        notes.innerHTML = `<strong>安全点消费的通知</strong><br>${result.notifications
          .map((n) => escapeHtml(`[${n.source}] ${n.message}`))
          .join("<br>")}`;
        card.insertBefore(notes, answerTitle);
      }
      if (result.executionMeta) {
        metaBox.style.display = "block";
        const m = result.executionMeta;
        const b = m.budget || {};
        const u = m.usage || {};
        const workflowStatus = renderWorkflowStatus(m);
        const locationInfo = m.location
          ? `\nlocation=${m.location.usedLocateSteps ?? 0} steps · found=${(m.location.locatedFiles || []).slice(0, 4).join(",") || "-"}`
          : "";
        metaBox.innerHTML = `${workflowStatus}<strong>执行元信息</strong><br>${escapeHtml(
          `mode=${m.mode} · stop=${m.stopReason} · model=${u.modelTurns ?? m.usedModelTurns}/${b.maxModelTurns ?? "-"} · tools=${u.toolCalls ?? m.usedToolCalls}/${b.maxToolCalls ?? "-"}`,
        )}${escapeHtml(locationInfo)}`;
      }
      answerTitle.style.display = "block";
      answerBody.style.display = "block";
      answerBody.textContent = result.answer || "";
      return `${cancelled ? "已取消 · " : ""}模型轮次 ${result.iterations} · 工具 ${result.steps?.length ?? 0} 次${result.reachedLimit ? " · 已达预算" : ""}`;
    },
  };
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

function workspaceLabel(workspaceKey) {
  const key = workspaceKey?.trim();
  if (!key) {
    const def = appConfig?.workspaces?.find((w) => w.id === appConfig?.defaultWorkspaceKey);
    return def?.label ?? "默认工作区";
  }
  const hit = appConfig?.workspaces?.find((w) => w.id === key);
  if (hit?.label) return hit.label;
  if (key.startsWith("custom:")) {
    const custom = decodeCustomWorkspaceKey(key);
    return custom ? `自定义：${custom}` : "自定义工作区";
  }
  return key;
}

function decodeCustomWorkspaceKey(workspaceKey) {
  const key = workspaceKey?.trim();
  if (!key?.startsWith("custom:")) return undefined;
  const encoded = key.slice("custom:".length);
  if (!encoded) return undefined;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return undefined;
  }
}

function pickWorkspaceSelection(workspaces) {
  if (!workspaces?.length) return { workspaceKey: undefined };
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "workspace-modal-overlay";
    overlay.innerHTML = `
      <div class="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title">
        <div class="workspace-modal-title" id="workspace-modal-title">选择工作区</div>
        <p class="workspace-modal-hint">新会话将在所选目录下执行工具与索引；创建后不可更改。你也可以输入任意本机目录。</p>
        <div class="workspace-modal-list"></div>
        <div class="workspace-custom-row">
          <input class="workspace-custom-input" type="text" placeholder="例如：D:\\Projects\\MyRepo 或 ../my-folder" />
          <button type="button" class="session-menu-btn primary" data-workspace-action="custom-confirm">使用该路径</button>
        </div>
        <div class="workspace-modal-actions">
          <button type="button" class="session-menu-btn" data-workspace-action="cancel">取消</button>
        </div>
      </div>`;
    const list = overlay.querySelector(".workspace-modal-list");
    for (const w of workspaces) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "workspace-option";
      btn.dataset.workspaceId = w.id;
      btn.innerHTML = `<strong>${escapeHtml(w.label)}</strong><small>${escapeHtml(w.root || w.id)}</small>`;
      list.appendChild(btn);
    }
    const customInput = overlay.querySelector(".workspace-custom-input");
    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && document.activeElement === customInput) {
        const value = customInput?.value?.trim();
        if (value) close({ workspaceRoot: value });
      }
    };
    overlay.addEventListener("click", (e) => {
      const opt = e.target.closest(".workspace-option");
      if (opt?.dataset.workspaceId) close({ workspaceKey: opt.dataset.workspaceId });
      if (e.target.closest('[data-workspace-action="custom-confirm"]')) {
        const value = customInput?.value?.trim();
        if (!value) {
          customInput?.focus();
          return;
        }
        close({ workspaceRoot: value });
      }
      if (e.target.closest('[data-workspace-action="cancel"]') || e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    list.querySelector(".workspace-option")?.focus();
  });
}

async function createNewSession(opts = {}) {
  if (!appConfig) await loadConfig();
  const workspaces = appConfig?.workspaces ?? [];
  const picked = await pickWorkspaceSelection(workspaces);
  if (!picked) return null;
  const title = opts.title ?? `会话 ${new Date().toLocaleString()}`;
  const body = { title };
  if (picked.workspaceRoot) {
    body.workspaceRoot = picked.workspaceRoot;
  } else {
    const key = picked.workspaceKey ?? workspaces[0]?.id ?? appConfig?.defaultWorkspaceKey;
    if (key) body.workspaceKey = key;
  }
  const data = await api("/api/context/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.session;
}

async function startNewChatSession() {
  try {
    const session = await createNewSession();
    if (!session) return;
    setActiveSessionId(session.id);
    await loadHistorySessions();
    messageInput.focus();
  } catch (err) {
    addSystemError(String(err.message || err));
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

function formatStorageBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function handleStorage() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "tool-panel storage-panel";

  const title = document.createElement("div");
  title.className = "tool-desc";
  title.textContent = "本地存储用量与安全清理：先预览（dry-run）再执行 apply，仅删除低风险 temp/cache/已消费通知。";
  panel.appendChild(title);

  const btnRow = document.createElement("div");
  btnRow.className = "tool-row";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "action-btn";
  refreshBtn.textContent = "刷新用量";
  btnRow.appendChild(refreshBtn);

  const previewBtn = document.createElement("button");
  previewBtn.className = "action-btn secondary";
  previewBtn.textContent = "安全清理预览";
  previewBtn.style.marginLeft = "8px";
  btnRow.appendChild(previewBtn);

  const applyBtn = document.createElement("button");
  applyBtn.className = "action-btn secondary";
  applyBtn.textContent = "执行清理";
  applyBtn.style.marginLeft = "8px";
  applyBtn.disabled = true;
  btnRow.appendChild(applyBtn);

  panel.appendChild(btnRow);

  const summary = document.createElement("div");
  summary.className = "run-report-usage";
  summary.textContent = "点击「刷新用量」加载分类占用。";
  panel.appendChild(summary);

  const previewBox = document.createElement("pre");
  previewBox.className = "tool-output";
  previewBox.textContent = "";
  panel.appendChild(previewBox);

  const usageTableHost = document.createElement("div");
  panel.appendChild(usageTableHost);

  let lastPreview = null;

  async function loadUsage() {
    summary.textContent = "加载中…";
    const data = await api("/api/storage/usage");
    summary.textContent = `总占用 ${formatStorageBytes(data.totalBytes)} · 更新于 ${formatDateTime(data.generatedAt)}`;
    const cats = data.categories || [];
    if (cats.length === 0) {
      usageTableHost.innerHTML = `<div class="history-empty">暂无分类数据。</div>`;
      return;
    }
    const rows = cats
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.name)}</td><td>${formatStorageBytes(c.bytes)}</td><td>${c.files}</td></tr>`,
      )
      .join("");
    usageTableHost.innerHTML = `
      <table class="model-table">
        <thead><tr><th>类别</th><th>占用</th><th>文件数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  refreshBtn.addEventListener("click", async () => {
    try {
      await loadUsage();
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  previewBtn.addEventListener("click", async () => {
    try {
      previewBox.textContent = "预览中…";
      const report = await api("/api/storage/cleanup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "safe" }),
      });
      lastPreview = report;
      applyBtn.disabled = !report.cleanupRunId;
      const deletable = (report.actions || []).filter((a) => a.canDelete);
      previewBox.textContent = [
        `cleanupRunId: ${report.cleanupRunId}`,
        `预计释放: ${formatStorageBytes(report.summary?.estimatedBytesToFree || 0)}`,
        `可删动作: ${deletable.length}`,
        ...deletable.slice(0, 15).map((a) => `[${a.risk}] ${a.path} (${formatStorageBytes(a.bytes)})`),
        deletable.length > 15 ? "..." : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (err) {
      previewBox.textContent = String(err.message || err);
      addSystemError(String(err.message || err));
    }
  });

  applyBtn.addEventListener("click", async () => {
    if (!lastPreview?.cleanupRunId) return;
    if (!window.confirm("确认执行低风险清理？此操作将删除 temp/cache 等待清理文件。")) return;
    try {
      const result = await api("/api/storage/cleanup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cleanupRunId: lastPreview.cleanupRunId, confirm: true }),
      });
      previewBox.textContent = [
        previewBox.textContent,
        "",
        `已执行: 释放 ${formatStorageBytes(result.bytesFreed || 0)}，成功 ${result.applied ?? 0} 项`,
      ].join("\n");
      lastPreview = null;
      applyBtn.disabled = true;
      await loadUsage();
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  addMessage("system", panel);
  try {
    await loadUsage();
  } catch (err) {
    summary.textContent = `加载失败: ${err.message || err}`;
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

  const matrixBtn = document.createElement("button");
  matrixBtn.className = "action-btn secondary";
  matrixBtn.textContent = "能力矩阵";

  row.appendChild(limitInput);
  row.appendChild(sessionInput);
  row.appendChild(refreshBtn);
  row.appendChild(statsBtn);
  row.appendChild(evalBtn);
  row.appendChild(matrixBtn);
  panel.appendChild(row);

  const matrixBox = document.createElement("div");
  matrixBox.className = "tool-result routing-matrix-box";
  matrixBox.style.display = "none";
  panel.appendChild(matrixBox);

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
  matrixBtn.addEventListener("click", async () => {
    matrixBox.style.display = "block";
    matrixBox.classList.remove("err");
    matrixBox.textContent = "加载能力矩阵中…";
    try {
      const data = await api("/api/routing/profiles");
      const uncovered = (data.coverage || []).filter((c) => c.uncovered);
      const warnings = (data.validationWarnings || [])
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("");
      const rows = (data.coverage || [])
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.taskType)}</td><td>L${c.minLevel}</td><td>${escapeHtml((c.primaryCandidates || []).join(", ") || "—")}</td><td>${c.uncovered ? "缺口" : "OK"}</td></tr>`,
        )
        .join("");
      matrixBox.innerHTML = `
        <div class="routing-stats-summary">
          <span>模型 ${(data.profiles || []).length}</span>
          <span>任务类型 ${(data.matrix || []).length}</span>
          <span>缺口 ${uncovered.length}</span>
        </div>
        ${warnings ? `<ul class="routing-suggestion-list">${warnings}</ul>` : ""}
        ${rows ? `<table class="model-table routing-stats-table"><thead><tr><th>任务</th><th>等级</th><th>primary</th><th>覆盖</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
        <details class="routing-stats-raw"><summary>原始 JSON</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>`;
    } catch (err) {
      matrixBox.classList.add("err");
      matrixBox.textContent = String(err.message || err);
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

const PLAN_STATUS_LABEL = {
  draft: "草案",
  validated: "已校验",
  awaiting_approval: "待审批",
  approved: "已审批",
  scheduled: "已排程",
  running: "执行中",
  completed: "已完成",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "失败",
  paused: "已暂停",
  superseded: "已替代",
  rollback_required: "需回滚",
  rolled_back: "已回滚",
};

function setWorkflowStepState(steps, activeIndex) {
  steps.forEach((el, index) => {
    el.classList.toggle("active", index === activeIndex);
    el.classList.toggle("done", index < activeIndex);
  });
}

async function fetchPlanSummary(planId) {
  return api(`/api/plans/${encodeURIComponent(planId)}`);
}

async function fetchPlanPreviewContent(planId, version, format = "markdown") {
  const data = await api(
    `/api/plans/${encodeURIComponent(planId)}/preview?version=${version}&format=${format}`,
  );
  return data.content ?? "";
}

function mountInternalPlanPreviewCard(card, data, hooks = {}) {
  card.className = "plan-card";
  card.dataset.planId = data.planId ?? "";
  card.dataset.planVersion = String(data.version ?? 1);
  card.innerHTML = "";

  const versionBar = document.createElement("div");
  versionBar.className = "plan-version-bar";
  const statusBadge = document.createElement("span");
  statusBadge.className = "plan-status-badge";
  statusBadge.textContent = `${PLAN_STATUS_LABEL[data.status] || data.status || "未知"} · v${data.version ?? 1}`;
  versionBar.appendChild(statusBadge);
  if (data.planId) {
    const idSpan = document.createElement("span");
    idSpan.className = "plan-perms";
    idSpan.textContent = `planId: ${data.planId}`;
    versionBar.appendChild(idSpan);
  }
  const versionSelect = document.createElement("select");
  versionSelect.className = "plan-version-select";
  versionSelect.hidden = true;
  versionBar.appendChild(versionSelect);
  card.appendChild(versionBar);

  const previewBox = document.createElement("div");
  previewBox.className = "plan-markdown-preview";
  card.appendChild(previewBox);

  const jsonToggle = document.createElement("button");
  jsonToggle.type = "button";
  jsonToggle.className = "action-btn secondary";
  jsonToggle.textContent = "查看 PublicPlanJson";
  jsonToggle.hidden = !data.publicPlanJson;
  card.appendChild(jsonToggle);

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
  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "action-btn secondary";
  approveBtn.textContent = "审批";
  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "action-btn secondary";
  rejectBtn.textContent = "拒绝";
  const dryRunBtn = document.createElement("button");
  dryRunBtn.type = "button";
  dryRunBtn.className = "action-btn";
  dryRunBtn.textContent = "dry-run 执行";
  const execBtn = document.createElement("button");
  execBtn.type = "button";
  execBtn.className = "action-btn";
  execBtn.textContent = "正式执行";
  actions.append(approveBtn, rejectBtn, dryRunBtn, execBtn, autoLabel);
  card.appendChild(actions);

  const reviseBox = document.createElement("div");
  reviseBox.className = "plan-revise-box";
  reviseBox.innerHTML = `
    <label class="field"><span>修订说明（自然语言）</span></label>
    <textarea class="plan-revise-input" placeholder="例如：把第 2 步改成先写测试再实现"></textarea>
    <button type="button" class="action-btn secondary plan-revise-btn">生成修订版（version++）</button>`;
  card.appendChild(reviseBox);

  let showingJson = false;
  let current = { ...data };

  async function paintPreview() {
    statusBadge.textContent = `${PLAN_STATUS_LABEL[current.status] || current.status || "未知"} · v${current.version ?? 1}`;
    card.dataset.planVersion = String(current.version ?? 1);
    if (showingJson && current.publicPlanJson) {
      previewBox.classList.remove("markdown-body");
      previewBox.textContent = JSON.stringify(current.publicPlanJson, null, 2);
      return;
    }
    const markdown =
      current.previewMarkdown ||
      (current.planId
        ? await fetchPlanPreviewContent(current.planId, current.version ?? 1, "markdown").catch(() => "")
        : "");
    renderMarkdownInto(previewBox, markdown || "（无 Markdown 预览）");
  }

  async function loadVersions() {
    if (!current.planId) return;
    const summary = await fetchPlanSummary(current.planId);
    const versions = summary.versions || [];
    versionSelect.innerHTML = "";
    for (const v of versions) {
      const opt = document.createElement("option");
      opt.value = String(v.version);
      opt.textContent = `v${v.version} · ${PLAN_STATUS_LABEL[v.status] || v.status}`;
      if (v.version === current.version) opt.selected = true;
      versionSelect.appendChild(opt);
    }
    versionSelect.hidden = versions.length <= 1;
    current.status = summary.status ?? current.status;
  }

  versionSelect.addEventListener("change", async () => {
    const version = Number(versionSelect.value);
    if (!current.planId || !version) return;
    current.version = version;
    const record = await fetchPlanSummary(current.planId);
    const picked = record.versions?.find((v) => v.version === version);
    current.status = picked?.status ?? current.status;
    current.previewMarkdown = await fetchPlanPreviewContent(current.planId, version, "markdown");
    showingJson = false;
    jsonToggle.textContent = "查看 PublicPlanJson";
    await paintPreview();
    hooks.onVersionChange?.(current);
  });

  jsonToggle.addEventListener("click", async () => {
    showingJson = !showingJson;
    jsonToggle.textContent = showingJson ? "查看 Markdown" : "查看 PublicPlanJson";
    if (showingJson && current.planId && !current.publicPlanJson) {
      try {
        const jsonText = await fetchPlanPreviewContent(current.planId, current.version ?? 1, "json");
        current.publicPlanJson = JSON.parse(jsonText);
      } catch {
        current.publicPlanJson = current.publicPlanJson ?? null;
      }
    }
    await paintPreview();
  });

  approveBtn.addEventListener("click", async () => {
    if (!current.planId) return;
    try {
      await api(`/api/plans/${current.planId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: current.version ?? 1, comment: "测试台审批" }),
      });
      current.status = "approved";
      await paintPreview();
      hooks.onStatusChange?.(current);
      addMessage("system", `计划 v${current.version} 已审批`);
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  rejectBtn.addEventListener("click", async () => {
    if (!current.planId) return;
    const comment = window.prompt("拒绝原因（可选）", "") ?? "";
    try {
      await api(`/api/plans/${current.planId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: current.version ?? 1, comment }),
      });
      current.status = "rejected";
      await paintPreview();
      hooks.onStatusChange?.(current);
      addMessage("system", `计划 v${current.version} 已拒绝`);
    } catch (err) {
      addSystemError(String(err.message || err));
    }
  });

  async function runExecute(dryRun) {
    if (!current.planId) return;
    const btn = dryRun ? dryRunBtn : execBtn;
    btn.disabled = true;
    try {
      if (current.status !== "approved") {
        await api(`/api/plans/${current.planId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: current.version ?? 1 }),
        }).catch(() => undefined);
      }
      const exec = await api(`/api/plans/${current.planId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: current.version ?? 1,
          dryRun,
          autoConfirm: autoLabel.querySelector("input").checked,
          sessionId: activeSessionId,
        }),
      });
      addMessage("system", `${dryRun ? "dry-run" : "正式"}执行完成 · runId=${exec.runId ?? ""}`);
      hooks.onExecuted?.(exec, current);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      btn.disabled = false;
    }
  }

  dryRunBtn.addEventListener("click", () => void runExecute(true));
  execBtn.addEventListener("click", () => void runExecute(false));

  reviseBox.querySelector(".plan-revise-btn")?.addEventListener("click", async () => {
    if (!current.planId) return;
    const revisionRequest = reviseBox.querySelector(".plan-revise-input")?.value?.trim();
    if (!revisionRequest) {
      addSystemError("请填写修订说明");
      return;
    }
    const reviseBtn = reviseBox.querySelector(".plan-revise-btn");
    reviseBtn.disabled = true;
    try {
      const revised = await api(`/api/plans/${current.planId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseVersion: current.version ?? 1,
          revisionRequest,
          sessionId: activeSessionId,
          clientName: modelSelect.value === "__default__" ? undefined : modelSelect.value,
        }),
      });
      current = { ...current, ...revised };
      showingJson = false;
      await loadVersions();
      await paintPreview();
      reviseBox.querySelector(".plan-revise-input").value = "";
      hooks.onRevised?.(current);
      addMessage("system", `已生成修订版 v${current.version}（v${revised.supersededVersion} 已标记 superseded）`);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      reviseBtn.disabled = false;
    }
  });

  void loadVersions()
    .then(() => paintPreview())
    .catch(() => paintPreview());

  return {
    update(next) {
      current = { ...current, ...next };
      void loadVersions()
        .then(() => paintPreview())
        .catch(() => paintPreview());
    },
    getCurrent() {
      return { ...current };
    },
  };
}

function renderPlanPreview(data) {
  clearWelcome();
  const card = document.createElement("div");
  mountInternalPlanPreviewCard(card, data);
  addMessage("system", card);
}

async function handlePlanWorkflow() {
  clearWelcome();
  const panel = document.createElement("div");
  panel.className = "plan-workflow-panel plan-card";

  const head = document.createElement("div");
  head.className = "plan-workflow-head";
  head.innerHTML = `
    <h2>计划全流程</h2>
    <p>分析 → 审阅 Todo → 编译 / <strong>一键激活</strong> → 审批 → 执行；支持版本切换与自然语言修订。</p>`;
  panel.appendChild(head);

  const stepRow = document.createElement("div");
  stepRow.className = "plan-workflow-steps";
  const stepLabels = ["① 只读分析", "② 审阅 Todo", "③ 编译草案", "④ 审批 / 执行", "⑤ 修订"];
  const stepEls = stepLabels.map((label) => {
    const el = document.createElement("span");
    el.className = "plan-workflow-step";
    el.textContent = label;
    stepRow.appendChild(el);
    return el;
  });
  panel.appendChild(stepRow);
  setWorkflowStepState(stepEls, 0);

  const state = { userVisiblePlan: null, internalDraft: null };

  const sectionAnalyze = document.createElement("section");
  sectionAnalyze.className = "plan-workflow-section";
  sectionAnalyze.innerHTML = `
    <h3>① 只读分析（UserVisiblePlan）</h3>
    <label class="field"><span>目标</span></label>
    <textarea class="plan-goal-input" rows="3" placeholder="描述你想规划的任务，例如：只读分析项目架构并给出分阶段改造计划"></textarea>
    <div class="plan-actions">
      <button type="button" class="action-btn plan-analyze-btn">生成计划报告</button>
    </div>
    <p class="plan-perms">调用 POST /api/plans/analyze，产出 Markdown + TodoList，不可直接执行。</p>`;
  panel.appendChild(sectionAnalyze);

  const sectionReview = document.createElement("section");
  sectionReview.className = "plan-workflow-section disabled";
  sectionReview.innerHTML = `<h3>② 审阅 Todo</h3><div class="plan-review-body"></div>`;
  panel.appendChild(sectionReview);

  const sectionCompile = document.createElement("section");
  sectionCompile.className = "plan-workflow-section disabled";
  sectionCompile.innerHTML = `
    <h3>③ 编译内部计划</h3>
    <p class="plan-perms">将勾选的 Todo 编译为 awaiting_approval 的 InternalTaskPlan 草案。</p>
    <div class="plan-actions">
      <button type="button" class="action-btn plan-compile-btn">编译选中 Todo</button>
      <button type="button" class="action-btn secondary plan-activate-dry-btn">一键 dry-run 激活（P0）</button>
      <button type="button" class="action-btn plan-activate-btn">一键激活执行（Agent Loop）</button>
    </div>`;
  panel.appendChild(sectionCompile);

  const sectionInternal = document.createElement("section");
  sectionInternal.className = "plan-workflow-section disabled";
  sectionInternal.innerHTML = `<h3>④ 内部计划预览 / 审批 / 执行</h3><div class="plan-internal-host"></div>`;
  panel.appendChild(sectionInternal);

  const sectionRevise = document.createElement("section");
  sectionRevise.className = "plan-workflow-section disabled";
  sectionRevise.innerHTML = `<h3>⑤ 版本与修订</h3><p class="plan-perms">在下方内部计划卡片中使用「生成修订版」；旧版本将标记为 superseded。</p>`;
  panel.appendChild(sectionRevise);

  const reviewBody = sectionReview.querySelector(".plan-review-body");
  const internalHost = sectionInternal.querySelector(".plan-internal-host");
  let internalController = null;

  function enableFrom(index) {
    const sections = [sectionAnalyze, sectionReview, sectionCompile, sectionInternal, sectionRevise];
    sections.forEach((section, i) => {
      section.classList.toggle("disabled", i > index);
    });
    setWorkflowStepState(stepEls, index);
  }

  function renderUserVisibleReview(plan) {
    reviewBody.innerHTML = "";
    const title = document.createElement("div");
    title.className = "plan-goal";
    title.textContent = plan.title || "用户可见计划";
    reviewBody.appendChild(title);

    const md = document.createElement("div");
    md.className = "plan-markdown-preview";
    renderMarkdownInto(md, plan.markdown || "");
    reviewBody.appendChild(md);

    const todoList = document.createElement("div");
    todoList.className = "plan-todo-list";
    for (const todo of plan.todos || []) {
      const row = document.createElement("label");
      row.className = "plan-todo-item";
      row.innerHTML = `
        <input type="checkbox" class="plan-todo-check" value="${escapeHtml(todo.id)}" checked />
        <div>
          <strong>${escapeHtml(todo.priority)} · ${escapeHtml(todo.title)}</strong>
          <div class="plan-todo-meta">${escapeHtml(todo.goal || todo.implementationIdea || "")}</div>
        </div>`;
      todoList.appendChild(row);
    }
    reviewBody.appendChild(todoList);

    const reportRevise = document.createElement("div");
    reportRevise.className = "plan-revise-box";
    reportRevise.innerHTML = `
      <label class="field"><span>修订报告（重新分析）</span></label>
      <textarea class="plan-report-revise-input" placeholder="例如：补充性能优化相关 Todo"></textarea>
      <button type="button" class="action-btn secondary plan-report-revise-btn">按修订说明重新分析</button>`;
    reviewBody.appendChild(reportRevise);

    reportRevise.querySelector(".plan-report-revise-btn")?.addEventListener("click", async () => {
      const extra = reportRevise.querySelector(".plan-report-revise-input")?.value?.trim();
      const goalInput = sectionAnalyze.querySelector(".plan-goal-input");
      const baseGoal = goalInput?.value?.trim() || plan.title;
      const goal = extra ? `${baseGoal}\n\n修订要求：${extra}` : baseGoal;
      if (goalInput) goalInput.value = goal;
      sectionAnalyze.querySelector(".plan-analyze-btn")?.click();
    });
  }

  function showInternalDraft(draft) {
    state.internalDraft = draft;
    internalHost.innerHTML = "";
    const card = document.createElement("div");
    internalController = mountInternalPlanPreviewCard(card, draft, {
      onRevised(next) {
        state.internalDraft = next;
        enableFrom(4);
      },
    });
    internalHost.appendChild(card);
    enableFrom(3);
  }

  sectionAnalyze.querySelector(".plan-analyze-btn")?.addEventListener("click", async () => {
    const goal = sectionAnalyze.querySelector(".plan-goal-input")?.value?.trim();
    if (!goal) {
      addSystemError("请填写分析目标");
      return;
    }
    const btn = sectionAnalyze.querySelector(".plan-analyze-btn");
    btn.disabled = true;
    btn.textContent = "分析中…";
    try {
      const data = await api("/api/plans/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          sessionId: activeSessionId,
          clientName: modelSelect.value === "__default__" ? undefined : modelSelect.value,
        }),
      });
      state.userVisiblePlan = data.userVisiblePlan;
      if (data.sessionId) {
        setActiveSessionId(data.sessionId);
        void loadHistorySessions();
      }
      renderUserVisibleReview(state.userVisiblePlan);
      enableFrom(1);
      addMessage("system", `UserVisiblePlan 已生成：${state.userVisiblePlan.id}`);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = "生成计划报告";
    }
  });

  async function runPlanActivate({ dryRun, autoApprove, executionMode, label, btnSelector }) {
    if (!state.userVisiblePlan?.id) {
      addSystemError("请先生成用户可见计划");
      return;
    }
    const selected = [...sectionReview.querySelectorAll(".plan-todo-check:checked")].map(
      (el) => el.value,
    );
    if (selected.length === 0) {
      addSystemError("请至少勾选一个 Todo");
      return;
    }
    const btn = sectionCompile.querySelector(btnSelector);
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = `${label}…`;
    try {
      const data = await api(`/api/plans/${state.userVisiblePlan.id}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmedTodoIds: selected,
          sessionId: activeSessionId,
          dryRun,
          autoApprove,
          autoConfirm: dryRun,
          executionMode,
        }),
      });
      if (data.phase === "compiled") {
        showInternalDraft(data);
        addMessage("system", `已编译 v${data.version}（待审批）；含副作用步骤须手动 approve`);
      } else {
        if (data.planId) {
          showInternalDraft({
            planId: data.planId,
            version: data.version,
            status: data.status,
            previewMarkdown: data.execution?.plan
              ? `执行完成：${data.execution.plan.steps?.filter((s) => s.status === "completed").length ?? 0} 步`
              : "执行完成",
          });
        }
        addMessage("system", `计划已激活执行（${executionMode}，dryRun=${dryRun}）`);
        enableFrom(4);
      }
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  sectionCompile.querySelector(".plan-compile-btn")?.addEventListener("click", async () => {
    if (!state.userVisiblePlan?.id) {
      addSystemError("请先生成用户可见计划");
      return;
    }
    const selected = [...sectionReview.querySelectorAll(".plan-todo-check:checked")].map(
      (el) => el.value,
    );
    if (selected.length === 0) {
      addSystemError("请至少勾选一个 Todo");
      return;
    }
    const btn = sectionCompile.querySelector(".plan-compile-btn");
    btn.disabled = true;
    btn.textContent = "编译中…";
    try {
      const draft = await api(`/api/plans/${state.userVisiblePlan.id}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmedTodoIds: selected,
          sessionId: activeSessionId,
        }),
      });
      showInternalDraft(draft);
      addMessage("system", `内部计划草案 v${draft.version} 已生成（待审批）`);
    } catch (err) {
      addSystemError(String(err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = "编译选中 Todo";
    }
  });

  sectionCompile.querySelector(".plan-activate-dry-btn")?.addEventListener("click", () =>
    runPlanActivate({
      dryRun: true,
      autoApprove: true,
      executionMode: "static",
      label: "dry-run 激活",
      btnSelector: ".plan-activate-dry-btn",
    }),
  );

  sectionCompile.querySelector(".plan-activate-btn")?.addEventListener("click", () =>
    runPlanActivate({
      dryRun: false,
      autoApprove: false,
      executionMode: "agent_loop",
      label: "激活执行",
      btnSelector: ".plan-activate-btn",
    }),
  );

  addMessage("system", panel);
  messageInput.focus();
}

const STATUS_LABEL = {
  pending: "待执行",
  running: "执行中",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

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

async function handleUnifiedAgentStream(message) {
  const explicitMode = getExplicitRunMode();
  const thinkingLabel = explicitMode === "plan"
    ? "计划模式流式运行中…"
    : "自动工作流流式运行中…";
  const timelinePanel = createActivityTimelinePanel("准备中…");
  const panel = createAgentStreamPanel(thinkingLabel);
  const wrapper = document.createElement("div");
  wrapper.className = "agent-stream-wrapper";
  wrapper.appendChild(timelinePanel.card);
  wrapper.appendChild(panel.card);
  panel.showTokens(streamTokensInput?.checked);
  const msgWrap = addMessage("assistant", wrapper, "流式运行中…", { scroll: "start" });

  const payload = {
    message,
    clientName: modelSelect.value,
    sessionId: activeSessionId,
    system: systemInput.value,
    sensitive: sensitiveInput.checked,
    permissionPolicy: getSelectedPermissionPolicy(),
    streamTokens: streamTokensInput?.checked === true,
  };
  if (explicitMode) {
    payload.mode = explicitMode;
    payload.forceMode = true; // 测试台显式模式仅用于定向测试
  }

  let doneResult = null;
  const streamAbort = new AbortController();
  panel.onCancel(() => streamAbort.abort());
  try {
  await consumeSsePost("/api/agent/stream", payload, (evt) => {
    const data = evt.data || {};
    if (evt.type === "run_start") {
      panel.setRunId(data.runId);
      panel.setStatus(`运行中 · runId=${data.runId || "?"}`);
    } else if (evt.type === "model_turn" && data.turn) {
      panel.addModelTurn(data.turn);
    } else if (evt.type === "step" && data.step) {
      panel.addStep(data.step);
    } else if (evt.type === "token") {
      panel.appendToken(data.delta, data.iteration);
    } else if (evt.type === "activity_event" && data.event) {
      timelinePanel.handleEvent(data.event);
    } else if (evt.type === "done") {
      doneResult = data;
    } else if (evt.type === "error") {
      throw new Error(data.error || "Agent 流式执行失败");
    }
  }, streamAbort.signal);

  if (!doneResult) throw new Error("流式响应未收到 done 事件");
  if (doneResult.sessionId) {
    setActiveSessionId(doneResult.sessionId);
    void loadHistorySessions();
  }
  attachWorkflowBadgeToLastUserMessage(doneResult.executionMeta);
  timelinePanel.finalize(doneResult);
  const meta = panel.finalize(doneResult);
  const metaEl = msgWrap.querySelector(".msg-meta");
  if (metaEl) metaEl.textContent = meta + sessionMeta();
  maybeShowPermissionRequest(doneResult);
  } catch (err) {
    if (streamAbort.signal.aborted || String(err).includes("aborted")) {
      panel.setStatus("已取消");
      return;
    }
    throw err;
  }
}

async function handleUnifiedAgent(message) {
  addMessage("user", message);
  messageInput.value = "";
  autoGrow();
  sendBtn.disabled = true;
  const useStream = streamAgentInput?.checked !== false;
  try {
    if (useStream) {
      await handleUnifiedAgentStream(message);
      return;
    }
    const explicitMode = getExplicitRunMode();
    const thinkingLabel = explicitMode === "plan"
      ? "正在只读分析并生成计划报告…"
      : "自动工作流运行中（识别意图 / 按需调用工具）…";
    const thinking = addMessage("assistant", thinkingLabel);
    const payload = {
      message,
      clientName: modelSelect.value,
      sessionId: activeSessionId,
      system: systemInput.value,
      sensitive: sensitiveInput.checked,
      permissionPolicy: getSelectedPermissionPolicy(),
    };
    if (explicitMode) {
      payload.mode = explicitMode;
      payload.forceMode = true; // 测试台显式模式仅用于定向测试
    }
    const data = await api("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    thinking.remove();
    if (data.sessionId) {
      setActiveSessionId(data.sessionId);
      void loadHistorySessions();
    }
    attachWorkflowBadgeToLastUserMessage(data.executionMeta);
    renderAgentRun(data);
  } catch (err) {
    addSystemError(String(err.message || err));
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

async function handlePlanReport(message) {
  const prev = explicitModeSelect?.value;
  if (explicitModeSelect) explicitModeSelect.value = "plan";
  try {
    await handleUnifiedAgent(message);
  } finally {
    if (explicitModeSelect) explicitModeSelect.value = prev ?? "";
  }
}

async function handleAgent(message) {
  await handleUnifiedAgent(message);
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

function ensurePermissionRequestPanel() {
  let panel = document.getElementById("permission-request-panel");
  if (panel) return panel;
  panel = document.createElement("aside");
  panel.id = "permission-request-panel";
  panel.className = "permission-request-panel";
  panel.setAttribute("aria-live", "polite");
  document.body.appendChild(panel);
  return panel;
}

function groupPermissionItems(items) {
  const groups = { write_file: [], shell: [], other: [] };
  for (const item of items || []) {
    if (item.type === "write_file") groups.write_file.push(item);
    else if (item.type === "shell") groups.shell.push(item);
    else groups.other.push(item);
  }
  return groups;
}

function renderPermissionItemList(items) {
  if (!items.length) return "";
  return items
    .map(
      (item) => `<div class="perm-item">
        <div class="perm-item-target">${escapeHtml(item.target)}</div>
        <div class="perm-item-reason">${escapeHtml(item.reason || "")}</div>
      </div>`,
    )
    .join("");
}

async function respondPermissionRequest(request, decision) {
  const responded = await api(`/api/permission-requests/${encodeURIComponent(request.id)}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (decision === "deny") {
    hidePermissionRequestPanel();
    addMessage("system", `已拒绝权限申请：${escapeHtml(request.title || request.id)}`);
    return responded;
  }
  hidePermissionRequestPanel();
  addMessage("system", `已批准权限（${decision === "allow_session" ? "本次会话" : "仅一次"}），正在继续执行…`);
  try {
    const resume = await api(`/api/runs/${encodeURIComponent(request.runId)}/resume-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: request.runId,
        permissionRequestId: request.id,
        permissionPolicy: getSelectedPermissionPolicy(),
      }),
    });
    if (resume.sessionId) {
      setActiveSessionId(resume.sessionId);
      void loadHistorySessions();
    }
    renderAgentRun(resume);
    return responded;
  } catch (err) {
    addMessage("system", `续跑失败：${escapeHtml(String(err))}`);
    throw err;
  }
}

function showPermissionRequestPanel(request) {
  if (!request || request.status !== "pending") return;
  const panel = ensurePermissionRequestPanel();
  const groups = groupPermissionItems(request.requiredPermissions || []);
  panel.innerHTML = `
    <h3>${escapeHtml(request.title || "AI 需要权限继续执行")}</h3>
    <div class="perm-summary">${escapeHtml(request.summary || "")}</div>
    ${
      groups.write_file.length
        ? `<div class="perm-group"><div class="perm-group-title">文件修改</div>${renderPermissionItemList(groups.write_file)}</div>`
        : ""
    }
    ${
      groups.shell.length
        ? `<div class="perm-group"><div class="perm-group-title">命令执行</div>${renderPermissionItemList(groups.shell)}</div>`
        : ""
    }
    ${
      groups.other.length
        ? `<div class="perm-group"><div class="perm-group-title">其他权限</div>${renderPermissionItemList(groups.other)}</div>`
        : ""
    }
    <div class="perm-actions">
      <button type="button" class="btn-allow" data-decision="allow_once">允许</button>
      <button type="button" class="btn-session" data-decision="allow_session">本次会话都允许</button>
      <button type="button" class="btn-deny" data-decision="deny">拒绝</button>
    </div>`;
  panel.classList.add("visible");
  panel.querySelectorAll("[data-decision]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const decision = btn.getAttribute("data-decision");
      btn.disabled = true;
      try {
        await respondPermissionRequest(request, decision);
      } catch (err) {
        addSystemError(String(err.message || err));
      } finally {
        panel.querySelectorAll("button").forEach((b) => {
          b.disabled = false;
        });
      }
    });
  });
}

function hidePermissionRequestPanel() {
  const panel = document.getElementById("permission-request-panel");
  if (!panel) return;
  panel.classList.remove("visible");
  panel.innerHTML = "";
}

function maybeShowPermissionRequest(result) {
  if (result?.permissionRequest?.status === "pending") {
    showPermissionRequestPanel(result.permissionRequest);
  }
}

function renderAgentRun(result) {
  clearWelcome();
  const card = document.createElement("div");
  card.className = "plan-card";

  if (result.steps && result.steps.length) {
    const stepsWrap = document.createElement("div");
    stepsWrap.className = "plan-steps";
    result.steps.forEach((s) => {
      stepsWrap.appendChild(buildAgentStepRow(s));
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
    const workflowStatus = renderWorkflowStatus(m);
    const locationInfo = m.location
      ? `\nlocation=${m.location.usedLocateSteps ?? 0} steps · found=${(m.location.locatedFiles || []).slice(0, 4).join(",") || "-"} · continue=${m.location.needsContinue ? "yes" : "no"}`
      : "";
    metaBox.innerHTML = `${workflowStatus}<strong>执行元信息</strong><br>${escapeHtml(
      `mode=${m.mode}${m.modeSource ? `/${m.modeSource}` : ""} · intent=${m.intent ?? "-"} · workflow=${m.workflowType ?? "-"} · permissionPolicy=${m.permissionPolicy ?? "-"}${m.permissionPolicySource ? `/${m.permissionPolicySource}` : ""} · stop=${m.stopReason}${m.budgetExhausted ? `(${m.budgetExhausted})` : ""} · model=${u.modelTurns ?? m.usedModelTurns}/${b.maxModelTurns ?? "-"} · tools=${u.toolCalls ?? m.usedToolCalls}/${b.maxToolCalls ?? "-"} · read=${u.readCalls ?? m.usedReadCalls}/${b.maxReadCalls ?? "-"} · write=${u.writeCalls ?? m.usedWriteCalls}/${b.maxWriteCalls ?? "-"} · shell=${u.shellCalls ?? m.usedShellCalls}/${b.maxShellCalls ?? "-"} · runtime=${u.runtimeMs ?? 0}/${b.maxRuntimeMs ?? "-"}ms${
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
  const workflowLabel = metaInfo ? getWorkflowStatusLabel(metaInfo) : "";
  const meta = `模型轮次 ${result.iterations} · 工具请求 ${result.steps ? result.steps.length : 0} 次${metaInfo ? ` · ${workflowLabel || metaInfo.mode}/${metaInfo.stopReason}` : ""}${result.reachedLimit ? " · 已达预算" : ""}${sessionMeta()}`;
  addMessage("assistant", card, meta);
  maybeShowPermissionRequest(result);
}

function renderConfirmationRequest(request) {
  if (!request) return "";
  const affects = request.affects || {};
  const details = [
    affects.files && affects.files.length ? `文件：${affects.files.join(", ")}` : "",
    affects.commands && affects.commands.length ? `命令：${affects.commands.join(" && ")}` : "",
    affects.networkTargets && affects.networkTargets.length ? `网络：${affects.networkTargets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const status = request.status === "waiting_confirmation" ? "等待确认" : "已拒绝";
  const risk = request.risk ? `风险：${request.risk.tier} / ${request.risk.summary}` : "";
  return `<div class="confirmation-request">
    <div><strong>${escapeHtml(status)}：${escapeHtml(request.title || request.action || request.tool)}</strong></div>
    <div>${escapeHtml(request.message || "")}</div>
    ${details ? `<div>${escapeHtml(details)}</div>` : ""}
    ${risk ? `<div>${escapeHtml(risk)}</div>` : ""}
  </div>`;
}

function getWorkflowStatusLabel(meta) {
  if (meta.workflowSwitch?.switched) {
    const from = meta.workflowSwitch.fromWorkflowType || meta.workflowSwitch.fromIntent;
    const to = meta.workflowSwitch.toWorkflowType || meta.workflowSwitch.toIntent;
    return `已切换：${from} → ${to}`;
  }
  if (meta.workflowTaskState && TASK_STATE_LABELS[meta.workflowTaskState]) {
    return TASK_STATE_LABELS[meta.workflowTaskState];
  }
  return WORKFLOW_STATUS_LABELS[meta.workflowType] || meta.workflowType || meta.intent || meta.mode || "";
}

function renderWorkflowStatus(meta) {
  if (!meta) return "";
  const label = getWorkflowStatusLabel(meta);
  if (!label) return "";
  const details = [
    meta.workflowSwitch?.switched
      ? `工作流切换：${meta.workflowSwitch.fromWorkflowType} → ${meta.workflowSwitch.toWorkflowType}`
      : "",
    meta.workflowTaskState ? `任务状态：${TASK_STATE_LABELS[meta.workflowTaskState] || meta.workflowTaskState}` : "",
    meta.intent ? `意图：${INTENT_STATUS_LABELS[meta.intent] || meta.intent}` : "",
    meta.executionStage ? `阶段：${EXECUTION_STAGE_LABELS[meta.executionStage] || meta.executionStage}` : "",
    meta.permissionPolicy ? `权限：${meta.permissionPolicy}` : "",
    meta.mode ? `模式：${meta.mode}` : "",
    meta.modeSource ? `来源：${meta.modeSource === "explicit" ? "显式" : "自动"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="workflow-status"><span class="status status-running">${escapeHtml(label)}</span>${
    details ? `<span class="workflow-status-detail">${escapeHtml(details)}</span>` : ""
  }</div>`;
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
            `<div class="plan-step-desc">[${escapeHtml(n.source)}/${escapeHtml(n.level)}] ${escapeHtml(formatDateTime(n.timestamp))} — ${escapeHtml(n.message)}${n.consumed ? " (已消费)" : ""}</div>`,
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
            `<div class="plan-step-desc">${escapeHtml(formatDateTime(n.timestamp))} — ${escapeHtml(n.message)}${n.payload?.requiresConfirmation === false ? " <em>(无人值守)</em>" : ""}</div>`,
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
              `<div class="plan-step-desc"><strong>${escapeHtml(t.name)}</strong> [${escapeHtml(t.kind)}/${escapeHtml(t.status)}] · 触发 ${t.fireCount} 次${t.at ? ` · ${escapeHtml(formatDateTime(t.at))}` : ""}${t.lastFiredAt ? ` · 上次 ${escapeHtml(formatDateTime(t.lastFiredAt))}` : ""} · ${escapeHtml(t.goal)}</div>`,
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
      addMessage("system", `已注册一次性触发器，将于 ${formatDateTime(at)} 写入通知。`);
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
      const session = await createNewSession();
      if (!session) return;
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

  const panel = document.createElement("div");
  panel.className = "tool-panel";

  const modeRow = document.createElement("div");
  modeRow.className = "tool-row";
  const modeSelect = document.createElement("select");
  modeSelect.innerHTML = `
    <option value="single">单个子任务</option>
    <option value="batch">并行多个子任务</option>`;
  modeRow.appendChild(modeSelect);
  panel.appendChild(modeRow);

  const goalInput = document.createElement("textarea");
  goalInput.className = "tool-input";
  goalInput.style.minHeight = "60px";
  goalInput.placeholder = "子任务目标 goal，例如：审查 src/agent/AgentLoop.ts 的错误处理";
  panel.appendChild(goalInput);

  const instructionsInput = document.createElement("textarea");
  instructionsInput.className = "tool-input";
  instructionsInput.style.minHeight = "50px";
  instructionsInput.placeholder = "执行说明 instructions（可选，默认同 goal）";
  panel.appendChild(instructionsInput);

  const batchGoalsInput = document.createElement("textarea");
  batchGoalsInput.className = "tool-input";
  batchGoalsInput.style.minHeight = "80px";
  batchGoalsInput.placeholder = "并行模式：每行一个子任务 goal";
  batchGoalsInput.style.display = "none";
  panel.appendChild(batchGoalsInput);

  const writeRow = document.createElement("label");
  writeRow.className = "field sensitive-field";
  writeRow.style.fontSize = "13px";
  const writeCb = document.createElement("input");
  writeCb.type = "checkbox";
  writeRow.appendChild(writeCb);
  writeRow.appendChild(document.createTextNode(" 允许写文件（须服务端 grantedPermissions 含 write）"));
  panel.appendChild(writeRow);

  const runBtn = document.createElement("button");
  runBtn.className = "action-btn";
  runBtn.style.marginTop = "10px";
  runBtn.textContent = "运行子 Agent";
  panel.appendChild(runBtn);

  const result = document.createElement("div");
  result.className = "tool-result";
  result.style.display = "none";
  panel.appendChild(result);

  modeSelect.addEventListener("change", () => {
    const batch = modeSelect.value === "batch";
    goalInput.style.display = batch ? "none" : "block";
    instructionsInput.style.display = batch ? "none" : "block";
    batchGoalsInput.style.display = batch ? "block" : "none";
  });

  runBtn.addEventListener("click", async () => {
    const writeAllowed = writeCb.checked;
    runBtn.disabled = true;
    runBtn.textContent = "运行中…";
    result.style.display = "block";
    result.classList.remove("err");
    result.textContent = "子 Agent 执行中…";
    try {
      if (modeSelect.value === "batch") {
        const goals = batchGoalsInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!goals.length) throw new Error("请填写至少一个子任务 goal");
        const data = await api("/api/subagent/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tasks: goals.map((goal) => ({
              goal,
              instructions: goal,
              toolPolicy: { writeAllowed },
            })),
            sensitive: sensitiveInput.checked,
            timeoutMs: 180000,
          }),
        });
        result.textContent = `父任务 ${data.parentTaskId} · ${data.durationMs}ms\n\n${data.summary}`;
      } else {
        const goal = goalInput.value.trim();
        if (!goal) throw new Error("请填写 goal");
        const data = await api("/api/subagent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: {
              goal,
              instructions: instructionsInput.value.trim() || goal,
              toolPolicy: { writeAllowed },
            },
            sensitive: sensitiveInput.checked,
            timeoutMs: 180000,
          }),
        });
        const r = data.result;
        result.textContent = `[${r.goal}] ${r.status} · ${r.durationMs}ms\n\n${r.structured?.summary ?? r.answer}${r.error ? `\n\n错误：${r.error}` : ""}`;
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

async function handleSend() {
  const message = messageInput.value.trim();
  if (!message) return;
  if (!modelSelect.value) {
    addSystemError("当前没有可用模型，请先启动本地模型或配置远程 key，再点「检测模型可用性」。");
    return;
  }

  persistPermissionPolicy();
  await handleUnifiedAgent(message);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
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
    await startNewChatSession();
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
  } else if (action === "storage") {
    await handleStorage();
  } else if (action === "scheduler") {
    await handleScheduler();
  } else if (action === "plan-workflow") {
    await handlePlanWorkflow();
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
  } else if (action === "session-menu-toggle") {
    e.stopPropagation();
    const sessionId = btn.dataset.sessionId;
    if (!sessionId) return;
    const pop = document.getElementById("session-menu-popover");
    const reopen =
      activeSessionMenu?.sessionId === sessionId && pop && !pop.hidden;
    if (reopen) {
      closeSessionMenu();
      return;
    }
    openSessionMenu(btn, sessionId, btn.dataset.sessionTitle || "");
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
  restorePermissionPolicy();
  permissionPolicySelect?.addEventListener("change", persistPermissionPolicy);
  bindAdvancedPanelPositioning();
  bindSessionMenuDismiss();
  await loadConfig();
  await renderHomeHistory();
  void refreshModels();
}

init();
