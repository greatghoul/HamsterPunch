// scripts-ui.js — 侧边栏主视图：签到脚本管理（列表 / 编辑 / 运行）
// 依赖 lib/db.js（HamsterDB）先加载。

const t = (key, fallback = "") => chrome.i18n.getMessage(key) || fallback;

const $ = (id) => document.getElementById(id);

/** 新建脚本时预填的示例，直接改 URL 和选择器就能跑 */
function makeTemplate() {
  return [
    { name: t("tmplOpen", "打开签到页（后台标签页）"), action: "open", url: "http://localhost:8000/demo-site.html", active: false },
    { name: t("tmplWaitForElement", "等按钮出现"), action: "waitForElement", selector: "#signin-btn", timeout: 8000 },
    { name: t("tmplInput", "填昵称"), action: "input", selector: "#nickname", value: "仓鼠" },
    { name: t("tmplPress", "提交昵称"), action: "press", key: "Enter", selector: "#nickname" },
    { name: t("tmplClick", "点击签到"), action: "click", selector: "#signin-btn" },
    { name: t("tmplWait", "等结果"), action: "wait", ms: 2000 },
    { name: t("tmplAssert", "确认成功"), action: "assert", selector: ".success-msg", textContains: "已签到" },
    { name: t("tmplClose", "关闭标签页"), action: "close" },
  ];
}

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

/**
 * 表单模式的动作定义：每个动作有哪些字段、字段类型、默认值和显隐条件。
 * 代码模式与保存时的最终校验仍以 validateStep 为准，这里只负责“好看好填”。
 */
const ACTION_DEFS = {
  open: {
    defaults: { url: "https://", newTab: true, active: false, loadTimeout: 20000 },
    fields: [
      { key: "url", type: "text", placeholder: "https://example.com" },
      { key: "newTab", type: "checkbox" },
      { key: "active", type: "checkbox", showIf: (step) => step.newTab !== false },
      { key: "loadTimeout", type: "number", min: 1000, max: 60000 },
    ],
  },
  waitForElement: {
    defaults: { selector: "", timeout: 10000, interval: 500 },
    fields: [
      { key: "selector", type: "text", placeholder: "#signin-btn" },
      { key: "textContains", type: "text", optionalText: true },
      { key: "timeout", type: "number", min: 0, max: 300000 },
      { key: "interval", type: "number", min: 50, max: 5000 },
    ],
  },
  wait: {
    defaults: { ms: 1000 },
    fields: [{ key: "ms", type: "number", min: 0, max: 300000 }],
  },
  click: {
    defaults: { selector: "", timeout: 10000, index: 0 },
    fields: [
      { key: "selector", type: "text", placeholder: "#signin-btn" },
      { key: "textContains", type: "text", optionalText: true },
      { key: "index", type: "number", min: 0, max: 1000 },
      { key: "timeout", type: "number", min: 0, max: 300000 },
    ],
  },
  input: {
    defaults: { selector: "", value: "", timeout: 10000 },
    fields: [
      { key: "selector", type: "text", placeholder: "#nickname" },
      { key: "value", type: "text" },
      { key: "timeout", type: "number", min: 0, max: 300000 },
    ],
  },
  press: {
    defaults: { key: "Enter", selector: "" },
    fields: [
      { key: "key", type: "text", placeholder: "Enter" },
      { key: "selector", type: "text", optionalText: true, placeholder: "#nickname" },
    ],
  },
  scroll: {
    defaults: { to: "top", behavior: "auto" },
    fields: [
      { key: "to", type: "select", options: ["top", "bottom", "selector", "y"] },
      { key: "selector", type: "text", showIf: (step) => step.to === "selector", placeholder: "#footer" },
      { key: "y", type: "number", min: -100000, max: 1000000, showIf: (step) => step.to === "y" },
      { key: "behavior", type: "select", options: ["auto", "smooth", "instant"] },
    ],
  },
  assert: {
    defaults: { selector: "", timeout: 5000 },
    fields: [
      { key: "selector", type: "text", placeholder: ".success-msg" },
      { key: "textContains", type: "text", optionalText: true },
      { key: "timeout", type: "number", min: 0, max: 300000 },
    ],
  },
  extract: {
    defaults: {},
    fields: [
      { key: "selector", type: "text", optionalText: true },
      { key: "attr", type: "text", optionalText: true },
      { key: "label", type: "text", optionalText: true },
    ],
  },
  close: { defaults: {}, fields: [] },
};

