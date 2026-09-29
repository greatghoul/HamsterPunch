# Hamster Punch

Your little hamster assistant for tracking daily sign-ins in the browser.

一个基于 **Manifest V3** 的 Chrome 侧边栏（Side Panel）扩展：用 JSON 编写动作序列，一键 **Punch**（= 执行）完成网页签到。

## 功能

- 点击工具栏图标即可打开侧边栏
- 用 JSON 编写动作序列（签到脚本），动态执行网页签到/打卡流程
- 脚本数据保存在 IndexedDB，运行结果带步骤级状态与日志
- 自动跟随浏览器语言显示界面文案

## 支持的语言

| 语言 | 代码 | 目录 |
| --- | --- | --- |
| English | `en` | `_locales/en/` |
| 简体中文 | `zh_CN` | `_locales/zh_CN/` |
| 繁體中文 | `zh_TW` | `_locales/zh_TW/` |
| 日本語 | `ja` | `_locales/ja/` |
| 한국어 | `ko` | `_locales/ko/` |

英文为默认语言（`manifest.json` 中的 `default_locale`）。Chrome 会按浏览器界面语言自动选择，找不到对应语言时回退到英文。

## 安装（开发者模式）

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目文件夹
4. 点击工具栏上的仓鼠图标，侧边栏就会打开

> 侧边栏需要 Chrome 116 及以上版本（签到脚本用到 `chrome.sidePanel.open`）。

## 目录结构

```
manifest.json          # MV3 清单；权限：sidePanel / storage / tabs / activeTab / scripting + host_permissions
background.js          # Service Worker：侧边栏入口 + 运行会话管理
executor.js            # 签到脚本运行引擎（由 background.js importScripts 引入）
lib/db.js              # 签到脚本的 IndexedDB 封装（面板侧使用）
sidepanel.html         # 侧边栏页面（列表 / 编辑 / 运行 三个视图）
sidepanel.css          # 侧边栏样式（支持深色模式）
scripts-ui.js          # 侧边栏逻辑：列表 / 编辑 / 运行 + JSON 校验 + i18n 辅助函数（t / $）
_locales/<lang>/messages.json   # 各语言文案
tools/demo-site.html   # 本地模拟签到页（联调用）
tools/make_icons_from_image.py  # 图标生成脚本
assets/icon-source.png # 图标原图
icons/                 # 16 / 32 / 48 / 128 图标（由脚本生成）
```

## 签到脚本

侧边栏中可以管理一组用 JSON 编写的动作序列。脚本**不包含可执行代码**，只是声明式的步骤列表，由扩展内置的引擎动态执行；数据保存在浏览器的 **IndexedDB**（DevTools → Application → IndexedDB → `hamsterpunch`）。

### 示例

```json
[
  { "name": "打开签到页（后台标签页）", "action": "open", "url": "https://example.com/mission/daily" },
  { "name": "等按钮出现", "action": "waitForElement", "selector": "#signin-btn", "timeout": 8000 },
  { "name": "点击签到", "action": "click", "selector": "#signin-btn" },
  { "name": "等结果", "action": "wait", "ms": 2000 },
  { "name": "确认成功", "action": "assert", "selector": ".success-msg", "textContains": "已签到" },
  { "name": "关闭标签页", "action": "close" }
]
```

### 动作一览

所有步骤都支持 `name`（展示名）和 `optional: true`（该步失败时跳过而不中断整个脚本）。

| action | 必填 | 可选 | 说明 |
| --- | --- | --- | --- |
| `open` | `url` | `newTab`（默认 true）、`active`（默认 false，仅 newTab）、`loadTimeout`（默认 20000） | 默认打开新标签页（后台）并成为后续步骤的目标；`newTab: false` 在当前目标标签页内导航 |
| `waitForElement` | `selector` | `timeout`（默认 10000）、`interval`（默认 500） | 轮询等待元素出现 |
| `wait` | `ms`（0–300000） | | 固定等待 |
| `click` | `selector` | `index`（默认 0）、`timeout`（默认 10000） | 先等元素出现，再派发点击 |
| `input` | `selector`、`value` | `timeout` | 填写输入框，派发 `input` / `change` 事件（兼容 React 受控组件） |
| `press` | `key`（如 `Enter`） | `selector` | 对指定元素（或当前焦点元素）派发按键事件 |
| `scroll` | `to`：`top` / `bottom` / `selector` / `y` | `selector`、`y`、`behavior` | 滚动页面 |
| `assert` | `selector` | `textContains`、`timeout`（默认 5000） | 校验元素存在（可选包含指定文本），失败即脚本失败 |
| `extract` | — | `selector`（缺省取页面标题）、`attr`、`label` | 提取文本/属性值，写入运行日志 |
| `close` | — | | 关闭当前目标标签页（脚本结束的收尾动作） |

### 执行模型与权限

manifest 声明了 `tabs` + `scripting` + `host_permissions: ["<all_urls>"]`（安装时 Chrome 会提示"读取和更改您在所有网站上的数据"），并保留 `activeTab` 作兜底。由此：

- 任何 http(s) 标签页都能注入，**包括后台新开的标签页**——脚本可以 `open` 后直接在其上等待、点击，全程自动，没有暂停/续跑；
- `open` 默认在后台标签页执行签到，不打扰你当前浏览的页面；配 `close` 收尾，跑完不留标签页；
- 浏览器内置页（`chrome://`、应用商店等）无法注入，相关步骤会明确报错；
- 如果你在 Chrome 设置里限制了本扩展的站点访问权限，点击工具栏图标可对当前页临时授权（`activeTab` 兜底），保证手动场景始终可用；
- 侧边栏关闭（或点「停止」）会中止当前运行；同一时间只允许一个运行。

### 本地联调

`tools/demo-site.html` 是一个模拟签到页（按钮延迟 2 秒出现，点击后 1.5 秒显示「已签到」，含输入框和长页面）：

```bash
cd tools
python -m http.server 8000
```

在**任意普通网页**上点击工具栏图标打开侧边栏 → 新建脚本（编辑器会预填模板）→ 把模板里的 `url` 改成 `http://localhost:8000/demo-site.html` → 保存 → 「运行」。脚本会在后台标签页完成 填昵称 → 签到 → 校验 → 关闭标签页 的全流程，不需要你停在演示页上。

## 重新生成图标

图标是从 `assets/icon-source.png` 自动生成的（切圆角 + 导出四个尺寸）：

```bash
python tools/make_icons_from_image.py
```

想换图标时，把新图放到 `assets/icon-source.png`（方形、越大越好）重跑即可；
圆角比例可以在脚本顶部的 `CORNER_RATIO` 里调。

## 国际化怎么用

**在 manifest.json 里**，用 `__MSG_键名__`：

```json
"name": "__MSG_extName__"
```

**在 JS 里**，用 `chrome.i18n.getMessage`：

```js
const text = chrome.i18n.getMessage("greeting");
```

HTML 标签里不能直接写 `__MSG_`，所以 `scripts-ui.js` 在页面加载后统一填充文案。

## 新增一种语言

1. 复制 `_locales/en/` 为 `_locales/<语言代码>/`（语言代码用下划线，如 `pt_BR`）
2. 翻译 `messages.json` 里每个 `message` 的值，**不要改动键名**
3. 重新加载扩展，把浏览器语言切到该语言即可看到效果

## License

MIT
