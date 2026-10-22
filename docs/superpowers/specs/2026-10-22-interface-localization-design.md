# H3 Prompt Writer 中英文界面切换设计

- 日期：2026-10-22
- 状态：已审阅，按计划实施
- 范围：Writer 界面文案与常见错误提示

## 1. 背景

H3 Prompt Writer 的所有界面文案目前是硬编码英文，没有 i18n 基础设施。ComfyUI 与 standalone 共用 `web/` 下的同一套前端，因此只需要在前端实现一次语言切换，两边同时生效。

## 2. 目标与非目标

### 2.1 目标

- 顶部工具栏提供 `Auto / English / 简体中文` 语言下拉，切换立即生效并持久化。
- 界面文案全部中文化：按钮、标签、设置、弹窗、toast、状态栏、工具提示、`aria-label`、`placeholder`。
- 常见错误按后端错误码显示中文摘要，原始英文消息与技术细节保留。
- 切换语言不重建界面、不发网络请求、不丢失用户输入与生成结果。
- standalone 与 ComfyUI 两种运行方式行为一致。

### 2.2 非目标

- 不翻译生成的 H3 提示词、Sequence 结果、Music 3 caption（官方格式要求英文）。
- 不翻译后端日志、Python 异常文本、模型 ID、文件名、路径、项目名。
- 不翻译 H3 引用语法标签（`Picture 1`、`Video 1`、`Audio 1`）与提示词内的时间轴/镜头标记。
- 不新增其他语言；`zh-CN` 与 `en` 之外一律回退英文。
- 不实现 ComfyUI 菜单命令标签的实时切换（见 11.1）。

## 3. 已确认决策

| 项目 | 决策 |
| --- | --- |
| 翻译范围 | 界面 + 常见错误提示 |
| 切换入口 | 顶部工具栏、主题按钮旁的原生 `<select>` |
| 默认值 | `Auto` |
| 实现方式 | 显式 i18n 层：`data-i18n` 标记 + `t()` + 就地翻译 |
| 错误展示 | 中文摘要来自错误码；技术细节保留英文 |
| 生成结果语言 | 始终英文 |

## 4. 架构

### 4.1 模块职责

| 文件 | 职责 |
| --- | --- |
| `web/i18n.js` | 唯一语言状态；解析、翻译、DOM 标记翻译、切换通知 |
| `web/locales/en.js` | 英文字典，key 的基准来源 |
| `web/locales/zh-CN.js` | 简体中文字典，key 集合必须与英文一致 |
| `web/studio_state.js` | 在用户偏好中新增 `language` 字段的读写 |
| `web/main.js` | 语言下拉；初始化 i18n；注册动态区域刷新回调 |
| 其他 `web/*.js` | 只调用 `t()` 或使用 `data-i18n*`，不保存语言状态 |

`i18n.js` 不直接读写 localStorage；持久化由 `main.js` 通过现有 `saveUserPreferences` 完成，避免 i18n 模块与业务状态耦合。

### 4.2 公共 API

```js
configureI18n({ preference, app, navigatorLanguage, root })  // 初始化；不通知监听器
getLanguagePreference()        // "auto" | "en" | "zh-CN"
getLocale()                    // "en" | "zh-CN"
setLanguagePreference(value)   // 解析、更新状态、设置 document 语言、translateDom(root)、通知监听器
t(key, params = {})            // 取当前语言文案，替换 {name} 占位符
translateDom(root)             // 翻译带 data-i18n* 标记的子树
onLocaleChange(listener)       // 返回取消订阅函数
msg(key, params = {})          // 生成 { key, params } 描述符，供需要跨切换重绘的位置保存
messageText(value)             // 描述符 → 当前语言字符串；普通字符串原样返回
localizedError(error, fallbackKey = "errors.UNKNOWN", params = {})
                               // 返回 { code, key, message, technical }
```