const MAX_STEPS = 100;
const MAX_WAIT_MS = 300000;
const MODE_KEY = "editorMode";

const ui = {
  editingId: null,
  runningRecord: null,
  port: null,
  stepResults: [],
  finished: true,
  editorMode: "form", // "form" | "code"
  draftSteps: [],
  cardEls: [], // 表单模式下每张步骤卡片的 DOM，供标记错误/定位使用（列表里还混着插入条）
  lastAdded: null, // 刚插入/新增的步骤下标，用来做一次高亮动画
};

// ---------- JSON 校验 ----------

/**
 * 校验并归一化单个步骤；不合法时调用 fail(原因)。
 * validateSteps（代码模式 / 保存）和表单模式都复用它，保证两种模式规则一致。
 */
function validateStep(step, fail) {
  const msg = (key, fallback) => t(key, fallback);

  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    fail(msg("errStepObject", "步骤必须是对象"));
  }
  if (!ACTIONS.includes(step.action)) {
    fail(chrome.i18n.getMessage("errUnknownAction", [String(step.action)]) || `未知动作 ${step.action}`);
  }

  const num = (value, min, max, field) => {
    if (value === undefined) fail(`${field}: ${msg("errMissing", "缺少参数")}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      fail(`${field}: ${msg("errNumRange", "数值超出允许范围")} (${min}–${max})`);
    }
    return value;
  };
  const str = (value) => (typeof value === "string" ? value : undefined);
  const bool = (value) => {
    if (value !== undefined && typeof value !== "boolean") fail(msg("errNotBoolean", "必须是 true/false"));
    return value;
  };

  const out = { action: step.action };
  const name = str(step.name);
  if (name !== undefined) {
    if (!name.trim()) fail(msg("errStepName", "name 不能为空字符串"));
    out.name = name.trim();
  }
  const optional = bool(step.optional);
  if (optional !== undefined) out.optional = optional;

  switch (step.action) {
    case "open": {
      const url = str(step.url);
      if (!url || !/^https?:\/\//i.test(url)) fail(msg("errUrlRequired", "url 必须是 http(s) 链接"));
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
      if (!selector) fail(msg("errSelectorRequired", "缺少 selector"));
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
        if (typeof step.value !== "string") fail(msg("errValueRequired", "缺少 value（字符串）"));
        out.value = step.value;
      }
      if (["waitForElement", "click", "assert"].includes(step.action) && step.textContains !== undefined) {
        if (typeof step.textContains !== "string") fail(msg("errValueRequired", "textContains 必须是字符串"));
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
      if (!key || key.length > 32) fail(msg("errKeyRequired", "缺少 key（如 Enter/Esc/Tab）"));
      out.key = key;
      const selector = str(step.selector);
      if (selector !== undefined) out.selector = selector;
      break;
    }
    case "scroll": {
      if (!["top", "bottom", "selector", "y"].includes(step.to)) {
        fail(msg("errToInvalid", "to 必须是 top/bottom/selector/y"));
      }
      out.to = step.to;
      if (step.to === "selector") {
        const selector = str(step.selector);
        if (!selector) fail(msg("errScrollSelector", "to 为 selector 时必须提供 selector"));
        out.selector = selector;
      }
      if (step.to === "y") {
        out.y = num(step.y, -100000, 1000000, "y");
      }
      if (step.behavior !== undefined) {
        if (!["auto", "smooth", "instant"].includes(step.behavior)) {
          fail(msg("errBehavior", "behavior 必须是 auto/smooth/instant"));
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
}

/** 逐步骤校验并归一化；不合法时抛错（错误信息带"第 N 步"前缀） */
function validateSteps(raw) {
  const fail = (index, reason) => {
    throw new Error(
      chrome.i18n.getMessage("stepError", [String(index + 1), reason]) || `#${index + 1}: ${reason}`
    );
  };

  if (!Array.isArray(raw)) throw new Error(t("errNotArray", "脚本必须是一个步骤数组"));
  if (raw.length === 0) throw new Error(t("errEmpty", "脚本至少需要一个步骤"));
  if (raw.length > MAX_STEPS) throw new Error(t("errTooMany", `步骤数量超过上限（${MAX_STEPS}）`));

  return raw.map((step, index) => validateStep(step, (reason) => fail(index, reason)));
}

