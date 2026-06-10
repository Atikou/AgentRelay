/** 测试台用例运行器：按里程碑分功能页，含测试目的与 AI 可复制格式。 */

/** 各功能页可用的手动验证 API 预设（与里程碑功能对齐）。 */
const MANUAL_APIS_BY_FEATURE = {
  "m0-config": [
    { label: "GET /api/config", method: "GET", path: "/api/config", sample: null },
  ],
  "m1-tools": [
    { label: "GET /api/tools", method: "GET", path: "/api/tools", sample: null },
    {
      label: "POST /api/tools/run · read_file",
      method: "POST",
      path: "/api/tools/run",
      sample: { name: "read_file", input: { path: "package.json" } },
    },
    {
      label: "POST /api/tools/run · shell_run",
      method: "POST",
      path: "/api/tools/run",
      sample: { name: "shell_run", input: { command: "node -v" }, confirm: true },
    },
    {
      label: "POST /api/tools/run · list_files",
      method: "POST",
      path: "/api/tools/run",
      sample: { name: "list_files", input: { path: "." } },
    },
  ],
  "m1-agent": [
    {
      label: "POST /api/agent",
      method: "POST",
      path: "/api/agent",
      sample: { message: "列出工作区根目录有哪些文件", autoConfirm: false, maxIterations: 4 },
    },
    {
      label: "POST /api/chat",
      method: "POST",
      path: "/api/chat",
      sample: { message: "你好，请用一句话介绍你自己" },
    },
  ],
  "m2-routing": [
    { label: "GET /api/models/check", method: "GET", path: "/api/models/check", sample: null },
    { label: "GET /api/metrics", method: "GET", path: "/api/metrics", sample: null },
    {
      label: "POST /api/chat · 指定客户端",
      method: "POST",
      path: "/api/chat",
      sample: { clientName: "__default__", message: "ping", sensitive: false },
    },
  ],
  "m3-plan": [
    {
      label: "POST /api/plan",
      method: "POST",
      path: "/api/plan",
      sample: { goal: "为 agent-relay 增加一条单元测试", context: "仅生成计划，不执行" },
    },
  ],
  "m3-task": [
    {
      label: "POST /api/task/dry-run",
      method: "POST",
      path: "/api/task/dry-run",
      sample: { autoConfirm: false, plan: null },
    },
    {
      label: "POST /api/task/run",
      method: "POST",
      path: "/api/task/run",
      sample: { autoConfirm: false, plan: null },
    },
  ],
  "m4-background": [
    { label: "GET /api/background", method: "GET", path: "/api/background", sample: null },
    {
      label: "POST /api/background/start",
      method: "POST",
      path: "/api/background/start",
      sample: { command: "node -v" },
    },
  ],
  "m4-notifications": [
    { label: "GET /api/notifications?pending=1", method: "GET", path: "/api/notifications?pending=1", sample: null },
    { label: "GET /api/notifications（全部）", method: "GET", path: "/api/notifications", sample: null },
    { label: "POST /api/notifications/consume", method: "POST", path: "/api/notifications/consume", sample: {} },
  ],
  "m5-subagent": [
    { label: "GET /api/subagent/roles", method: "GET", path: "/api/subagent/roles", sample: null },
    {
      label: "POST /api/subagent/run",
      method: "POST",
      path: "/api/subagent/run",
      sample: {
        role: "code_review",
        task: "审查 src/agent/AgentLoop.ts 的错误处理",
        sensitive: false,
        maxIterations: 16,
        timeoutMs: 180000,
      },
    },
    {
      label: "POST /api/subagent/batch",
      method: "POST",
      path: "/api/subagent/batch",
      sample: {
        roles: ["code_review", "test_analyze"],
        task: "分析 agent-relay 测试失败原因",
      },
    },
  ],
  "m6-context": [
    { label: "GET /api/context/sessions", method: "GET", path: "/api/context/sessions", sample: null },
    {
      label: "POST /api/context/sessions",
      method: "POST",
      path: "/api/context/sessions",
      sample: { title: "手动验证会话" },
    },
    {
      label: "POST /api/context/memories",
      method: "POST",
      path: "/api/context/memories",
      sample: {
        scope: "global",
        memoryType: "preference",
        key: "manual_lang",
        value: "偏好使用 TypeScript 开发 AgentRelay",
        summary: "TS 偏好",
        importance: 0.8,
      },
    },
    { label: "GET /api/context/memories", method: "GET", path: "/api/context/memories", sample: null },
    { label: "GET /api/context/search?q=TypeScript", method: "GET", path: "/api/context/search?q=TypeScript", sample: null },
  ],
  "m8-scheduler": [
    { label: "GET /api/scheduler/triggers", method: "GET", path: "/api/scheduler/triggers", sample: null },
    {
      label: "POST /api/scheduler/triggers · once",
      method: "POST",
      path: "/api/scheduler/triggers",
      sample: {
        name: "手动 once",
        kind: "once",
        goal: "验收调度",
        at: "2099-06-01T12:00:00.000Z",
      },
    },
    {
      label: "POST /api/scheduler/triggers · event",
      method: "POST",
      path: "/api/scheduler/triggers",
      sample: {
        name: "后台完成后续",
        kind: "event",
        goal: "后台任务完成后提醒",
        eventType: "background_completed",
        eventFilter: { status: "completed" },
      },
    },
    {
      label: "POST /api/scheduler/triggers · file_changed",
      method: "POST",
      path: "/api/scheduler/triggers",
      sample: {
        name: "配置变更",
        kind: "event",
        goal: "config 下 json 变更时提醒",
        eventType: "file_changed",
        eventFilter: { watchPath: "config", pattern: "*.json" },
      },
    },
  ],
  "m7-security": [
    { label: "GET /api/trace/recent", method: "GET", path: "/api/trace/recent?limit=10", sample: null },
    { label: "GET /api/trace/export", method: "GET", path: "/api/trace/export?limit=20", sample: null },
    { label: "GET /api/trace/replay", method: "GET", path: "/api/trace/replay?limit=30", sample: null },
    {
      label: "POST /api/tools/run · shell_run 危险命令",
      method: "POST",
      path: "/api/tools/run",
      sample: { name: "shell_run", input: { command: "rm -rf /" } },
    },
  ],
};

