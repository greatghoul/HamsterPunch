// scripts-ui.js — 侧边栏主视图：签到脚本管理（列表 / 编辑 / 运行）
// 依赖 lib/db.js（HamsterDB）先加载。

const t = (key, fallback = "") => chrome.i18n.getMessage(key) || fallback;

const $ = (id) => document.getElementById(id);

const SCRIPT_TEMPLATE = [
  { name: "打开签到页（后台标签页）", action: "open", url: "http://localhost:8000/demo-site.html", active: false },
  { name: "等按钮出现", action: "waitForElement", selector: "#signin-btn", timeout: 8000 },
  { name: "填昵称", action: "input", selector: "#nickname", value: "仓鼠" },
  { name: "提交昵称", action: "press", key: "Enter", selector: "#nickname" },
  { name: "点击签到", action: "click", selector: "#signin-btn" },
  { name: "等结果", action: "wait", ms: 2000 },
  { name: "确认成功", action: "assert", selector: ".success-msg", textContains: "已签到" },
  { name: "关闭标签页", action: "close" },
];

const ACTIONS = [
  "open",
  "waitForElement",
  "wait",
  "click",
  "input",
  "press",
  "scroll",
  "assert",
  "extract",
  "close",
];

const MAX_STEPS = 100;
const MAX_WAIT_MS = 300000;

const ui = {
  editingId: null,
  runningRecord: null,
  port: null,
  stepResults: [],
  finished: true,
};

// ---------- JSON 校验 ----------

