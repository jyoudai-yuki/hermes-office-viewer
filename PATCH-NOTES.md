# PATCH-NOTES · 本 fork 与上游的差异

本仓库是 [`xionglaoshi/hermes-office-viewer`](https://github.com/xionglaoshi/hermes-office-viewer)
的 fork，只加了一件事：**接管 Hermes 桌面端工作台文件树的双击**，让双击文档直接在本插件的
「文档预览」面板里打开，而不是落到官方预览器（那条链只认 html / image / pdf，`.docx` 出来是乱码）。

```
upstream  remote: https://github.com/xionglaoshi/hermes-office-viewer
origin    remote: https://github.com/jyoudai-yuki/hermes-office-viewer
```

## 补了什么

| 位置 | 内容 |
| --- | --- |
| `desktop/plugin.js` | 补丁段 `dblclick-interceptor-v1`（`TREE_INTERCEPT_EXTS` 及其下方全部），加 `register()` 里两行 `ctx.addEventListener(document, …)` |
| `tests/tree-interceptor.test.mjs` | 补丁的 Node 闸门（67 项） |

设计原则：**与上游的耦合面只有事件名一处**。拦截器不调用上游任何内部函数，只派发上游自己
的约定事件：

```js
window.dispatchEvent(new CustomEvent('hermes-office-open', { detail: { path } }))  // path 必须绝对路径
```

上游 `register()` 时已挂好该事件的监听，收到后自己 `revealPane` 并设当前文件。所以上游重构
内部实现不会打断补丁；只有改掉事件名或改掉工作台文件树的 `[data-project-tree]` / 行 `title`
标记才会失效，且失效表现是**退化为官方预览**，不会更坏。

## 接管哪些格式（别按 README 那张表）

白名单按上游内核**真实能力**取（`ENGINE_EXTS` + `md`），共 15 个：

```
docx doc xlsx xls csv pptx ppt wps et dps ofd rtf   +   md markdown mdx
```

上游 README 声称支持的 `odt / ods / docm / xlsm / pps / tsv / iWork / epub / 邮件` 等
**并没有接进内核分派**，拦过来只会落到查看器的「不支持」分支，比官方预览器的文本预览更差，
因此刻意排除。图片 / PDF / HTML / 纯文本与代码也一概放过（官方自己能处理，不抢）。

手势语义：单击放过（行仍能选中）；第二次单击与 dblclick 都会被吞掉，一次手势只打开一次；
**Alt+双击**是逃生门，交给官方预览器。

## 怎么验证

```bash
node tests/tree-interceptor.test.mjs        # 67 项，含白名单回归与端到端派发断言
```

闸门自证：写完就故意注入违规（把 `odt` 塞进白名单、把事件名改错）跑一次，确认 FAIL 再还原。
只断言「函数返回 true」的闸门会漏掉事件名写错这类静默失效。

## 怎么更新上游

```bash
git fetch upstream && git rebase upstream/main
git push origin main
bash install.sh          # Electron 按 mtime 自动重拷桌面半
```

rebase 冲突只会出现在 `desktop/plugin.js` 尾部（补丁区）与 `register()` 里那两行。

## 安装后的两个 App 侧步骤（桌面半是强制 opt-in，不做就不生效）

1. `⌘K` →「技能与工具」→「桌面插件」→ **重新扫描**
2. 打开「Office 查看器」开关 → `⌘R`（或重启桌面端）

## 已知的上游问题（本 fork 未改，改与不改都可）

- `plugin.yaml` 缺 `dashboard: api: plugin_api.py`，所以 `dashboard/plugin_api.py` 那三个
  兜底端点（`/list` `/dataurl` `/open`）**根本没挂载**，上游自己的 `beacon()` 探针也是死的
  （`/beacon` 端点不存在）。日常不影响（桌面桥可用）。要修就是 `plugin.yaml` 加一行。
- `hermes plugins validate` 会对随包携带的 2MB 内核报一批 `prototype patching` /
  `exec_string` caution。那是第三方压缩包的固有属性，不是补丁引入的。

## 许可

作者代码 MIT；随包携带的第三方组件（`@file-viewer/*` 预构建内核、pdf.js、marked、
老 `.ppt` 引擎 Flyfish Public Watermarked Runtime **非开源且要求保留水印**）各有条款，
再分发 / 商用前读 `THIRD-PARTY-NOTICES.md`。
