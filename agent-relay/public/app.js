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

let appConfig = null;

function clearWelcome() {
  const welcome = feed.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}

function addMessage(role, content, meta) {
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
  scrollToBottom();
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
    profileTag.textContent = `profile: ${cfg.profile}`;
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

async function handlePlan(goal) {
  addMessage("user", goal);
  messageInput.value = "";
  autoGrow();
  sendBtn.disabled = true;
  const thinking = addMessage("assistant", "正在生成计划…");
  try {
    const data = await api("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    thinking.remove();
    renderPlan(data.plan);
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
  list_files: '{\n  "path": "."\n}',
  search_text: '{\n  "query": "ModelRouter",\n  "dir": "src"\n}',
  write_file: '{\n  "path": "data/tool-demo.txt",\n  "content": "hello from tool"\n}',
  shell_run: '{\n  "command": "node -v"\n}',
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
        const ok = window.confirm(
          `工具「${res.tool}」属于高风险权限「${res.permission}」，确认执行？`,
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
        showResult(`[${res.code}] ${res.error}`, true);
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
      row.innerHTML = `
        <div class="plan-step-head">
          ${state}
          <span class="plan-step-title">#${s.iteration} ${escapeHtml(s.tool)}</span>
          ${dur}
        </div>
        ${thought}
        <div class="plan-step-desc">${io}</div>
        <div class="plan-step-desc">${out}</div>`;
      stepsWrap.appendChild(row);
    });
    card.appendChild(stepsWrap);
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

  const meta = `迭代 ${result.iterations} 步 · 工具调用 ${result.steps ? result.steps.length : 0} 次${result.reachedLimit ? " · 已达上限" : ""}`;
  addMessage("assistant", card, meta);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
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
        system: systemInput.value,
        sensitive: sensitiveInput.checked,
        autoConfirm: autoConfirmInput.checked,
      }),
    });
    thinking.remove();
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
    await handlePlan(message);
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
        system: systemInput.value,
        sensitive: sensitiveInput.checked,
        message,
      }),
    });
    thinking.remove();
    const usage = data.usage
      ? ` · token in=${data.usage.inputTokens ?? "?"}/out=${data.usage.outputTokens ?? "?"}`
      : "";
    const routed = data.routed ? "（路由自选）" : "";
    addMessage(
      "assistant",
      data.content || "(空响应)",
      `${data.clientName}${routed} · ${data.modelName}（${data.location}） · ${data.latencyMs}ms${usage}`,
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
    feed.innerHTML =
      '<div class="welcome"><h1>准备好了，随时开始</h1><p>左侧按钮可测试已实现功能；下方可直接与模型对话。</p></div>';
  } else if (action === "view-config") {
    const cfg = await loadConfig();
    if (cfg) renderConfigCard(cfg);
  } else if (action === "check-models") {
    await handleCheckModels();
  } else if (action === "metrics") {
    await handleMetrics();
  } else if (action === "tools") {
    await handleTools();
  } else if (action === "refresh-models") {
    const rows = await refreshModels();
    if (rows) {
      const n = rows.filter((r) => r.available).length;
      addMessage("system", `已刷新：${n}/${rows.length} 个模型可用，下拉框仅显示可用模型。`);
    }
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
  await refreshModels();
}

init();