/** 逐步骤校验并归一化；不合法时抛错（错误信息带"第 N 步"前缀） */
function validateSteps(raw) {
  const fail = (index, reason) => {
    throw new Error(
      chrome.i18n.getMessage("stepError", [String(index + 1), reason]) ||
        `#${index + 1}: ${reason}`
    );
  };
  const msg = (key, fallback) => t(key, fallback);

  if (!Array.isArray(raw)) throw new Error(msg("errNotArray", "脚本必须是一个步骤数组"));
  if (raw.length === 0) throw new Error(msg("errEmpty", "脚本至少需要一个步骤"));
  if (raw.length > MAX_STEPS) throw new Error(msg("errTooMany", `步骤数量超过上限（${MAX_STEPS}）`));

  return raw.map((step, index) => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      fail(index, msg("errStepObject", "步骤必须是对象"));
    }
    if (!ACTIONS.includes(step.action)) {
      fail(index, chrome.i18n.getMessage("errUnknownAction", [String(step.action)]) || `未知动作 ${step.action}`);
    }

    const num = (value, min, max, field) => {
      if (value === undefined) fail(index, `${field}: ${msg("errMissing", "缺少参数")}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        fail(index, `${field}: ${msg("errNumRange", "数值超出允许范围")} (${min}–${max})`);
      }
      return value;
    };
    const str = (value) => (typeof value === "string" ? value : undefined);
    const bool = (value) => {
      if (value !== undefined && typeof value !== "boolean") fail(index, msg("errNotBoolean", "必须是 true/false"));
      return value;
    };

    const out = { action: step.action };
    const name = str(step.name);
    if (name !== undefined) {
      if (!name.trim()) fail(index, msg("errStepName", "name 不能为空字符串"));
      out.name = name.trim();
    }
    const optional = bool(step.optional);
    if (optional !== undefined) out.optional = optional;

    switch (step.action) {
      case "open": {
        const url = str(step.url);
        if (!url || !/^https?:\/\//i.test(url)) fail(index, msg("errUrlRequired", "url 必须是 http(s) 链接"));
        out.url = url;
        out.newTab = bool(step.newTab) !== false; // 默认打开新标签页
        if (out.newTab) out.active = bool(step.active) === true;
        out.loadTimeout = step.loadTimeout === undefined ? 20000 : num(step.loadTimeout, 1000, 60000, "loadTimeout");
        break;
      }
      case "close": {
        break;
      }
      case "waitForElement":
      case "click":
      case "input":
      case "assert": {
        const selector = str(step.selector);
        if (!selector) fail(index, msg("errSelectorRequired", "缺少 selector"));
        out.selector = selector;
        out.timeout =
          step.timeout === undefined
            ? step.action === "assert"
              ? 5000
              : 10000
            : num(step.timeout, 0, MAX_WAIT_MS, "timeout");
        if (step.action === "waitForElement") {
          out.interval = step.interval === undefined ? 500 : num(step.interval, 50, 5000, "interval");
        }
        if (step.action === "click") {
          out.index = step.index === undefined ? 0 : num(step.index, 0, 1000, "index");
        }
        if (step.action === "input") {
          if (typeof step.value !== "string") fail(index, msg("errValueRequired", "缺少 value（字符串）"));
          out.value = step.value;
        }
        if (["waitForElement", "click", "assert"].includes(step.action) && step.textContains !== undefined) {
          if (typeof step.textContains !== "string") fail(index, msg("errValueRequired", "textContains 必须是字符串"));
          out.textContains = step.textContains;
        }
        break;
      }
      case "wait": {
        out.ms = num(step.ms, 0, MAX_WAIT_MS, "ms");
        break;
      }
      case "press": {
        const key = str(step.key);
        if (!key || key.length > 32) fail(index, msg("errKeyRequired", "缺少 key（如 Enter/Esc/Tab）"));
        out.key = key;
        const selector = str(step.selector);
        if (selector !== undefined) out.selector = selector;
        break;
      }
      case "scroll": {
        if (!["top", "bottom", "selector", "y"].includes(step.to)) {
          fail(index, msg("errToInvalid", "to 必须是 top/bottom/selector/y"));
        }
        out.to = step.to;
        if (step.to === "selector") {
          const selector = str(step.selector);
          if (!selector) fail(index, msg("errScrollSelector", "to 为 selector 时必须提供 selector"));
          out.selector = selector;
        }
        if (step.to === "y") {
          out.y = num(step.y, -100000, 1000000, "y");
        }
        if (step.behavior !== undefined) {
          if (!["auto", "smooth", "instant"].includes(step.behavior)) {
            fail(index, msg("errBehavior", "behavior 必须是 auto/smooth/instant"));
          }
          out.behavior = step.behavior;
        }
        break;
      }
      case "extract": {
        const selector = str(step.selector);
        if (selector !== undefined) out.selector = selector;
        const attr = str(step.attr);
        if (attr !== undefined) out.attr = attr;
        const label = str(step.label);
        if (label !== undefined) out.label = label;
        break;
      }
    }
    return out;
  });
}

// ---------- 视图切换 ----------

function showView(view) {
  $("scripts-list").classList.toggle("hidden", view !== "list");
  $("script-editor").classList.toggle("hidden", view !== "editor");
  $("script-run").classList.toggle("hidden", view !== "run");
}

function showError(text) {
  const el = $("editorError");
  el.textContent = text;
  el.classList.remove("hidden");
}

function hideError() {
  $("editorError").classList.add("hidden");
}

// ---------- 列表 ----------

function formatMeta(record) {
  const parts = [`${record.steps.length} ${t("stepsUnit", "steps")}`];
  if (record.lastRun) {
    const statusText =
      { success: t("runSuccess", "✅ 运行成功"), failed: t("runFailed", "❌ 运行失败"), aborted: t("runAborted", "已中止") }[
        record.lastRun.status
      ] || "";
    parts.push(`${t("lastRunLabel", "上次：")}${statusText} ${formatTime(record.lastRun.finishedAt)}`);
  } else {
    parts.push(t("neverRun", "尚未运行"));
  }
  return parts.join(" · ");
}

function formatTime(ts) {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

async function renderList() {
  const scripts = await HamsterDB.listScripts();
  const list = $("scriptItems");
  list.textContent = "";
  $("scriptsEmpty").classList.toggle("hidden", scripts.length > 0);

  for (const record of scripts) {
    const li = document.createElement("li");
    li.className = "script-item";

    const title = document.createElement("div");
    title.className = "script-item-title";
    title.textContent = record.name;

    const meta = document.createElement("div");
    meta.className = "script-item-meta";
    meta.textContent = formatMeta(record);

    const actions = document.createElement("div");
    actions.className = "script-item-actions";
    for (const [key, cls, handler] of [
      ["runBtn", "btn-primary", () => runScript(record)],
      ["editBtn", "", () => openEditor(record)],
      ["deleteBtn", "btn-danger", () => removeScript(record)],
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn btn-small ${cls}`.trim();
      btn.textContent = t(key, key);
      btn.addEventListener("click", handler);
      actions.appendChild(btn);
    }

    li.append(title, meta, actions);
    list.appendChild(li);
  }
}