首屏 markup 先由 `createStudio()` 生成并插入 DOM，随后调用 `configureI18n`（内部翻译已存在子树），再显式调用 `translateDom(root)`；参数来自 `loadUserPreferences(localStorage)?.language || "auto"`。在生成 markup 之前，`createStudio()` 还会调用一次不带 `root` 的 `configureI18n` 以初始化语言状态；`setup()` 同样先以 `root: null` 初始化，之后再由 `createStudio()` 带 `root` 调用一次。

> `msg()` 只用于切换语言后仍要重绘的文案（toast、状态栏、浮动媒体面板状态）。一次性渲染且不会在切换后复用的文案直接调用 `t()`，不要保存描述符。

### 4.3 语言解析

偏好值只有三种：`auto`、`en`、`zh-CN`。非法值按 `auto` 处理。

`auto` 的解析顺序：

1. 读取 ComfyUI 设置 `app.ui.settings.getSettingValue("Comfy.Locale")`，整段 try/catch。
2. 取到非空字符串时：
   - 小写后以 `zh` 开头 → `zh-CN`；
   - 其他任何语言 → `en`（用户在 ComfyUI 中显式选择了非中文语言）；
3. 读不到、为空或抛错时（standalone 或无该设置）：
   - `navigator.language` 小写后以 `zh` 开头 → `zh-CN`；
   - 否则 → `en`。

`setLanguagePreference` 同时把 `document.documentElement.lang` 设置为 `zh-CN` 或 `en`。

### 4.4 持久化

- 在 `h3ps-preferences-v1` 中新增 `language` 字段，与 `theme`、`interface_size` 并列。
- `loadUserPreferences` 对缺失或非法值返回 `auto`；不提升版本号，旧数据自然兼容。
- `createStudioState` 新增 `language` 字段。
- 切换语言时由 `main.js` 更新 `studio.language` 并调用 `saveUserPreferences`。

## 5. 界面入口

在现有顶部工具栏的“主题切换”按钮之前插入语言下拉，其余控件顺序不变。

```html
<select class="h3ps-language-select" data-language
        title="Language" aria-label="Language">
  <option value="auto">Auto</option>
  <option value="en">English</option>
  <option value="zh-CN">简体中文</option>
</select>
```

- 三个选项标签固定不翻译：`Auto`、`English`、`简体中文`。
- `title` 与 `aria-label` 由当前语言翻译。
- 样式新增 `.h3ps-language-select`，高度、边框、圆角与现有头图标按钮一致，放在 `web/styles/shell.css`。
- `change` 处理顺序：更新 `studio.language` → `setLanguagePreference(value)` → `saveUserPreferences(localStorage, studio)`。

## 6. 文案标记规则

### 6.1 key 命名

- 扁平点号 key，小写分段，按区域前缀：`header.settings`、`mode.T2VA.title`、`toast.media_unavailable.title`。
- 错误码统一为 `errors.<CODE>`，例如 `errors.GENERATION_BUSY`。
- 参数占位符使用 `{name}`，例如 `toast.audio_added.message` = `"{reference}. Connect the downloaded WAV separately in H3."`。
- 英文是基准字典；中文缺 key 时回退英文；两边都缺时返回 key 本身，并用 `Set` 记录后只告警一次。

### 6.2 静态文案

| 用途 | 属性 |
| --- | --- |
| 文本内容 | `data-i18n="key"` |
| `title` | `data-i18n-title="key"` |
| `aria-label` | `data-i18n-aria-label="key"` |
| `placeholder` | `data-i18n-placeholder="key"` |

- 只有叶子元素可以带 `data-i18n`，翻译时设置 `textContent`。
- 带图标或子元素的按钮，文字放在内部 `<span data-i18n="key">`，图标不受影响。
- 含 `<em>`、`<b>` 等内联结构的文案，拆成多个 key，分别标记。

### 6.3 动态文案

- render 函数内的模板字符串改用 `t("key", { … })`。
- 随时间、数量、模型名变化的文案使用参数插值；插值值本身不翻译。
- 依赖状态的动态区域在语言切换时由 `onLocaleChange` 主动重算，见第 7 节。