/** 调用模型时可传 clientName 的接口（与顶部模型选择器联动）。 */
const MODEL_AWARE_PATHS = new Set([
  "/api/chat",
  "/api/agent",
  "/api/plan",
  "/api/subagent/run",
  "/api/subagent/batch",
]);

let subAgentRolesCache = null;

async function getSubAgentRolesCached() {
  if (!subAgentRolesCache) {
    const res = await fetch("/api/subagent/roles");
    const data = await res.json();
    subAgentRolesCache = data.roles || [];
  }
  return subAgentRolesCache;
}

/** 测试台手动验证：为子 Agent 请求补全角色默认 maxIterations / timeoutMs。 */
async function enrichSubAgentInput(path, input) {
  if (!input || typeof input !== "object") return input;
  if (path !== "/api/subagent/run" && path !== "/api/subagent/batch") return input;
  const roles = await getSubAgentRolesCached();
  if (path === "/api/subagent/run" && input.role) {
    const role = roles.find((r) => r.id === input.role);
    if (!role) return input;
    return {
      ...input,
      maxIterations: input.maxIterations ?? role.defaultMaxIterations ?? 16,
      timeoutMs: input.timeoutMs ?? role.defaultTimeoutMs ?? 180000,
    };
  }
  if (path === "/api/subagent/batch" && Array.isArray(input.roles) && input.roles.length > 0) {
    const maxIterations =
      input.maxIterations ??
      Math.max(
        ...input.roles.map((id) => roles.find((r) => r.id === id)?.defaultMaxIterations ?? 10),
      );
    const timeoutMs =
      input.timeoutMs ??
      Math.max(...input.roles.map((id) => roles.find((r) => r.id === id)?.defaultTimeoutMs ?? 120000));
    return { ...input, maxIterations, timeoutMs };
  }
  return input;
}

function enrichModelInput(path, input, clientName) {
  if (!MODEL_AWARE_PATHS.has(path)) return input;
  if (!input || typeof input !== "object") return input;
  if (input.clientName != null) return input;
  if (!clientName || clientName === "__default__") return input;
  return { ...input, clientName };
}

async function loadTestModelOptions(selectEl) {
  const prev = selectEl.value;
  selectEl.innerHTML = '<option value="">检测模型…</option>';
  selectEl.disabled = true;
  try {
    const [rows, cfg] = await Promise.all([
      fetch("/api/models/check").then((r) => r.json()),
      fetch("/api/config").then((r) => r.json()),
    ]);
    const available = (rows || []).filter((r) => r.available);
    selectEl.innerHTML = "";
    if (available.length === 0) {
      selectEl.innerHTML = '<option value="">无可用模型</option>';
      return;
    }
    const defaultName = cfg?.defaultModel;
    if (defaultName && available.some((r) => r.name === defaultName)) {
      const auto = document.createElement("option");
      auto.value = "__default__";
      auto.textContent = `自动路由（默认：${defaultName}）`;
      selectEl.appendChild(auto);
    }
    for (const r of available) {
      const opt = document.createElement("option");
      opt.value = r.name;
      opt.textContent = `${r.name}（${r.location} / ${r.model}）`;
      selectEl.appendChild(opt);
    }
    selectEl.disabled = false;
    if (prev && [...selectEl.options].some((o) => o.value === prev)) {
      selectEl.value = prev;
    } else if (selectEl.querySelector('option[value="__default__"]')) {
      selectEl.value = "__default__";
    } else if (selectEl.options[0]) {
      selectEl.value = selectEl.options[0].value;
    }
  } catch {
    selectEl.innerHTML = '<option value="">模型检测失败</option>';
  }
}

