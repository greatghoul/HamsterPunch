// executor.js — 签到脚本运行引擎（service worker 侧，由 background.js importScripts 引入）
//
// 权限模型：manifest 声明了 host_permissions <all_urls>，页面注入不依赖 activeTab
// 手势，任何 http(s) 标签页（包括后台新开的标签页）都可以直接执行，没有暂停/续跑。
// activeTab 仍保留作兜底：即使用户在 Chrome 设置里限制了本扩展的站点访问，
// 点击工具栏图标授权的那个标签页依然可注入。

const HamsterExecutor = (() => {
  // MV3 service worker 空闲约 30s 会被回收；运行期间定时调用一次扩展 API 保活
  const HEARTBEAT_MS = 20000;
  const WAIT_SLICE_MS = 1000; // 长等待按小片睡眠，保证能及时响应"停止"
  const LOAD_POLL_MS = 300;
  const INJECT_FAIL_LIMIT = 10; // 轮询中连续注入失败达到该次数即判定页面不可注入

  const DEFAULTS = {
    openLoadTimeout: 20000,
    waitForTimeout: 10000,
    waitForInterval: 500,
    assertTimeout: 5000,
    actionTimeout: 10000,
  };

  class StopError extends Error {
    constructor() {
      super("run stopped");
      this.name = "StopError";
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function startHeartbeat(state) {
    state.heartbeat = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat(state) {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  }

  // ---------- 页面注入 ----------

  /** 在目标标签页内执行函数 */
  async function inject(tabId, func, args = []) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
      });
      return injection ? injection.result : undefined;
    } catch (error) {
      if (/cannot access|extension manifest must request/i.test(error.message || "")) {
        throw new Error("page not scriptable (browser-internal or restricted page)");
      }
      throw error;
    }
  }

  function ensureTarget(state) {
    if (state.tabId == null) throw new Error("no target tab; use the open action first");
  }

  // 以下函数体会被序列化进页面执行，必须自包含，不能引用外部变量。

  /**
   * 查询元素：先用 selector 取集合，命中文本条件的第 index 个即命中。
   * 文本条件在页面内对完整文本判断，只回传判定结果与一小段摘要——不能先截断再匹配，
   * body 这类大范围选择器的文本几乎必然超过摘要长度，先 slice 会让 textContains 永远匹配不到。
   * 连续空白（源码换行/缩进）折叠成单个空格，让被换行打断的句子仍能匹配。
   * 没命中时也回传第一个元素的文本，便于报错时定位。
   */
  function pageQuery(selector, textContains, index) {
    const els = Array.from(document.querySelectorAll(selector));
    if (!els.length) return null;
    const squeeze = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
    // 没有 textContains 时，集合就是 selector 的全部匹配
    const hits = textContains ? els.filter((el) => squeeze(el).includes(textContains)) : els;
    const want = Number(index) || 0;
    const el = hits[want];
    const first = squeeze(els[0]);
    return {
      tag: (el || els[0]).tagName.toLowerCase(),
      text: (el ? squeeze(el) : first).slice(0, 200),
      hasText: !!el,
      count: els.length,
      hits: hits.length,
      want,
    };
  }

  /** 点击元素：过滤规则必须与 pageQuery 一致，保证点到的是校验通过的那个 */
  function pageClick(selector, index, textContains) {
    const els = Array.from(document.querySelectorAll(selector));
    const want = Number(index) || 0;
    let seen = 0;
    for (const el of els) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (textContains && !text.includes(textContains)) continue;
      if (seen === want) {
        el.click();
        return true;
      }
      seen++;
    }
    return false;
  }

  function pageFill(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.focus();
    // 用原生 setter 赋值，保证 React 等受控组件能监听到变化
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")
      ? Object.getOwnPropertyDescriptor(proto, "value").set
      : null;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function pagePress(key, selector) {
    const target = selector ? document.querySelector(selector) : document.activeElement;
    if (!target) return false;
    const init = { key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }

  function pageScroll(mode, selector, y, behavior) {
    if (mode === "top") {
      window.scrollTo({ top: 0, behavior });
      return true;
    }
    if (mode === "bottom") {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      return true;
    }
    if (mode === "y") {
      window.scrollTo({ top: Number(y) || 0, behavior });
      return true;
    }
    if (mode === "selector") {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.scrollIntoView({ behavior, block: "center" });
      return true;
    }
    return false;
  }

  function pageExtract(selector, attr) {
    if (!selector) return document.title || "";
    const el = document.querySelector(selector);
    if (!el) return null;
    if (attr) return el.getAttribute(attr) || "";
    return (el.textContent || "").trim().slice(0, 500);
  }

  // ---------- 加载等待 ----------

  /**
   * 新标签页的加载等待：刚创建的 tab 初始就是 loading，直接轮询状态即可，
   * 不存在"错过 complete 事件"的竞态。超时不判失败，交给后续步骤的元素等待。
   */
  async function waitForTabComplete(state, tabId, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (state.stopRequested) throw new StopError();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error("target tab was closed");
      if (tab.status === "complete" || Date.now() >= deadline) return;
      await sleep(LOAD_POLL_MS);
    }
  }

  /**
   * 当前标签页导航的加载等待：必须先挂监听再触发导航，否则快速页面会在
   * 监听挂上之前就 complete，导致白等满超时。超时不判失败。
   */
  function makeLoadWaiter(tabId, timeout) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      };
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") finish();
      };
      const timer = setTimeout(finish, timeout);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  // ---------- 动作实现 ----------

  /**
   * 轮询等待元素出现（可附加文本条件）；导航瞬间的注入失败视为"还没出现"，
   * 但连续失败达到上限则判定页面本身不可注入，直接抛错。
   * textContains 为 null 时退化为原来的“selector 第 index 个元素”。
   */
  async function pollForElement(state, selector, timeout, interval, textContains, index) {
    const deadline = Date.now() + Math.max(0, timeout);
    let consecutiveFails = 0;
    for (;;) {
      if (state.stopRequested) throw new StopError();
      let info = null;
      try {
        info = await inject(state.tabId, pageQuery, [selector, textContains || null, index || 0]);
        consecutiveFails = 0;
      } catch (error) {
        if (error instanceof StopError) throw error;
        consecutiveFails++;
        if (consecutiveFails >= INJECT_FAIL_LIMIT) throw error;
        /* 偶发注入失败不算超时，继续轮询到 deadline 为止 */
      }
      // 无文本条件时只要求取到元素（index 越界则交给调用方报错，不在这里白等）
      if (info && (!textContains || info.hasText)) return info;
      if (Date.now() >= deadline) {
        if (!info) throw new Error(`timeout waiting for element ${selector} (${timeout}ms)`);
        // 区分“文本没命中”和“文本命中但 index 越界”，并把实际文本带出来便于排查
        const detail =
          info.hits === 0
            ? `none contains "${textContains}"`
            : `only ${info.hits} contains "${textContains}", index ${info.want} is out of range`;
        throw new Error(
          `element ${selector} found (${info.count} match${info.count > 1 ? "es" : ""}) but ${detail}; first text: "${info.text.slice(0, 80)}"`
        );
      }
      await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
    }
  }

  const ACTIONS = {
    /**
     * 默认打开新标签页并成为后续步骤的目标（active 默认 false = 后台）；
     * newTab: false 时在当前目标标签页内导航。
     */
    async open(step, state) {
      if (step.newTab === false) {
        ensureTarget(state);
        const loaded = makeLoadWaiter(state.tabId, step.loadTimeout || DEFAULTS.openLoadTimeout);
        await chrome.tabs.update(state.tabId, { url: step.url });
        await loaded;
        return `navigated to ${step.url}`;
      }
      const tab = await chrome.tabs.create({ url: step.url, active: !!step.active });
      state.tabId = tab.id;
      await waitForTabComplete(state, tab.id, step.loadTimeout || DEFAULTS.openLoadTimeout);
      return step.active
        ? `opened ${step.url} in new tab (foreground)`
        : `opened ${step.url} in background tab`;
    },

    /** 关闭当前目标标签页；后续页面内动作需要先重新 open */
    async close(step, state) {
      ensureTarget(state);
      const tabId = state.tabId;
      await chrome.tabs.remove(tabId);
      state.tabId = null;
      return `closed tab ${tabId}`;
    },

    async waitForElement(step, state) {
      ensureTarget(state);
      const info = await pollForElement(
        state,
        step.selector,
        step.timeout === undefined ? DEFAULTS.waitForTimeout : step.timeout,
        step.interval === undefined ? DEFAULTS.waitForInterval : step.interval,
        step.textContains
      );
      const label = `<${info.tag}>${step.textContains ? ` containing "${step.textContains}"` : ""}`;
      return info.text ? `found ${label}: "${info.text.slice(0, 60)}"` : `found ${label}`;
    },

    async wait(step, state) {
      let waited = 0;
      while (waited < step.ms) {
        if (state.stopRequested) throw new StopError();
        const chunk = Math.min(WAIT_SLICE_MS, step.ms - waited);
        await sleep(chunk);
        waited += chunk;
      }
      return `waited ${step.ms}ms`;
    },

    async click(step, state) {
      ensureTarget(state);
      await pollForElement(
        state,
        step.selector,
        step.timeout === undefined ? DEFAULTS.actionTimeout : step.timeout,
        300,
        step.textContains,
        step.index
      );
      const clicked = await inject(state.tabId, pageClick, [step.selector, step.index || 0, step.textContains || null]);
      if (!clicked) throw new Error(`failed to click ${step.selector}`);
      return step.textContains
        ? `clicked ${step.selector} containing "${step.textContains}"`
        : `clicked ${step.selector}`;
    },

    async input(step, state) {
      ensureTarget(state);
      await pollForElement(state, step.selector, step.timeout === undefined ? DEFAULTS.actionTimeout : step.timeout, 300);
      const value = String(step.value);
      const ok = await inject(state.tabId, pageFill, [step.selector, value]);
      if (!ok) throw new Error(`input ${step.selector} is not usable`);
      return `typed ${value.length} chars into ${step.selector}`;
    },

    async press(step, state) {
      ensureTarget(state);
      const ok = await inject(state.tabId, pagePress, [step.key, step.selector || null]);
      if (!ok) throw new Error(step.selector ? `key target ${step.selector} not found` : "no element to receive the key");
      return `pressed ${step.key}`;
    },

    async scroll(step, state) {
      ensureTarget(state);
      const ok = await inject(state.tabId, pageScroll, [step.to, step.selector || null, step.y || 0, step.behavior || "auto"]);
      if (!ok) throw new Error(step.to === "selector" ? `scroll target ${step.selector} not found` : "invalid scroll arguments");
      const target = step.to === "selector" ? step.selector : step.to === "y" ? `y=${step.y}` : step.to;
      return `scrolled to ${target}`;
    },

    async assert(step, state) {
      ensureTarget(state);
      const info = await pollForElement(
        state,
        step.selector,
        step.timeout === undefined ? DEFAULTS.assertTimeout : step.timeout,
        300,
        step.textContains
      );
      return step.textContains
        ? `assert ok: <${info.tag}> contains "${step.textContains}"`
        : `assert ok: <${info.tag}>`;
    },

    async extract(step, state) {
      ensureTarget(state);
      const value = await inject(state.tabId, pageExtract, [step.selector || null, step.attr || null]);
      if (value === null || value === undefined) {
        throw new Error(step.selector ? `element ${step.selector} not found` : "extract failed");
      }
      const label = step.label || step.selector || "page title";
      state.emit({ type: "log", message: `${label}: ${value}` });
      return `${label} = ${String(value).slice(0, 80)}`;
    },
  };

  // ---------- 运行会话 ----------

  /**
   * 创建一次运行。
   * @param {object} options
   * @param {object} options.script  已通过面板校验的脚本记录（含 steps）
   * @param {number} options.startTabId  调用扩展时所在的标签页，作为初始目标
   * @param {(event: object) => void} options.emit  向面板推送运行事件
   */
  function createRun({ script, startTabId, emit }) {
    const steps = Array.isArray(script.steps) ? script.steps : [];
    const state = {
      tabId: startTabId,
      stopRequested: false,
      heartbeat: null,
      emit: (event) => {
        try {
          emit(event);
        } catch {
          /* 面板端口异常不阻塞运行 */
        }
      },
    };

    async function run() {
      const startedAt = Date.now();
      startHeartbeat(state);
      try {
        // tabs 权限允许直接读取标签页 URL，用于在面板展示目标页
        const tab = await chrome.tabs.get(state.tabId).catch(() => null);
        state.emit({ type: "started", tabUrl: (tab && tab.url) || "" });

        for (let i = 0; i < steps.length; i++) {
          if (state.stopRequested) throw new StopError();
          const step = steps[i];
          const name = step.name || `${step.action} #${i + 1}`;
          state.emit({ type: "step-start", index: i, name });
          const t0 = Date.now();
          try {
            const handler = ACTIONS[step.action];
            const message = await handler(step, state);
            state.emit({ type: "step-done", index: i, status: "ok", message, ms: Date.now() - t0 });
          } catch (error) {
            if (error instanceof StopError) throw error;
            if (step.optional) {
              state.emit({ type: "step-done", index: i, status: "skipped", message: error.message, ms: Date.now() - t0 });
            } else {
              state.emit({ type: "step-done", index: i, status: "failed", message: error.message, ms: Date.now() - t0 });
              throw error;
            }
          }
        }
        state.emit({ type: "done", status: "success", elapsedMs: Date.now() - startedAt });
      } catch (error) {
        if (error instanceof StopError) {
          state.emit({ type: "done", status: "aborted", elapsedMs: Date.now() - startedAt });
        } else {
          state.emit({ type: "done", status: "failed", message: error.message, elapsedMs: Date.now() - startedAt });
        }
      } finally {
        stopHeartbeat(state);
      }
    }

    return {
      start: run,
      stop() {
        state.stopRequested = true;
      },
    };
  }

  return { createRun };
})();