/** 单个步骤不合法时返回原因，合法返回 null（表单模式用来标红卡片） */
function stepErrorReason(step) {
  try {
    validateStep(step, (reason) => {
      throw new Error(reason);
    });
    return null;
  } catch (error) {
    return error.message;
  }
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
      ["editBtn", "", () => openEditor(record).catch(() => {})],
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

// ---------- 编辑：表单 / 代码 双模式 ----------

/** 在表单字段里展示用的默认值（新建步骤、清空数字字段时使用） */
function defaultsFor(action) {
  const def = ACTION_DEFS[action];
  return { action, ...(def ? def.defaults : {}) };
}

/** 开编辑器前先把步骤归一化，这样表单里每个字段都有值可显示 */
function normalizeForEditing(steps) {
  try {
    return validateSteps(steps);
  } catch {
    return JSON.parse(JSON.stringify(steps));
  }
}

async function getPreferredMode() {
  try {
    const stored = await chrome.storage.local.get(MODE_KEY);
    return stored[MODE_KEY] === "code" ? "code" : "form";
  } catch {
    return "form";
  }
}

function savePreferredMode(mode) {
  chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => {});
}

async function openEditor(record) {
  ui.editingId = record ? record.id : null;
  $("editorTitle").textContent = record ? t("editTitle", "编辑脚本") : t("newTitle", "新建脚本");
  $("scriptName").value = record ? record.name : "";
  $("scriptName").placeholder = t("namePlaceholder", "脚本名称");
  ui.draftSteps = normalizeForEditing(record ? record.steps : makeTemplate());
  ui.editorMode = "form"; // 先重置，避免误读上一份脚本留在代码框里的 JSON
  hideError();
  showView("editor");
  setEditorMode(await getPreferredMode());
}

/** 切换编辑模式；从代码模式回表单时会先校验 JSON，不合法则留在代码模式 */
function setEditorMode(mode) {
  if (mode === "form" && ui.editorMode === "code") {
    let parsed;
    try {
      parsed = JSON.parse($("scriptJson").value);
    } catch (error) {
      showError(`${t("invalidJson", "JSON 解析失败：")}${error.message}`);
      return;
    }
    try {
      ui.draftSteps = validateSteps(parsed);
    } catch (error) {
      showError(error.message);
      return;
    }
    hideError();
  }

  ui.editorMode = mode;
  const isForm = mode === "form";
  $("modeForm").classList.toggle("active", isForm);
  $("modeCode").classList.toggle("active", !isForm);
  $("modeForm").setAttribute("aria-selected", String(isForm));
  $("modeCode").setAttribute("aria-selected", String(!isForm));
  $("formEditor").classList.toggle("hidden", !isForm);
  $("scriptJson").classList.toggle("hidden", isForm);
  if (isForm) {
    renderForm();
  } else {
    $("scriptJson").value = JSON.stringify(ui.draftSteps, null, 2);
  }
  hideError();
  savePreferredMode(mode);
}

// ----- 表单渲染 -----