async function removeScript(record) {
  if (!confirm(t("confirmDelete", "确定删除该脚本？"))) return;
  await HamsterDB.deleteScript(record.id);
  renderList();
}

// ---------- 编辑 ----------

function openEditor(record) {
  ui.editingId = record ? record.id : null;
  $("editorTitle").textContent = record ? t("editTitle", "编辑脚本") : t("newTitle", "新建脚本");
  $("scriptName").value = record ? record.name : "";
  $("scriptName").placeholder = t("namePlaceholder", "脚本名称");
  // 新建时预填模板内容，直接改 URL 和选择器就能跑
  $("scriptJson").value = JSON.stringify(record ? record.steps : SCRIPT_TEMPLATE, null, 2);
  hideError();
  showView("editor");
}

async function saveEditor() {
  const name = $("scriptName").value.trim() || t("untitled", "未命名脚本");
  let raw;
  try {
    raw = JSON.parse($("scriptJson").value);
  } catch (error) {
    showError(`${t("invalidJson", "JSON 解析失败：")}${error.message}`);
    return;
  }
  let steps;
  try {
    steps = validateSteps(raw);
  } catch (error) {
    showError(error.message);
    return;
  }
  await HamsterDB.saveScript({ id: ui.editingId || undefined, name, steps });
  showView("list");
  renderList();
}

// ---------- 运行 ----------

function connectPort() {
  const port = chrome.runtime.connect({ name: "hamster-run" });
  port.onMessage.addListener(handleRunEvent);
  port.onDisconnect.addListener(() => {
    ui.port = null;
    if (!ui.finished && ui.runningRecord) {
      setRunStatus(t("runFailedToStart", "无法启动运行：后台不可用，请重新加载扩展后重试"));
      ui.finished = true;
    }
  });
  return port;
}

async function runScript(record) {
  if (ui.port) {
    alert(t("alreadyRunning", "已有脚本正在运行"));
    return;
  }
  ui.runningRecord = record;
  ui.stepResults = record.steps.map(() => ({ status: "pending" }));
  ui.finished = false;
  buildRunView(record);
  showView("run");
  $("runLogs").textContent = "";
  $("runLogs").classList.add("hidden");
  $("stopRun").classList.remove("hidden");
  $("backToList").classList.add("hidden");
  setRunStatus(t("runningStatus", "运行中…"));
  ui.port = connectPort();
  ui.port.postMessage({ type: "run", script: { name: record.name, steps: record.steps } });
}

function buildRunView(record) {
  $("runTitle").textContent = `${t("runTitle", "运行")}: ${record.name}`;
  const list = $("runSteps");
  list.textContent = "";
  record.steps.forEach((step, index) => {
    const li = document.createElement("li");
    li.className = "run-step";
    li.id = `run-step-${index}`;

    const head = document.createElement("div");
    head.className = "run-step-head";
    const name = document.createElement("span");
    name.className = "run-step-name";
    name.textContent = step.name || `${step.action} #${index + 1}`;
    const badge = document.createElement("span");
    badge.className = "badge badge-pending";
    badge.id = `run-badge-${index}`;
    badge.textContent = t("statusPending", "待执行");
    head.append(name, badge);

    const detail = document.createElement("div");
    detail.className = "run-step-detail";
    detail.id = `run-detail-${index}`;

    li.append(head, detail);
    list.appendChild(li);
  });
}