async function fetchCase(path, method, input, clientName) {
  let body = input;
  if (method !== "GET" && body != null) {
    body = await enrichSubAgentInput(path, body);
    body = enrichModelInput(path, body, clientName);
  }
  const options = { method };
  if (method !== "GET" && body != null) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let responseBody;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = null;
  }
  return {
    status: res.status,
    body: responseBody,
    contentType: res.headers.get("content-type") ?? "",
  };
}

function getByPath(obj, dotPath) {
  return dotPath.split(".").reduce((acc, key) => {
    if (acc == null) return undefined;
    if (key === "length" && Array.isArray(acc)) return acc.length;
    return acc[key];
  }, obj);
}

function typeOfValue(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function deepPartialEqual(actual, expected) {
  if (expected === undefined) return true;
  if (typeof expected !== "object" || expected === null) {
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, i) => deepPartialEqual(actual[i], item));
  }
  return Object.keys(expected).every((k) => deepPartialEqual(actual?.[k], expected[k]));
}

function staleServerHint(actual, tc) {
  const path = tc?.path ?? "";
  if (actual.status !== 404 || actual.body?.error !== "未知接口") return null;
  if (path.startsWith("/api/trace/")) {
    return "后端未注册 trace 接口：请在 agent-relay 目录执行 npm run serve 重启测试台，再 Ctrl+F5 刷新页面。";
  }
  if (path.startsWith("/api/context/")) {
    return "后端未注册 context 接口：请重启 npm run serve 并刷新页面。";
  }
  if (path.startsWith("/api/scheduler/")) {
    return "后端未注册 scheduler 接口：请重启 npm run serve 并刷新页面。";
  }
  return null;
}