### 6.4 不翻译清单

- `textarea`、`input` 的 `value` 与用户输入内容。
- `[data-output]` 中的生成结果与 `<pre data-seq-reader-text>` 中的 Sequence 结果。
- 模型 ID、模型文件名、目录、Ollama 模型名、API provider 名称与模型名。
- 后端返回的原始错误 `message`、`details`、日志字段。
- `Picture 1`、`Video 1`、`Audio 1` 等 H3 引用标签与提示词内部格式标记。

## 7. 切换刷新数据流

1. 用户在下拉中选中新值。
2. `main.js` 写入 `studio.language` 并持久化。
3. `setLanguagePreference(value)`：
   - 重新解析 `getLocale()`；
   - 更新 `document.documentElement.lang`；
   - `translateDom(root)` 翻译所有静态标记；
   - 按注册顺序调用 `onLocaleChange` 监听器。
4. 全程不重建 `root`、不重新挂载事件、不发网络请求。

### 7.1 动态区域刷新

- `main.js` 注册一个监听器，调用已有同步函数刷新当前可见区域：
  `syncWorkspace()`、`syncModeAvailability()`、`syncSelectedModelSourceLabel()`、`syncActiveModelSummary()`、`syncLifecycleActions()`、`syncProviderSettings()`、`syncRuntimeSummary()`、`syncThinkingAvailability()`、`syncContextAvailability()`、`syncAdvancedRuntimeControls()`、`syncOutputLengthMeta()`、`syncMusicSystemPromptSummary()`、`renderMedia(studio.mode)`。
- 实施时逐个核对其他会产生可见文案的 `sync*` / `render*` 函数，确保全部加入刷新调用；原则是复用已有渲染路径，不新增并行渲染路径。
- 媒体工具（`media_composer.js`、`media_editor.js`、`floating_media.js`）在创建时注册自己的 `onLocaleChange`，对自身子树执行 `translateDom` 并重跑本地 render 函数。
- 悬浮启动按钮不在 `root` 内，需单独注册监听器，刷新 `title` 与 `aria-label`。

### 7.2 toast 与状态栏

- `showToast` 保持位置参数签名，避免改动全部调用点：
  ```js
  showToast(title, message, details = null, action = null, options = {})
  ```
- `title`、`message`、`action.label` 接受字符串或 `msg(key, params)` 描述符。字符串在调用时求值，描述符保留到语言切换后再用 `messageText()` 渲染。
- `showToast` 内部把 `title`、`message`、`action.label` 的原始值保存到 `studio.toastSnapshot`；`writeToastContent` 负责按当前语言写入 DOM。
- 状态栏 `setGenerationState(state, label, detail)` 同样接受字符串或描述符，并保存 `generationSnapshot`；`writeStatusContent` 按当前语言重绘。
- 语言切换时由 `web/main.js` 的 `onLocaleChange` 监听器重绘当前 toast 与状态栏。
- `details` 是英文技术细节（由 `localizedError().technical` 得到），原样保留、不参与翻译。
- 若某条消息包含后端动态文本，只把动态值放进 `params` 或 `details`，不把整句英文塞进 key。

### 7.3 输入保护

- 翻译只写 `textContent` 与属性，不写任何 `value`。
- 不替换、不克隆 `textarea`、媒体节点、生成结果节点。
- 切换后焦点与光标位置保持不变。

## 8. 错误处理

### 8.1 错误码来源

后端已统一返回 `{ "error": { "code", "message", "details" } }`，前端 `readApiResponse` 会把 `code` 与 `details` 挂到 `Error` 上。不修改后端协议。

### 8.2 统一映射

新增：