/** 动作显示名，如 “点击 (click)”，让表单和代码模式能对上号 */
function actionLabel(action) {
  return t(`action${action.charAt(0).toUpperCase()}${action.slice(1)}`, action);
}

function actionOptionText(action) {
  return `${actionLabel(action)} (${action})`;
}

function fieldLabelKey(key) {
  return `field${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function optionLabel(value) {
  return t(`opt${value.charAt(0).toUpperCase()}${value.slice(1)}`, value);
}

function buildAddActionOptions() {
  const select = $("addStepAction");
  const previous = select.value;
  select.textContent = "";
  for (const action of ACTIONS) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = actionOptionText(action);
    select.appendChild(option);
  }
  if (ACTIONS.includes(previous)) select.value = previous;
}

/** 插入条的提示文字跟着右上角下拉框的选择走，选了什么就插什么 */
function refreshGapTitles() {
  const action = $("addStepAction").value;
  const title = `${t("insertStep", "在此插入新步骤")} · ${actionOptionText(action)}`;
  for (const card of ui.cardEls) {
    const gap = card.previousElementSibling;
    if (gap && gap.className === "step-gap") {
      const button = gap.querySelector(".gap-btn");
      if (button) button.title = title;
    }
  }
  $("addStep").title = `${t("insertStepEnd", "添加到末尾")} · ${actionOptionText(action)}`;
}

/** 两个步骤之间的插入条：点一下就插到这个位置 */
function buildGap(index) {
  const gap = document.createElement("div");
  gap.className = "step-gap";

  const line = () => {
    const span = document.createElement("span");
    span.className = "gap-line";
    return span;
  };

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gap-btn";
  button.textContent = "＋";
  button.addEventListener("click", () => insertStep(index));

  gap.append(line(), button, line());
  return gap;
}

function renderForm() {
  const list = $("stepList");
  list.textContent = "";
  ui.cardEls = ui.draftSteps.map((step, index) => {
    list.appendChild(buildGap(index)); // 每张卡片前面都有一条插入条
    const card = buildStepCard(step, index);
    list.appendChild(card);
    return card;
  });
  $("formEmpty").classList.toggle("hidden", ui.draftSteps.length > 0);
  markAllStepErrors();
  refreshGapTitles();
  highlightLastAdded();
}

/** 新增/插入后给那张卡片闪一下，避免在长列表里找不到插到哪了 */
function highlightLastAdded() {
  const index = ui.lastAdded;
  ui.lastAdded = null;
  const card = ui.cardEls[index];
  if (!card) return;
  card.classList.add("just-added");
  setTimeout(() => card.classList.remove("just-added"), 1200);
}

function buildStepCard(step, index) {
  const li = document.createElement("li");
  li.className = "step-card";

  // 卡片头：序号 + 步骤名 + 上移/下移/删除
  const head = document.createElement("div");
  head.className = "step-card-head";

  const badge = document.createElement("span");
  badge.className = "step-index";
  badge.textContent = String(index + 1);
  badge.title = t("stepLabel", "步骤");

  const name = document.createElement("input");
  name.type = "text";
  name.className = "step-name";
  name.value = step.name || "";
  name.placeholder = t("stepNamePlaceholder", "步骤名称（可选）");
  name.addEventListener("input", () => {
    step.name = name.value;
  });

  const tools = document.createElement("div");
  tools.className = "step-tools";
  const iconButton = (glyph, title, handler, disabled) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.textContent = glyph;
    button.title = title;
    button.disabled = !!disabled;
    button.addEventListener("click", handler);
    return button;
  };
  tools.append(
    iconButton("↑", t("moveUp", "上移"), () => moveStep(index, -1), index === 0),
    iconButton("↓", t("moveDown", "下移"), () => moveStep(index, 1), index === ui.draftSteps.length - 1),
    iconButton("✕", t("removeStep", "删除步骤"), () => removeStep(index))
  );
  head.append(badge, name, tools);

  // 动作选择 + 「失败时跳过」
  const actionRow = document.createElement("div");
  actionRow.className = "step-action-row";

  const select = document.createElement("select");
  select.className = "step-action";
  for (const action of ACTIONS) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = actionOptionText(action);
    select.appendChild(option);
  }
  select.value = step.action;
  select.addEventListener("change", () => {
    // 换动作时保留步骤名和 optional，其余参数回到该动作的默认值
    ui.draftSteps[index] = { ...defaultsFor(select.value), name: step.name, optional: step.optional };
    renderForm();
  });

  const optionalWrap = document.createElement("label");
  optionalWrap.className = "step-optional";
  const optional = document.createElement("input");
  optional.type = "checkbox";
  optional.checked = !!step.optional;
  optional.addEventListener("change", () => {
    if (optional.checked) step.optional = true;
    else delete step.optional;
  });
  const optionalText = document.createElement("span");
  optionalText.textContent = t("optionalLabel", "失败时跳过");
  optionalWrap.append(optional, optionalText);

  actionRow.append(select, optionalWrap);

  const fields = document.createElement("div");
  fields.className = "step-fields";
  fillStepFields(fields, step, index);

  const error = document.createElement("p");
  error.className = "step-error hidden";

  li.append(head, actionRow, fields, error);
  return li;
}

/** 按动作定义填充字段；showIf 为假的字段不渲染 */
function fillStepFields(container, step, index) {
  container.textContent = "";
  const def = ACTION_DEFS[step.action];
  const fields = (def && def.fields) || [];
  let shown = 0;
  for (const field of fields) {
    if (field.showIf && !field.showIf(step)) continue;
    container.appendChild(buildField(step, index, field));
    shown++;
  }
  if (!shown) {
    const hint = document.createElement("p");
    hint.className = "step-hint";
    hint.textContent = t("noParamsHint", "这个动作不需要参数。");
    container.appendChild(hint);
  }
}

function buildField(step, index, field) {
  const isCheck = field.type === "checkbox";
  const wrap = document.createElement("label");
  wrap.className = isCheck ? "field field-check" : "field";

  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = t(fieldLabelKey(field.key), field.key);

  const control = (() => {
    if (field.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = step[field.key] === true;
      input.addEventListener("change", () => {
        step[field.key] = input.checked;
        // 例如 open.newTab 会决定 active 是否显示
        refreshStepFields(index);
      });
      return input;
    }
    if (field.type === "select") {
      const select = document.createElement("select");
      select.className = "field-input";
      for (const value of field.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = optionLabel(value);
        select.appendChild(option);
      }
      select.value = step[field.key] || field.options[0];
      select.addEventListener("change", () => {
        step[field.key] = select.value;
        refreshStepFields(index);
      });
      return select;
    }
    const input = document.createElement("input");
    input.className = "field-input";
    if (field.type === "number") {
      input.type = "number";
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      input.value = step[field.key] === undefined ? "" : String(step[field.key]);
      input.addEventListener("input", () => {
        // 清空数字字段就删掉这个键：可选数字会回退到动作默认值，必填数字（如 wait.ms）会被标红提醒
        if (input.value.trim() === "" || !Number.isFinite(Number(input.value))) delete step[field.key];
        else step[field.key] = Number(input.value);
        markStepError(index);
      });
    } else {
      input.type = "text";
      input.value = step[field.key] === undefined ? "" : String(step[field.key]);
      if (field.placeholder) input.placeholder = field.placeholder;
      input.addEventListener("input", () => {
        // 可选文本留空就删掉键，保持 JSON 干净；必填字段保留空串以触发校验提示
        if (field.optionalText && input.value === "") delete step[field.key];
        else step[field.key] = input.value;
        markStepError(index);
      });
    }
    return input;
  })();

  if (isCheck) wrap.append(control, label);
  else wrap.append(label, control);
  return wrap;
}

function refreshStepFields(index) {
  const card = ui.cardEls[index];
  if (!card) return;
  const box = card.querySelector(".step-fields");
  if (box) fillStepFields(box, ui.draftSteps[index], index);
  markStepError(index);
}

/** 标出某一步的问题，返回错误文案（没问题返回 null） */
function markStepError(index) {
  const card = ui.cardEls[index];
  if (!card) return null;
  const reason = stepErrorReason(ui.draftSteps[index]);
  const error = card.querySelector(".step-error");
  if (error) {
    error.textContent = reason || "";
    error.classList.toggle("hidden", !reason);
  }
  card.classList.toggle("invalid", !!reason);
  return reason;
}

function markAllStepErrors() {
  let first = null;
  ui.draftSteps.forEach((step, index) => {
    const reason = markStepError(index);
    if (reason && !first) first = reason;
  });
  return first;
}

function moveStep(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= ui.draftSteps.length) return;
  const [step] = ui.draftSteps.splice(index, 1);
  ui.draftSteps.splice(target, 0, step);
  renderForm();
}

function removeStep(index) {
  ui.draftSteps.splice(index, 1);
  renderForm();
}

function addStep() {
  insertStep(ui.draftSteps.length);
}

/** 在第 index 个位置插入一个新步骤，并把它滚入视野、聚焦到动作下拉框 */
function insertStep(index) {
  const at = Math.max(0, Math.min(index, ui.draftSteps.length));
  ui.draftSteps.splice(at, 0, defaultsFor($("addStepAction").value));
  ui.lastAdded = at;
  renderForm();
  const card = ui.cardEls[at];
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  const select = card.querySelector(".step-action");
  if (select && select.focus) select.focus();
}

/** 保存前清理草稿：去掉空名字、optional:false 和空的可选文本字段 */
function cleanDraftSteps() {
  for (const step of ui.draftSteps) {
    if (step.optional === false) delete step.optional;
    if (typeof step.name === "string" && !step.name.trim()) delete step.name;
    const fields = (ACTION_DEFS[step.action] || {}).fields || [];
    for (const field of fields) {
      if (field.type === "text" && field.optionalText && step[field.key] === "") delete step[field.key];
    }
  }
}

async function saveEditor() {
  const name = $("scriptName").value.trim() || t("untitled", "未命名脚本");
  let raw;
  if (ui.editorMode === "form") {
    cleanDraftSteps();
    if (!ui.draftSteps.length) {
      showError(t("errEmpty", "脚本至少需要一个步骤"));
      return;
    }
    const first = markAllStepErrors();
    if (first) {
      showError(first);
      return;
    }
    raw = ui.draftSteps;
  } else {
    try {
      raw = JSON.parse($("scriptJson").value);
    } catch (error) {
      showError(`${t("invalidJson", "JSON 解析失败：")}${error.message}`);
      return;
    }
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
  $("modeForm").textContent = t("editorModeForm", "表单模式");
  $("modeCode").textContent = t("editorModeCode", "代码模式");
  $("formEmpty").textContent = t("formEmpty", "还没有步骤，从下面的下拉框里挑一个动作加进来吧。");
  $("addStep").textContent = t("addStep", "＋ 添加步骤");
  $("saveScript").textContent = t("save", "保存");
  $("cancelEdit").textContent = t("cancel", "取消");
  $("runTitle").textContent = t("runTitle", "运行");
  $("stopRun").textContent = t("stopBtn", "停止");
  $("backToList").textContent = t("backToList", "返回列表");
  buildAddActionOptions();
}

function initScripts() {
  applyScriptsTranslations();

  $("newScript").addEventListener("click", () => openEditor(null).catch((error) => showError(error.message)));
  $("modeForm").addEventListener("click", () => setEditorMode("form"));
  $("modeCode").addEventListener("click", () => setEditorMode("code"));
  $("addStep").addEventListener("click", () => addStep());
  $("addStepAction").addEventListener("change", refreshGapTitles);
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