function setRunStatus(text) {
  $("runStatus").textContent = text;
}

const BADGE_KEY = { pending: "statusPending", running: "statusRunning", ok: "statusOk", skipped: "statusSkipped", failed: "statusFailed" };

function setStepStatus(index, status, detail) {
  const badge = $(`run-badge-${index}`);
  if (!badge) return;
  badge.className = `badge badge-${status}`;
  badge.textContent = t(BADGE_KEY[status], status);
  const el = $(`run-detail-${index}`);
  if (el) el.textContent = detail || "";
}

function appendLog(message) {
  const logs = $("runLogs");
  logs.classList.remove("hidden");
  const line = document.createElement("p");
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

function handleRunEvent(event) {
  switch (event.type) {
    case "started":
      setRunStatus(`${t("runningStatus", "运行中…")} ${event.tabUrl || ""}`);
      break;
    case "step-start":
      setStepStatus(event.index, "running");
      break;
    case "step-done":
      ui.stepResults[event.index] = { status: event.status, message: event.message, ms: event.ms };
      setStepStatus(event.index, event.status, `${event.message || ""}${event.ms != null ? ` · ${event.ms}ms` : ""}`);
      break;
    case "log":
      appendLog(event.message);
      break;
    case "error":
      ui.finished = true;
      finishRunView();
      setRunStatus(event.message);
      break;
    case "done":
      ui.finished = true;
      finishRunView();
      setRunStatus(
        event.status === "success"
          ? t("runSuccess", "✅ 运行成功")
          : event.status === "aborted"
            ? t("runAborted", "已中止")
            : `${t("runFailed", "❌ 运行失败")}${event.message ? `：${event.message}` : ""}`
      );
      persistLastRun(event);
      break;
  }
}

function finishRunView() {
  $("stopRun").classList.add("hidden");
  $("backToList").classList.remove("hidden");
  if (ui.port) {
    ui.port.disconnect();
    ui.port = null;
  }
}

async function persistLastRun(doneEvent) {
  if (!ui.runningRecord) return;
  try {
    const record = await HamsterDB.getScript(ui.runningRecord.id);
    if (!record) return;
    record.lastRun = {
      finishedAt: Date.now(),
      status: doneEvent.status,
      elapsedMs: doneEvent.elapsedMs,
      message: doneEvent.message || "",
      steps: ui.stepResults.map((result, index) => ({ index, ...result })),
    };
    await HamsterDB.saveScript(record);
  } catch {
    /* 运行记录写不进去不影响主流程 */
  }
}

function stopRun() {
  if (ui.port) ui.port.postMessage({ type: "stop" });
}

// ---------- 初始化 ----------

function applyScriptsTranslations() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  $("scriptsTitle").textContent = t("scriptsTitle", "签到脚本");
  $("newScript").textContent = t("newScript", "＋ 新建脚本");
  $("scriptsEmpty").textContent = t("emptyScripts", "还没有脚本，点「新建脚本」写一个吧。");
  $("editorTitle").textContent = t("newTitle", "新建脚本");
  $("scriptName").placeholder = t("namePlaceholder", "脚本名称");
  $("saveScript").textContent = t("save", "保存");
  $("cancelEdit").textContent = t("cancel", "取消");
  $("runTitle").textContent = t("runTitle", "运行");
  $("stopRun").textContent = t("stopBtn", "停止");
  $("backToList").textContent = t("backToList", "返回列表");
}

function initScripts() {
  applyScriptsTranslations();

  $("newScript").addEventListener("click", () => openEditor(null));
  $("saveScript").addEventListener("click", () => saveEditor().catch((error) => showError(error.message)));
  $("cancelEdit").addEventListener("click", () => {
    showView("list");
    renderList();
  });
  $("stopRun").addEventListener("click", stopRun);
  $("backToList").addEventListener("click", () => {
    showView("list");
    renderList();
  });

  renderList();
}

initScripts();