function evaluateExpect(actual, expect, tc) {
  const failures = [];
  const staleHint = staleServerHint(actual, tc);
  if (staleHint) failures.push(staleHint);
  if (expect.status != null && actual.status !== expect.status) {
    failures.push(`HTTP 状态：期望 ${expect.status}，实际 ${actual.status}`);
  }
  if (expect.contentTypeIncludes) {
    const ct = actual.contentType ?? "";
    if (!ct.includes(expect.contentTypeIncludes)) {
      failures.push(`Content-Type 应包含 ${expect.contentTypeIncludes}，实际 ${ct || "(空)"}`);
    }
  }
  const body = actual.body;
  if (expect.body != null && !deepPartialEqual(body, expect.body)) {
    failures.push("body 与期望 JSON 不完全匹配");
  }
  if (expect.bodyHasKeys) {
    for (const k of expect.bodyHasKeys) {
      if (body == null || !(k in body)) failures.push(`body 缺少字段：${k}`);
    }
  }
  if (expect.bodyType === "array" && !Array.isArray(body)) {
    failures.push("body 应为数组");
  }
  if (expect.itemHasKeys && Array.isArray(body)) {
    const item = body[0];
    if (!item) failures.push("数组为空，无法校验 itemHasKeys");
    else {
      for (const k of expect.itemHasKeys) {
        if (!(k in item)) failures.push(`数组项缺少字段：${k}`);
      }
    }
  }
  if (expect.bodyPaths) {
    for (const [p, want] of Object.entries(expect.bodyPaths)) {
      const got = getByPath(body, p);
      if (want === "string" && typeof got !== "string") failures.push(`${p} 应为 string，实际 ${typeOfValue(got)}`);
      else if (want === "array" && !Array.isArray(got)) failures.push(`${p} 应为 array`);
      else if (want === "number" && typeof got !== "number") failures.push(`${p} 应为 number`);
      else if (want === "object" && (got === null || typeof got !== "object" || Array.isArray(got))) {
        failures.push(`${p} 应为 object`);
      }
      else if (typeof want !== "string" && got !== want) {
        failures.push(`${p}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
      }
    }
  }
  if (expect.bodyContainsNames && body?.tools) {
    const names = body.tools.map((t) => t.name);
    for (const n of expect.bodyContainsNames) {
      if (!names.includes(n)) failures.push(`tools 缺少：${n}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

function formatJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function describeExpect(expect) {
  if (!expect || typeof expect !== "object") return "（无）";
  const lines = [];
  if (expect.status != null) lines.push(`- status: HTTP ${expect.status}`);
  if (expect.body != null) lines.push(`- body: 深度部分匹配 ${formatJson(expect.body)}`);
  if (expect.bodyHasKeys) lines.push(`- bodyHasKeys: ${expect.bodyHasKeys.join(", ")}`);
  if (expect.bodyPaths) {
    for (const [k, v] of Object.entries(expect.bodyPaths)) {
      lines.push(`- bodyPaths.${k}: ${JSON.stringify(v)}`);
    }
  }
  if (expect.bodyType) lines.push(`- bodyType: ${expect.bodyType}`);
  if (expect.itemHasKeys) lines.push(`- itemHasKeys: ${expect.itemHasKeys.join(", ")}`);
  if (expect.bodyContainsNames) lines.push(`- bodyContainsNames: ${expect.bodyContainsNames.join(", ")}`);
  return lines.length ? lines.join("\n") : "（见 expect JSON）";
}

/** 单条用例 — 供粘贴给 AI 维护 test-cases。 */
function buildCaseCopyText(featurePage, tc) {
  return [
    "<!-- AgentRelay 网页测试用例 · 单条 · 粘贴给 AI -->",
    "",
    "## 维护说明",
    "- 格式规范: agent-relay/public/test-cases/SCHEMA.md",
    `- 所属功能页: ${featurePage.milestone} ${featurePage.feature}`,
    `- 文件路径: agent-relay/public/test-cases/${featurePage._file}`,
    `- 功能页 featureId: ${featurePage.featureId}`,
    "",
    "## 测试目的 (purpose)",
    tc.purpose || "（请补充 purpose）",
    "",
    "## 用例 JSON（追加到该文件 cases 数组，或替换同 id 项）",
    "```json",
    formatJson({
      id: tc.id,
      title: tc.title,
      purpose: tc.purpose,
      method: tc.method,
      path: tc.path,
      input: tc.input,
      expect: tc.expect,
    }),
    "```",
    "",
    "## expect 断言说明",
    describeExpect(tc.expect),
    "",
    "## 必填字段提醒",
    "- id, title, purpose, method, path, input, expect",
    "- purpose 必须写清「验证什么行为、为何需要此用例」",
  ].join("\n");
}

/** 整页功能用例 — 供 AI 新建/重构功能页。 */
function buildPageCopyText(featureMeta, featurePage) {
  const pageBody = {
    milestone: featurePage.milestone,
    feature: featurePage.feature,
    featureId: featurePage.featureId,
    summary: featurePage.summary,
    cases: featurePage.cases.map((tc) => ({
      id: tc.id,
      title: tc.title,
      purpose: tc.purpose,
      method: tc.method,
      path: tc.path,
      input: tc.input,
      expect: tc.expect,
    })),
  };
  return [
    "<!-- AgentRelay 网页测试用例 · 整页 · 粘贴给 AI -->",
    "",
    "## 维护说明",
    "- 格式规范: agent-relay/public/test-cases/SCHEMA.md",
    `- 里程碑: ${featurePage.milestone}`,
    `- 功能: ${featurePage.feature}`,
    `- 文件: agent-relay/public/test-cases/${featureMeta.file}`,
    "",
    "## index.json 登记项（若新建功能页）",
    "```json",
    formatJson({
      featureId: featureMeta.featureId,
      milestone: featureMeta.milestone,
      title: featureMeta.title,
      file: featureMeta.file,
      order: featureMeta.order,
    }),
    "```",
    "",
    "## 功能页验收摘要 (summary)",
    featurePage.summary || "",
    "",
    "## 完整功能页 JSON",
    "```json",
    formatJson(pageBody),
    "```",
    "",
    "## 每条用例须有 purpose",
    "cases[].purpose 描述测试目的，供网页展示与 AI 理解验收标准。",
  ].join("\n");
}

async function copyText(text, toastEl) {
  try {
    await navigator.clipboard.writeText(text);
    if (toastEl) {
      toastEl.textContent = "已复制到剪贴板";
      toastEl.classList.add("show");
      setTimeout(() => toastEl.classList.remove("show"), 2000);
    }
  } catch {
    if (toastEl) {
      toastEl.textContent = "复制失败，请手动选择";
      toastEl.classList.add("show", "fail");
      setTimeout(() => toastEl.classList.remove("show", "fail"), 2500);
    }
  }
}

async function loadFeaturePage(meta) {
  const res = await fetch(`/test-cases/${meta.file}`);
  if (!res.ok) throw new Error(`加载 ${meta.file} 失败`);
  const page = await res.json();
  page._file = meta.file;
  return page;
}

async function openTestCasesPanel(deps, initialFeatureId) {
  const { feed, clearWelcome, addMessage, escapeHtml } = deps;
  clearWelcome();

  let index;
  try {
    index = await fetch("/test-cases/index.json").then((r) => r.json());
  } catch (err) {
    addMessage("system", `加载 test-cases/index.json 失败：${err.message || err}`);
    return;
  }

  const features = [...(index.features || [])].sort((a, b) => a.order - b.order);
  const pageCache = new Map();
  let manualFillRef = null;

  const panel = document.createElement("div");
  panel.className = "test-panel";

  const toast = document.createElement("div");
  toast.className = "test-copy-toast";
  panel.appendChild(toast);

  const tabBar = document.createElement("div");
  tabBar.className = "test-feature-tabs";
  panel.appendChild(tabBar);

  const modelBar = document.createElement("div");
  modelBar.className = "test-model-bar";
  const modelLabel = document.createElement("label");
  modelLabel.className = "test-model-label";
  modelLabel.textContent = "模型";
  const modelSelect = document.createElement("select");
  modelSelect.className = "test-model-select";
  modelSelect.title = "调用 /api/chat、/api/agent、/api/plan、子 Agent 时使用；仅列出当前可用模型";
  const modelRefreshBtn = document.createElement("button");
  modelRefreshBtn.type = "button";
  modelRefreshBtn.className = "action-btn secondary";
  modelRefreshBtn.textContent = "刷新模型";
  modelRefreshBtn.addEventListener("click", () => {
    void loadTestModelOptions(modelSelect);
  });
  modelBar.appendChild(modelLabel);
  modelBar.appendChild(modelSelect);
  modelBar.appendChild(modelRefreshBtn);
  const modelHint = document.createElement("span");
  modelHint.className = "test-model-hint";
  modelHint.textContent = "需模型的用例会使用此处选择；输入 JSON 里已有 clientName 时优先用 JSON";
  modelBar.appendChild(modelHint);
  panel.appendChild(modelBar);
  void loadTestModelOptions(modelSelect);

  const getClientName = () => modelSelect.value || "__default__";

  const pageHost = document.createElement("div");
  pageHost.className = "test-feature-page";
  panel.appendChild(pageHost);

  const resultArea = document.createElement("div");
  resultArea.className = "test-result-area is-empty";

  function showResult(title, actual, tc, verdict) {
    resultArea.classList.remove("is-empty");
    resultArea.innerHTML = "";
    const badge = document.createElement("div");
    if (verdict.pass === null) {
      badge.className = "test-verdict manual";
      badge.textContent = "手动验证 · 仅展示实际输出";
    } else {
      badge.className = `test-verdict ${verdict.pass ? "pass" : "fail"}`;
      badge.textContent = verdict.pass ? "通过" : "未通过";
    }
    resultArea.appendChild(badge);

    const titleEl = document.createElement("div");
    titleEl.className = "test-result-title";
    titleEl.textContent = title;
    resultArea.appendChild(titleEl);

    if (tc.purpose) {
      const p = document.createElement("div");
      p.className = "test-purpose-inline";
      p.innerHTML = `<strong>测试目的：</strong>${escapeHtml(tc.purpose)}`;
      resultArea.appendChild(p);
    }

    if (!verdict.pass && verdict.failures.length) {
      const fail = document.createElement("div");
      fail.className = "test-failures";
      fail.innerHTML = verdict.failures.map((f) => `• ${escapeHtml(f)}`).join("<br>");
      resultArea.appendChild(fail);
    }

    const grid = document.createElement("div");
    grid.className = "test-compare-grid";
    grid.innerHTML = `
      <div class="test-compare-col"><div class="test-col-label">输入</div><pre class="test-pre">${escapeHtml(formatJson(tc.input ?? null))}</pre></div>
      <div class="test-compare-col"><div class="test-col-label">期望</div><pre class="test-pre">${escapeHtml(formatJson(tc.expect))}</pre></div>
      <div class="test-compare-col"><div class="test-col-label">实际 (HTTP ${actual.status})</div><pre class="test-pre">${escapeHtml(formatJson(actual.body))}</pre></div>`;
    resultArea.appendChild(grid);
    resultArea.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function runOne(tc, rowBtn) {
    if (rowBtn) {
      rowBtn.disabled = true;
      rowBtn.textContent = "…";
    }
    const actual = await fetchCase(tc.path, tc.method, tc.input, getClientName());
    const verdict = evaluateExpect(actual, tc.expect, tc);
    if (rowBtn) {
      rowBtn.disabled = false;
      rowBtn.textContent = "运行";
      rowBtn.classList.toggle("last-fail", !verdict.pass);
      rowBtn.classList.toggle("last-pass", verdict.pass);
    }
    showResult(tc.title, actual, tc, verdict);
    return verdict.pass;
  }

  async function renderFeaturePage(meta) {
    let featurePage = pageCache.get(meta.featureId);
    if (!featurePage) {
      featurePage = await loadFeaturePage(meta);
      pageCache.set(meta.featureId, featurePage);
    }

    if (resultArea.parentNode) {
      resultArea.parentNode.removeChild(resultArea);
    }
    resultArea.classList.add("is-empty");
    resultArea.innerHTML = "";
    pageHost.innerHTML = "";

    const head = document.createElement("div");
    head.className = "test-page-head";

    const headText = document.createElement("div");
    headText.className = "test-page-head-text";
    headText.innerHTML = `
      <div class="test-page-title-row">
        <span class="test-milestone-badge">${escapeHtml(meta.milestone)}</span>
        <strong class="test-page-title">${escapeHtml(meta.title)}</strong>
      </div>
      <p class="test-page-summary">${escapeHtml(featurePage.summary || "")}</p>`;
    head.appendChild(headText);

    if (meta.featureId === "m7-security") {
      try {
        const cfg = await fetch("/api/config").then((r) => r.json());
        if (!cfg.capabilities?.traceAudit) {
          const warn = document.createElement("p");
          warn.className = "test-stale-server-hint";
          warn.textContent =
            "当前后端未暴露 trace 审计能力（capabilities.traceAudit）。请在 agent-relay 目录重启 npm run serve，再 Ctrl+F5 刷新。";
          headText.appendChild(warn);
        }
      } catch {
        /* 忽略探测失败 */
      }
    }

    const headActions = document.createElement("div");
    headActions.className = "test-page-actions";
    const copyPageBtn = document.createElement("button");
    copyPageBtn.className = "action-btn secondary";
    copyPageBtn.textContent = "复制本页全部用例";
    copyPageBtn.addEventListener("click", () => {
      void copyText(buildPageCopyText(meta, featurePage), toast);
    });
    const runAllBtn = document.createElement("button");
    runAllBtn.className = "action-btn";
    runAllBtn.textContent = "运行本页全部";
    runAllBtn.addEventListener("click", async () => {
      runAllBtn.disabled = true;
      let pass = 0;
      let fail = 0;
      for (const tc of featurePage.cases) {
        if (await runOne(tc, null)) pass += 1;
        else fail += 1;
      }
      runAllBtn.disabled = false;
      const summary = document.createElement("div");
      summary.className = `test-verdict ${fail === 0 ? "pass" : "fail"}`;
      summary.textContent = `${meta.title}：${pass} 通过，${fail} 未通过`;
      resultArea.prepend(summary);
    });
    headActions.appendChild(copyPageBtn);
    headActions.appendChild(runAllBtn);
    head.appendChild(headActions);
    pageHost.appendChild(head);

    const list = document.createElement("div");
    list.className = "test-case-list open";

    for (const tc of featurePage.cases) {
      const row = document.createElement("div");
      row.className = "test-case-card";

      const metaBlock = document.createElement("div");
      metaBlock.className = "test-case-meta";
      metaBlock.innerHTML = `
        <span class="test-case-title">${escapeHtml(tc.title)}</span>
        <span class="test-case-id">${escapeHtml(tc.id)} · ${escapeHtml(tc.method)} ${escapeHtml(tc.path)}</span>
        <p class="test-case-purpose"><strong>测试目的：</strong>${escapeHtml(tc.purpose || "")}</p>`;

      const btnRow = document.createElement("div");
      btnRow.className = "test-case-btns";
      const runBtn = document.createElement("button");
      runBtn.className = "action-btn secondary";
      runBtn.textContent = "运行";
      runBtn.addEventListener("click", () => runOne(tc, runBtn));
      const copyBtn = document.createElement("button");
      copyBtn.className = "action-btn secondary";
      copyBtn.textContent = "复制用例";
      copyBtn.addEventListener("click", () => {
        void copyText(buildCaseCopyText(featurePage, tc), toast);
      });
      const editBtn = document.createElement("button");
      editBtn.className = "action-btn secondary";
      editBtn.textContent = "填入手动验证";
      editBtn.addEventListener("click", () => {
        if (manualFillRef) {
          manualFillRef({
            method: tc.method,
            path: tc.path,
            input: tc.input,
            expect: tc.expect,
            purpose: tc.purpose,
          });
        }
      });
      btnRow.appendChild(runBtn);
      btnRow.appendChild(editBtn);
      btnRow.appendChild(copyBtn);

      row.appendChild(metaBlock);
      row.appendChild(btnRow);
      list.appendChild(row);
    }

    pageHost.appendChild(list);
    pageHost.appendChild(resultArea);

    manualFillRef = renderManualSection(pageHost, meta, featurePage, getClientName);
  }

  function renderManualSection(host, meta, featurePage, getClientName) {
    const presets = MANUAL_APIS_BY_FEATURE[meta.featureId] || [];

    const custom = document.createElement("div");
    custom.className = "test-custom";
    custom.id = `manual-${meta.featureId}`;
    custom.innerHTML = `<div class="test-category">手动输入验证</div>
      <p class="test-manual-hint">自选接口或自定义路径，编辑输入与期望后点击「运行」；需模型的接口使用面板上方「模型」下拉框（仅可用模型）；未填期望时仅展示实际输出。</p>`;

    const customRow = document.createElement("div");
    customRow.className = "tool-row";
    const apiSelect = document.createElement("select");
    apiSelect.className = "test-api-select";

    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "自定义 method + path";
    apiSelect.appendChild(customOpt);

    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ method: p.method, path: p.path });
      opt.textContent = p.label;
      opt.dataset.sample = p.sample != null ? JSON.stringify(p.sample, null, 2) : "";
      opt.dataset.method = p.method;
      opt.dataset.path = p.path;
      apiSelect.appendChild(opt);
    }
    customRow.appendChild(apiSelect);
    custom.appendChild(customRow);

    const customPathRow = document.createElement("div");
    customPathRow.className = "test-manual-path-row";
    customPathRow.style.display = "none";
    const methodSelect = document.createElement("select");
    methodSelect.innerHTML = '<option value="GET">GET</option><option value="POST">POST</option>';
    const pathInput = document.createElement("input");
    pathInput.className = "system-input";
    pathInput.placeholder = "/api/你的路径";
    pathInput.style.flex = "1";
    customPathRow.appendChild(methodSelect);
    customPathRow.appendChild(pathInput);
    custom.appendChild(customPathRow);

    const purposeInput = document.createElement("input");
    purposeInput.className = "system-input test-manual-purpose";
    purposeInput.placeholder = "测试目的（可选，用于记录/复制为正式用例）";
    custom.appendChild(purposeInput);

    const customGrid = document.createElement("div");
    customGrid.className = "test-custom-grid";
    const inputTa = document.createElement("textarea");
    inputTa.className = "tool-input";
    inputTa.placeholder = '请求 body JSON；GET 无 body 请留空或写 {}';
    const expectTa = document.createElement("textarea");
    expectTa.className = "tool-input";
    expectTa.placeholder = '期望 expect JSON（可选），如 {"status":200,"bodyPaths":{"ok":true}}';
    const inWrap = document.createElement("div");
    inWrap.innerHTML = '<div class="test-col-label">输入</div>';
    inWrap.appendChild(inputTa);
    const exWrap = document.createElement("div");
    exWrap.innerHTML = '<div class="test-col-label">期望输出（可选）</div>';
    exWrap.appendChild(expectTa);
    customGrid.appendChild(inWrap);
    customGrid.appendChild(exWrap);
    custom.appendChild(customGrid);

    const btnRow = document.createElement("div");
    btnRow.className = "test-case-btns";
    const customRun = document.createElement("button");
    customRun.className = "action-btn";
    customRun.textContent = "运行手动验证";
    const customCopy = document.createElement("button");
    customCopy.className = "action-btn secondary";
    customCopy.textContent = "复制为正式用例";
    btnRow.appendChild(customRun);
    btnRow.appendChild(customCopy);
    custom.appendChild(btnRow);

    function readApiDef() {
      if (apiSelect.value === "__custom__") {
        const path = pathInput.value.trim();
        if (!path) throw new Error("请填写自定义 path");
        return { method: methodSelect.value, path };
      }
      return JSON.parse(apiSelect.value);
    }

    function applyPresetToInputs() {
      if (apiSelect.value === "__custom__") {
        customPathRow.style.display = "flex";
        return;
      }
      customPathRow.style.display = "none";
      const opt = apiSelect.selectedOptions[0];
      const sample = opt?.dataset.sample ?? "";
      inputTa.value = sample;
      if (opt?.dataset.method === "GET") inputTa.value = "";
    }

    apiSelect.addEventListener("change", applyPresetToInputs);
    if (presets[0]) {
      apiSelect.selectedIndex = 1;
      applyPresetToInputs();
    }

    function parseInputBody(method, raw) {
      const trimmed = (raw ?? "").trim();
      if (method === "GET" || !trimmed || trimmed === "{}") return null;
      return JSON.parse(trimmed);
    }

    async function runManual() {
      let apiDef;
      let input;
      let expectDef = null;
      try {
        apiDef = readApiDef();
        input = parseInputBody(apiDef.method, inputTa.value);
        const expRaw = expectTa.value.trim();
        if (expRaw) expectDef = JSON.parse(expRaw);
      } catch (e) {
        showResult(
          "手动验证",
          { status: 0, body: { error: String(e.message || e) } },
          { purpose: purposeInput.value, input: null, expect: {} },
          { pass: false, failures: ["JSON 或路径解析失败"] },
        );
        return;
      }
      customRun.disabled = true;
      customRun.textContent = "运行中…";
      const clientName = getClientName();
      const mergedInput =
        input && MODEL_AWARE_PATHS.has(apiDef.path)
          ? enrichModelInput(apiDef.path, input, clientName)
          : input;
      const actual = await fetchCase(apiDef.path, apiDef.method, input, clientName);
      const hasExpect = expectDef && Object.keys(expectDef).length > 0;
      const verdict = hasExpect
        ? evaluateExpect(actual, expectDef, { path: apiDef.path })
        : { pass: null, failures: [] };
      customRun.disabled = false;
      customRun.textContent = "运行手动验证";
      const modelNote =
        MODEL_AWARE_PATHS.has(apiDef.path) && clientName && clientName !== "__default__"
          ? ` · 模型 ${clientName}`
          : MODEL_AWARE_PATHS.has(apiDef.path)
            ? " · 自动路由"
            : "";
      showResult(
        `手动 · ${apiDef.method} ${apiDef.path}${modelNote}`,
        actual,
        { purpose: purposeInput.value, input: mergedInput ?? input, expect: expectDef ?? {} },
        verdict,
      );
    }

    customRun.addEventListener("click", () => void runManual());

    customCopy.addEventListener("click", () => {
      try {
        const apiDef = readApiDef();
        const input = parseInputBody(apiDef.method, inputTa.value);
        const expectDef = expectTa.value.trim() ? JSON.parse(expectTa.value) : {};
        const draft = {
          id: `${meta.featureId}-custom-rename`,
          title: "请填写标题",
          purpose: purposeInput.value.trim() || "请填写测试目的",
          method: apiDef.method,
          path: apiDef.path,
          input,
          expect: expectDef,
        };
        void copyText(buildCaseCopyText(featurePage, draft), toast);
      } catch (e) {
        toast.textContent = `JSON 无效：${e.message}`;
        toast.classList.add("show", "fail");
        setTimeout(() => toast.classList.remove("show", "fail"), 2500);
      }
    });

    host.appendChild(custom);

    return function fillFromCase(data) {
      custom.scrollIntoView({ behavior: "smooth", block: "nearest" });
      let matched = false;
      for (const opt of apiSelect.options) {
        if (opt.value === "__custom__") continue;
        try {
          const def = JSON.parse(opt.value);
          if (def.method === data.method && def.path === data.path) {
            apiSelect.value = opt.value;
            matched = true;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (!matched) {
        apiSelect.value = "__custom__";
        customPathRow.style.display = "flex";
        methodSelect.value = data.method;
        pathInput.value = data.path;
      } else {
        applyPresetToInputs();
      }
      inputTa.value =
        data.input != null ? JSON.stringify(data.input, null, 2) : data.method === "GET" ? "" : "{}";
      expectTa.value = data.expect ? JSON.stringify(data.expect, null, 2) : "";
      if (data.purpose) purposeInput.value = data.purpose;
    };
  }

  let activeId = initialFeatureId || features[0]?.featureId;

  for (const meta of features) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "test-feature-tab";
    tab.dataset.featureId = meta.featureId;
    tab.textContent = `${meta.milestone} ${meta.title}`;
    tab.addEventListener("click", async () => {
      activeId = meta.featureId;
      tabBar.querySelectorAll(".test-feature-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.featureId === activeId);
      });
      await renderFeaturePage(meta);
    });
    if (meta.featureId === activeId) tab.classList.add("active");
    tabBar.appendChild(tab);
  }

  addMessage("system", panel, null, { scroll: "start" });

  const initial = features.find((f) => f.featureId === activeId) || features[0];
  if (initial) await renderFeaturePage(initial);
}

window.openTestCasesPanel = openTestCasesPanel;
