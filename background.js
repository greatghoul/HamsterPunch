// Service worker：管理侧边栏入口与签到脚本运行会话
importScripts("executor.js");

/** 当前唯一的运行会话（同一时间只允许一个脚本在跑） */
let session = null;

/** 记录最近一次调用扩展的标签页（activeTab 授权所在处），供运行时绑定 */
async function rememberInvocationTab(tabId) {
  await chrome.storage.session.set({ invocationTabId: tabId });
}

async function getInvocationTabId() {
  const { invocationTabId } = await chrome.storage.session.get("invocationTabId");
  if (typeof invocationTabId === "number") {
    try {
      await chrome.tabs.get(invocationTabId);
      return invocationTabId;
    } catch {
      /* 标签页已关闭，回退到当前活动标签页 */
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : null;
}

// 点击工具栏图标：打开侧边栏，并记住调用标签页（作为脚本运行的初始目标）
chrome.action.onClicked.addListener((tab) => {
  rememberInvocationTab(tab.id).catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => console.error(error));
});

// 覆盖旧版本设置的 openPanelOnActionClick 行为，保证 onClicked 事件能触发
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hamster-run") return;

  port.onMessage.addListener((message) => {
    if (message.type === "run") {
      // 先同步占住会话，避免并发 run 消息创建多个会话
      if (session) {
        port.postMessage({ type: "error", message: "a script is already running" });
        return;
      }
      session = { port, run: null };
      getInvocationTabId()
        .then((tabId) => {
          if (tabId == null) {
            session = null;
            port.postMessage({ type: "error", message: "no target tab found" });
            return;
          }
          const run = HamsterExecutor.createRun({
            script: message.script,
            startTabId: tabId,
            emit: (event) => {
              try {
                port.postMessage(event);
              } catch {
                /* 面板可能已关闭 */
              }
            },
          });
          session = { port, run };
          return run.start();
        })
        .then(() => {
          if (session && session.run && session.port === port) session = null;
        })
        .catch((error) => console.error(error));
    } else if (message.type === "stop") {
      if (session && session.run) session.run.stop();
    }
  });

  port.onDisconnect.addListener(() => {
    // 面板关闭即中止运行
    if (session && session.port === port) {
      if (session.run) session.run.stop();
      session = null;
    }
  });
});