```js
localizedError(error, fallbackKey = "errors.UNKNOWN", params = {})
// 返回 { code, key, message, technical }
```
- `code`：`error.code`（无则空串），用于排查与日志，不用于显示。
- `key`：实际命中的字典 key（`errors.<CODE>` 或 `fallbackKey`）。
- `message`：当前语言摘要。
- `technical`：原英文 `error.message`；存在 `error.details` 时追加格式化 JSON。
- 所有 toast 捕获错误的地方改用 `localizedError`，把 `message` 作为摘要，把 `technical` 放入“技术细节”。

### 8.3 前端本地错误码

- `web/api/response.js`：
  - 成功但响应非 JSON → `code = "INVALID_RESPONSE"`；
  - 失败但响应非 JSON → `code = "REQUEST_FAILED"`。
- `web/api/h3studio.js` 的 `request()` 捕获 `fetchApi` 抛出的异常：
  - 异常 `name === "TimeoutError"` → `code = "REQUEST_TIMEOUT"`；
  - 其他网络异常 → `code = "NETWORK_ERROR"`。
- `freeComfyVram`、`editMedia` 等绕过 `request()` 的调用同样补充这两类错误码，保证所有网络失败都能显示中文摘要。
- VRAM 交接已有稳定错误码（`COMFYUI_BUSY`、`WRITER_UNLOAD_TIMEOUT` 等），直接纳入字典。

### 8.4 覆盖范围

至少覆盖以下分组：

- 生成：`GENERATION_BUSY`、`INVALID_REQUEST`（含字段缺失、seed 非法等）、`INVALID_MODE`。
- 模型：`INVALID_PROJECTOR`、模型未找到/未就绪/文件缺失，以及 `ModelError` 系列。
- 供应商：API 鉴权、限流、超时、返回格式错误、连接失败；Ollama 与外部 llama.cpp 连接失败。
- 媒体：`INVALID_SESSION`、`INVALID_EDIT`、上传/编辑/重采样相关错误。
- VRAM：`COMFYUI_BUSY`、`COMFYUI_BECAME_BUSY`、`COMFYUI_RELEASE_TIMEOUT`、`COMFYUI_STATE_UNAVAILABLE`、`WRITER_UNLOAD_*`、`WRITER_HANDOFF_TIMEOUT`、`WRITER_PREPARATION_CANCELLED`。
- 前端：`NETWORK_ERROR`、`REQUEST_TIMEOUT`、`INVALID_RESPONSE`、`REQUEST_FAILED`、`UNKNOWN`。

后端新增错误码时若未翻译，界面仍可用通用中文摘要兜底；自动化测试会阻止漏翻合入。

## 9. 文件改动

### 9.1 新增

- `web/i18n.js`
- `web/locales/en.js`
- `web/locales/zh-CN.js`
- `tests/i18n.mjs`
- `tests/test_i18n_keys.py`

### 9.2 修改

- `web/main.js`：语言下拉、初始化、动态刷新注册、全部文案、toast/状态描述符。
- `web/settings.js`、`web/writer_controls.js`、`web/sequence_workspace.js`、`web/sequence_controller.js`、`web/media_composer.js`、`web/media_editor.js`、`web/floating_media.js`、`web/draft_files.js`：文案改用 `t()` 或 `data-i18n*`。
- `web/vram_handoff.js`：`AUTO_VRAM_TOOLTIP` 改为可翻译 key，错误码文案由 `localizedError` 统一处理。
- `web/api/h3studio.js`、`web/api/sequence.js`、`web/api/response.js`：本地错误补稳定错误码。
- `web/studio_state.js`：偏好新增 `language` 字段。
- `web/styles/shell.css`：语言下拉样式与窄屏适配。
- `tests/frontend_regressions.mjs`：引入 `tests/i18n.mjs`，补充切换与错误映射回归。

## 10. 测试

### 10.1 自动化

`tests/i18n.mjs`：

- 中英 key 集合完全一致、无空值。
- `t()` 插值正确；中文缺 key 回退英文；两边都缺返回 key。
- `auto` 解析：ComfyUI `zh` → 中文；ComfyUI `en`/其他语言 → 英文；读不到时浏览器 `zh` → 中文；再不行 → 英文。
- 偏好读写：`language` 写入 `h3ps-preferences-v1`；非法值回退 `auto`。
- `translateDom` 覆盖文本、`title`、`aria-label`、`placeholder`，且不修改 `textarea.value`、`[data-output]`、`<pre data-seq-reader-text>`。
- 切换语言只通知一次监听器，不调用 `fetch`。
- `localizedError`：已知码返回中文摘要与英文技术细节；未知码返回通用摘要且技术细节不丢。

`tests/frontend_regressions.mjs` 补充：

- 切换语言后 Brief、Lyrics、生成结果、媒体与草稿状态保持不变。
- toast 与状态栏描述符在切换后按新语言渲染。
- 悬浮启动按钮的 `title` 与 `aria-label` 随语言更新。

`tests/test_i18n_keys.py`：

- 扫描 `backend/` 中 `_error("CODE"`、`ModelError("CODE"`、`MediaError("CODE"`、`AssemblyError("CODE"`、`ContextPlanError("CODE"`、`SystemPromptError("CODE"` 的静态字面量错误码，断言 `zh-CN.js` 存在 `errors.CODE`。
- 动态错误码无法静态扫描，由运行期通用摘要兜底。

### 10.2 手动验收

- Windows 中文 + ComfyUI 中文：首次打开显示中文。
- ComfyUI 英文：首次打开显示英文。
- 顶部切换中文/English 立即生效；刷新页面后保持。
- 逐区检查：头部、模式、媒体、Brief/Lyrics、Refine、模型设置、Ollama/外部服务/API 供应商、设置面板、toast、错误提示。
- 输入到一半切换：文字、光标、媒体、生成结果不丢。
- 触发常见错误（未选模型、模型缺失、生成忙、API 限流/超时）：中文摘要 + 英文技术细节。
- standalone 打开：`Auto` 跟随浏览器语言。
- 全量回归：
  - `node --test tests/frontend_regressions.mjs`
  - `python -m pytest tests`

## 11. 边界与风险

### 11.1 ComfyUI 菜单命令

`app.registerExtension` 的 `commands` / `menuCommands` 标签在页面加载时注册一次。语言切换后这两个入口保持加载时语言，刷新页面后更新；Writer 内部界面全部实时更新。

### 11.2 第三方内容

Ollama 模型名、API provider 模型名、后端返回的技术细节保持英文，不做机器翻译。

### 11.3 未翻译错误码

后端或模型层新增未登记的错误码时，界面显示“操作失败”并保留英文技术细节，不影响功能；测试会在合入前发现路由层与已知异常构造器的漏翻。

### 11.4 语言设置缺失

旧版本用户没有 `language` 偏好时按 `auto` 处理，不写回存储，直到用户首次切换语言。

### 11.5 生成进行中切换

切换只改变显示层，不中断请求，不改变最终生成结果。

### 11.6 已知限制

1. **生成耗时后缀**：`.h3ps-editor-meta` 的耗时信息由 `formatGenerationMeta` 在生成完成时写入；`syncOutputLengthMeta` 在语言切换时只重算长度前缀，耗时后缀保持上一次生成时的语言，直到下一次生成。切换瞬间该行可能中英混排。
2. **前端校验消息的位置**：`sequence_workspace` / `sequence_controller` 生成的前端校验与引导消息经 `t()` 本地化后，会出现在错误 toast 的“技术细节”行，因此该行可能同时包含中文引导和英文后端原文。后端原始 `message` / `details` 始终保留英文。
3. **一次性提示**：媒体工具通过 `notify()` 弹出的 toast 在触发时已求值，切换语言不会追溯改写已经显示的那一条；下一次触发使用新语言。生成完成提示的 message 由多个描述符在调用时拼接成字符串，同样不会追溯重译。`media.float` 收到的原始失败文本（`error.message`）保持原样，直到下一次通知。
4. **已关闭的历史 toast**：只有当前可见的 toast 与状态栏会随语言切换重绘；已经关闭的消息不再重建。
