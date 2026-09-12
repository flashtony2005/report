# OpenPrint → React 重构迁移方案

> 版本：v1.1 ｜ 日期：2026-09-08  
> 目标：把 `openprint26` 的设计器 UI 层从 Vue 3 迁移到 React，核心渲染引擎零改动复用。  
> 策略：**先迁 stores + core 集成层跑通骨架，再逐块迁画布和面板。**



---


## 〇、开源替代方案调研（先看有没有现成的轮子）

调研时间 2026-09-08，检索 GitHub 上的 React 打印/标签/报表设计器。**结论：没有能直接替代 OpenPrint 的现成项目，但有一个值得抄架构的。**

| 项目                                   | Stars                | License               | 活跃度                               | 判定                        |
| ------------------------------------ | -------------------- | --------------------- | --------------------------------- | ------------------------- |
| **pdfme** `pdfme/pdfme`              | **4,809** / fork 514 | **MIT**               | 活跃（2026-09-01 push，1,568 commits） | ⚠️ 不能替代，**但架构与技术选型值得抄**   |
| `chengyihua/print-designer`          | —                    | **CC BY-NC 4.0（非商用）** | 40 commits，2026-01                | ❌ 排除，授权不允许商用              |
| `jafranjemal/aavanamkit`             | **3**                | MIT                   | 停滞（2025-08 最后一次 push）             | ❌ 排除，无人使用                 |
| `anirbansanu/invoice-label-designer` | **1**                | 无 LICENSE 文件          | 停滞（2026-03）                       | ❌ 排除，README 与代码疑似 AI 批量生成 |
| `qrlayout-core` / `qrlayout-ui`      | —                    | —                     | 新品                                | ❌ 只做 QR 标签，场景太窄           |

### 为什么 pdfme 不能替代 OpenPrint

| 维度   | pdfme                                 | OpenPrint              | 差异           |
| ---- | ------------------------------------- | ---------------------- | ------------ |
| 模板模型 | `basePdf` + `schemas`（**固定页**，每页一组字段） | 内容驱动，**自动分页**          | 根本性差异        |
| 表格   | 官方 schema 无 table                     | flow table、跨页表头重复、汇总尾  | pdfme 需自己写插件 |
| 带区   | 无                                     | 页眉/正文/页脚 zone，高度变化自动重排 | pdfme 无此概念   |
| 输出   | PDF 为主                                | HTML / PDF / JPG / SVG | —            |
| 定位   | 「表单填充式」PDF 生成                         | 「面单/标签/报表」打印设计         | 场景不同         |

pdfme 适合"给一张固定版式填数据出 PDF"；OpenPrint 适合"数据多少行不确定、要自动分页出纸"。**两者不是同一个东西。**

### 但 pdfme 有三大可抄之处

1. **设计器 UI 技术栈**（已被 4.8k star 验证，正好是本文 P2/P3 的选型）：
   - `react-moveable` — 缩放/旋转手柄
   - `react-selecto` — 框选
   - `@scena/react-guides` — 标尺 + 吸附辅助线
   - `dnd-kit` — 拖拽
   - `antd` + `form-render` — 属性面板（schema 驱动，比手写 17 个 props 组件省一半工）
2. **插件架构**：pdfme 的 plugin = `{ pdf, ui, propPanel }` 三元组，与 OpenPrint 的 `controls/PrintXxx.ts` + `panels/props/XxxProps.vue` 是同构的，可直接借鉴其接口划分。
3. **UI/引擎解耦范式**：`@pdfme/generator`（纯 TS）与 `@pdfme/ui`（React）分包，与本文 `packages/engine` + `apps/designer-react` 方案一致。

> **对工期的影响**：属性面板（P3，原估 6 人日）若改用 `form-render` schema 驱动，可压到 **3～4 人日**；画布交互（P2）若改用 `react-moveable` + `react-selecto` 组合替代手写 Fabric 手柄，可压到 **3～4 人日**。**总计可省约 4～5 人日**（25～30 → 20～25）。

### ⚠️ 顺带发现：许可证不一致

Gitee 上的 OpenPrint 镜像仓库（`haiming236/openprint`）标注的是 **AGPL-3.0**，而本地 `package.json` 与 README 徽章写的是 **GPL-3.0**。AGPL 的「网络使用视为分发」条款比 GPL 严格得多，直接影响商业化。**建议尽快确认主仓库的真实许可证口径**，这比技术迁移的风险更高。

---

## 一、结论摘要

| 项     | 结论                                                                                   |
| ----- | ------------------------------------------------------------------------------------ |
| 可行性   | ✅ 高。项目已做到「引擎 / UI 分离」，核心层纯 TS 无框架依赖                                                  |
| 可直接复用 | ~23,000 行（约 55%）—— `core/`、`repository/`、`types/`、`ai/`、`config/`、`utils/`、13 个画布控件类 |
| 必须重写  | ~15,500 行（约 37%）—— 42 个 `.vue` 组件 + 4 个 Pinia store                                  |
| 需适配   | ~3,500 行（约 8%）—— Fabric 集成壳、tiptap、CodeMirror、UnoCSS 配置                              |
| 预估工期  | **20～30 人日**（1 人 5～6 周 / 2 人 3～4 周）                                                  |
| 最大风险  | 画布交互回归（拖拽、辅助线、快捷键、undo/redo），单测覆盖不到，靠人工验证                                            |

**一句话建议**<u>：这个项目不重写也能在 React 里用（SDK 渲染 + Web Components/iframe 嵌入）；若团队确实统一 React 技术栈，按本方案迁移成本可控，因为</u>**最值钱的 10,000 行排版引擎一行都不用动**<u>。</u>

---

## 二、现状盘点


### 2.1 代码量分布（src/，共 222 文件 / 42,033 行）

| 目录                                         | 行数         | 文件  | 框架耦合  | 迁移处理                             |
| ------------------------------------------ | ---------- | --- | ----- | -------------------------------- |
| `core/layout-engine/`                      | 5,159      | 30+ | 零     | ✅ 原样复用                           |
| `core/print-client/`                       | 1,538      | 12  | 零     | ✅ 原样复用                           |
| `core/export-engine/`                      | 1,000      | 12  | 零     | ✅ 原样复用                           |
| `core/renderer-html/`                      | 838        | 10  | 零     | ✅ 原样复用                           |
| `core/chartkit/`                           | 635        | 7   | 零     | ✅ 原样复用                           |
| `core/fonts/`                              | 441        | 5   | 零     | ✅ 原样复用                           |
| `core/headless/`                           | 259        | 3   | 零     | ✅ 原样复用                           |
| `core/mathkit/`、`sdk/`、`spec/`、`units.ts`  | ~500       | 8   | 零     | ✅ 原样复用                           |
| `repository/`                              | ~2,500     | 12  | 零     | ✅ 原样复用                           |
| `ai/`、`config/`、`types/`、`utils/`、`theme/` | ~2,600     | 25  | 零     | ✅ 原样复用（除 `theme/naive-theme.ts`） |
| **`design/`（42 .vue）**                     | **13,297** | 42  | **强** | ⚠️ **重写**                        |
| **`design/`（46 .ts）**                      | **8,144**  | 46  | 中～零   | 部分复用（见下）                         |


### 2.2 `design/` 内部拆解

**完全不用改（纯 Fabric / 纯算法，无 Vue import）：**

- `canvas/CanvasDesigner.ts`（1,121 行）— 画布内核，只依赖 `fabric`
- `canvas/controls/*.ts`（16 个 PrintXxx 控件，约 5,500 行）— PrintText / PrintTable / PrintBarcode / PrintQrcode / PrintImage / PrintRect / PrintCircle / PrintLine / PrintRichText / PrintMath / PrintSignature / PrintLabelGrid / PrintChart / PrintZone / PrintObject / index
- `canvas/guides/SmartGuides.ts`、`canvas/rulers/*`、`page-gap.ts`、`page-geometry.ts`、`zoom.ts`、`table-design-render.ts`、`barcode-draw.ts`、`table-style-presets.ts`

**需要重写（Vue 组件）：**

| 分组   | 文件                                                                                                                                                                                                                                      | 说明   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 画布壳  | `CanvasStage.vue`、`CellToolbar.vue`、`ChartViewLayer.vue`、`MathViewLayer.vue`、`TableViewLayer.vue`                                                                                                                                       | 5 个  |
| 面板   | `LeftPanel`、`RightPanel`、`LayerPanel`、`ControlLibrary`、`DataSourceTree`、`DatabaseExplorer`、`SignaturePadModal`                                                                                                                          | 7 个  |
| 属性面板 | `props/` 17 个：BindingEditor、ChartProps、CodeProps、CommonProps、ContentValueEditor、ExpressionModal、ImageProps、LabelGridProps、MathProps、RichTextEditor、RichTextProps、ShapeProps、SignatureProps、TableProps、TextProps、VariableModal、ZoneProps | 17 个 |
| 弹窗   | `modals/` 8 个：DataImportModal、FlowLabelModal、JsonViewerModal、PrintDialog、SettingsModal、TableStylePickerModal、TemplateMarket、TemplateModal                                                                                               | 8 个  |
| 工具栏  | `TopToolbar.vue`、`ExportDialog.vue`                                                                                                                                                                                                     | 2 个  |
| 预览   | `PreviewPanel.vue`（+ `preview-data.ts` 可复用）                                                                                                                                                                                             | 1 个  |
| 其他   | `App.vue`(74行)、`ai/AiAssistantPanel.vue`                                                                                                                                                                                                | 2 个  |

### 2.3 状态管理层

| Store           | 行数    | 迁移难度 | 说明                                              |
| --------------- | ----- | ---- | ----------------------------------------------- |
| `designer.ts`   | 1,283 | 中    | 核心 store：模板模型 / 选中态 / 画布挂载 / 增删改 / undo-redo 埋点 |
| `dataSource.ts` | 416   | 低    | 数据源树、ERP/Mock 切换                                |
| `ui.ts`         | 159   | 低    | 面板折叠、弹窗开关等 UI 态                                 |
| `history.ts`    | 97    | 低    | 命令栈 undo/redo，纯逻辑                               |

### 2.4 依赖耦合点

- **Naive UI**：62 个 `N*` 组件被使用 → 必须替换
- **UnoCSS**：框架无关 ✅ **可保留**（只需 `@unocss/preset-uno`，无需换 Tailwind）
- **Vitest + happy-dom**：✅ 可保留，49 个 spec 中 40+ 属 core 层，直接跑
- **@tiptap/vue-3** → `@tiptap/react`（仅 2 个文件：RichTextEditor、RichTextProps）
- **vue-codemirror6** → `@uiw/react-codemirror`（仅 CodeProps 使用）
- **VueUse** → `ahooks` 或手写

---

## 三、目标架构

### 3.1 Monorepo 结构（推荐 pnpm workspace，项目已有 `pnpm-workspace.yaml`）

```
openprint/
├─ packages/
│  └─ engine/              ← 从 src/ 整体迁入，零框架依赖
│     ├─ core/             layout-engine / export-engine / renderer-html /
│     │                    chartkit / fonts / headless / mathkit / print-client
│     ├─ types/  utils/  ai/  config/  repository/
│     └─ index.ts          （原 src/sdk/index.ts）
│
├─ apps/
│  ├─ designer-vue/        ← 现有 Vue 设计器（保留，逐步退役）
│  └─ designer-react/      ← 新增 React 设计器
│     ├─ src/
│     │  ├─ stores/        zustand：designer / history / ui / dataSource
│     │  ├─ canvas/        CanvasDesigner.ts（复制）+ CanvasStage.tsx
│     │  │  └─ controls/   16 个 PrintXxx.ts（复制）
│     │  ├─ panels/  props/  modals/  toolbar/  preview/
│     │  ├─ hooks/         useHotkey / useDragAdd / useConfirm / usePrinterProbe
│     │  └─ App.tsx
│     └─ vite.config.ts
```

**关键点**：`packages/engine` 是**单一数据源**，Vue 与 React 双端共享。迁移期两版并存，React 版通过 UI 回归后 Vue 版下线。


### 3.2 依赖替换映射

| Vue 生态                 | React 方案                             | 备注                                       |
| ---------------------- | ------------------------------------ | ---------------------------------------- |
| Vue 3 `<script setup>` | React 19 + TSX                       |                                          |
| Pinia 4                | **Zustand 5**                        | 命令式 API 最接近，store 逻辑几乎直译                 |
| Naive UI 2.44          | **Ant Design 5**                     | 组件覆盖度最高；或 shadcn/ui（更轻，但需自己拼 Table/Tree） |
| `@tiptap/vue-3`        | `@tiptap/react`                      | 内核共用，仅换 EditorContent                    |
| `vue-codemirror6`      | `@uiw/react-codemirror`              | CodeMirror 6 内核共用                        |
| `@vueuse/core`         | `ahooks`                             |                                          |
| UnoCSS 66              | UnoCSS（保留）                           | 加 `presetAttributify` 可选                 |
| vue-tsc                | tsc                                  |                                          |
| Vitest 3 + happy-dom   | Vitest（保留）+ `@testing-library/react` |                                          |

### 3.3 Store 迁移映射（Pinia setup store → Zustand）

```ts
// Vue:  const x = ref(0)              → React: x: 0
// Vue:  const y = computed(() => …)   → React: 派生 selector + useMemo，或 immer 中间层
// Vue:  function add() { … }          → React: add: () => set(s => …)
// Vue:  shallowRef(CanvasDesigner)    → React: 放在 store 外（模块级变量）或 useRef
```

**注意**：`designer.ts` 里 `designer = shallowRef<CanvasDesigner|null>` 是**刻意非响应式**的（避免深度代理 Fabric 对象）。React 下用模块级变量或 `useRef` 同样处理，**不要塞进 Zustand state**，否则 Fabric 对象会被冻结/代理出问题。

---

## 四、分阶段实施路线

### Phase 0 · 准备（2 人日）

| #   | 任务                                                                                                    | 产出                                              |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0.1 | 抽 `packages/engine`：`core/` `types/` `utils/` `ai/` `config/` `repository/` 整体移入，保留 `@/` alias 与 spec | engine 包 `vitest` 全绿                            |
| 0.2 | 建 `apps/designer-react`：Vite + React 19 + TS + UnoCSS + antd                                          | `npm run dev` 出空白页                              |
| 0.3 | 配 alias `@engine/*` → `packages/engine/*`，Vitest 复用 happy-dom                                         | React 端能 `import { render } from '@engine/sdk'` |

**验收**：React 端调用 `render({template, data})` 能在页面渲染出 HTML 打印预览 → **证明引擎层打通**。


### Phase 1 · 状态层迁移（3 人日）— 骨架核心

| #   | 任务                                          | 说明                                                          |
| --- | ------------------------------------------- | ----------------------------------------------------------- |
| 1.1 | `history.ts` → `stores/history.ts`（zustand） | 97 行，几乎直译，最先做，风险最低                                          |
| 1.2 | `ui.ts` → `stores/ui.ts`                    | 159 行                                                       |
| 1.3 | `dataSource.ts` → `stores/dataSource.ts`    | 416 行                                                       |
| 1.4 | `designer.ts` → `stores/designer.ts`        | 1,283 行，重点。剥离 `attachCanvas/detachCanvas` 里的 Vue 生命周期，改为纯函数 |
| 1.5 | 补 store 单测：模型增删改、选中、undo/redo               | 无 DOM 依赖，Node 环境跑                                           |

**验收（骨架跑通标志）**：

- ✅ 纯 Node 环境下：新建模板 → addControl → updateControl → undo → redo → buildTemplate() 输出的 `TemplateData` 与 Vue 版**逐字段深比对一致**
- ✅ `buildTemplate()` 结果喂给 `render()` 能出正确 HTML

> **此时还没有任何 UI，但数据层已经完整可用。** 这是整个迁移最关键的安全网。

### Phase 2 · 画布内核（5 人日）

| #   | 任务                                                                                           | 工作量                  |
| --- | -------------------------------------------------------------------------------------------- | -------------------- |
| 2.1 | 复制 `CanvasDesigner.ts`（1,121 行）+ 16 个 `controls/*.ts` + guides/rulers/page-gap/page-geometry | 0.5 日（复制 + 改 import） |
| 2.2 | `CanvasStage.vue` → `CanvasStage.tsx`：`useEffect` 挂载、attach/detach、resize 观察                 | 1 日                  |
| 2.3 | `ChartViewLayer` / `MathViewLayer` / `TableViewLayer` / `CellToolbar` → tsx                  | 1.5 日                |
| 2.4 | 视口同步：zoom / offset / 选中回显 / 页码变化回调接入 zustand                                                 | 1 日                  |
| 2.5 | 画布交互回归：拖拽、缩放手柄、多选、框选、辅助线、页边距                                                                 | 1 日                  |

**验收**：能拖入各类控件、选中后 store 正确更新、缩放平移正常、页数随内容推导正确。


### Phase 3 · 面板与属性编辑（6 人日）

| #   | 任务                                                                                                                                                                     | 说明                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 3.1 | `LeftPanel` + `ControlLibrary`（控件库拖拽源）                                                                                                                                 | 配合 `useDragAdd`     |
| 3.2 | `RightPanel` + `LayerPanel`（图层树、上下移）                                                                                                                                   | antd Tree 替代 n-tree |
| 3.3 | `CommonProps`（位置/尺寸/边框）→ 所有控件通用，先做                                                                                                                                     | 打通「面板编辑 → 画布回显」闭环   |
| 3.4 | `props/` 其余 16 个：Text / Table / Image / Shape / Barcode / Qrcode / LabelGrid / Chart / Math / Signature / Code / Zone / Binding / ContentValue / Variable / Expression | 逐个迁移逐个验             |
| 3.5 | `RichTextEditor`：`@tiptap/vue-3` → `@tiptap/react`                                                                                                                     | 富文本控件               |
| 3.6 | `DataSourceTree` + `DatabaseExplorer`                                                                                                                                  | 数据源绑定面板             |

**验收**：14 种控件类型全都能编辑属性并实时反映到画布；数据绑定（Mustache 表达式）可用。

### Phase 4 · 工具栏 / 弹窗 / 预览 / 打印（5 人日）

| #   | 任务                                                                 |
| --- | ------------------------------------------------------------------ |
| 4.1 | `TopToolbar`：新建/保存/撤销重做/缩放/网格/页面设置                                 |
| 4.2 | `TemplateModal`、`TemplateMarket`、`SettingsModal`、`JsonViewerModal` |
| 4.3 | `DataImportModal`（Excel 导入）+ `FlowLabelModal`（流水标签批量）              |
| 4.4 | `PreviewPanel` + `ExportDialog`（PDF/JPG/SVG/HTML 导出）               |
| 4.5 | `PrintDialog` + `usePrinterProbe`（云打印 / 本地客户端）                     |
| 4.6 | `TableStylePickerModal`、`SignaturePadModal`（签名手写）                  |

**验收**：全链路走通 —— 导入 Excel → 生成流水标签 → 逐条预览 → 批量打印 → 导出 PDF。

### Phase 5 · 打磨与回归（4～6 人日）

| #   | 任务                                                         |
| --- | ---------------------------------------------------------- |
| 5.1 | 快捷键（`useHotkey`）：Ctrl+Z/Y、Delete、方向键微调、Ctrl+D 复制、Ctrl+G 成组 |
| 5.2 | `useDragAdd` 拖拽新增、`useConfirm` 二次确认                        |
| 5.3 | 49 个 spec 全绿 + 新增 React UI 冒烟测试（Playwright 可选）             |
| 5.4 | 截图与 Vue 版逐屏对比，视觉对齐；主题/品牌色（`theme/brand.css`）复用             |
| 5.5 | 性能：大模板（100+ 控件）渲染与拖拽帧率验证                                   |
| 5.6 | Vue 版下线，`apps/designer-vue` 转只读存档或删除                       |

---

## 五、关键技术难点与解法

### 5.1 Fabric.js 与 React 的集成

- **难点**：Fabric 直接操作 DOM canvas，与 React 的声明式渲染冲突；`CanvasDesigner` 内部持有大量可变状态。
- **解法**：**不要在 React 里声明式渲染 Fabric 对象**。保持现有命令式内核，`CanvasStage.tsx` 只做三件事：`useEffect` 挂载 → `designer.attachCanvas()`；`useEffect(() => detachCanvas, [])` 卸载；用 **store subscribe（非 re-render）** 把模型变更推给内核。
- **坑**：React 18 StrictMode 下 `useEffect` 会执行两次 → 必须保证 `attach/detach` 幂等，或先关掉 StrictMode。

### 5.2 撤销 / 重做

- `history.ts` 是纯命令栈，迁移最省。
- **坑**：Vue 的 `ref` 深响应式让 `undo: () => (controls.value = prev)` 天然生效；Zustand 下需显式 `set({ controls: prev })`，且 `prev` 必须是**快照深拷贝**，否则 Fabric 修改会污染历史。建议沿用现有 `JSON.parse(JSON.stringify())` 或引入 `immer` + `enablePatches`。

### 5.3 坐标单位与画布换算

- 模型坐标单位 = **mm**（协议层），画布 px 换算由 `CanvasDesigner` 负责。迁移时**不要动这一层**，否则模板 JSON 协议会不兼容。

### 5.4 按需加载分包

SDK 现有策略：条码（bwip-js）、二维码（qrcode）、公式（KaTeX）、jspdf / opentype 按需动态 import。React 端用 `React.lazy` + `dynamic import` 保持同样策略，避免首屏体积回退。

### 5.5 富文本 / 公式 / 图表

- tiptap：`@tiptap/react` 的 `EditorContent` + `useEditor`，扩展（FontFamily / TextStyle / StarterKit）共用。
- KaTeX 公式、chartkit 图表：**纯 core 层，零改动**。

### 5.6 测试策略

- 40+ 个 core spec：随 `packages/engine` 一起搬，**零改动复用**。
- 新增：store 层单测（Node 环境，快）、关键 UI 交互冒烟（happy-dom / Playwright）。
- **人工回归清单**（单测覆盖不到）：拖拽吸附、辅助线、多选变换、打印预览分页、导出 PDF 字体嵌入、Excel 导入字段映射。

---

## 六、工期与人力估算

| 阶段                | 人日  | 累计        | 交付物                              |
| ----------------- | --- | --------- | -------------------------------- |
| Phase 0 准备        | 2   | 2         | engine 包 + React 骨架跑通 render     |
| Phase 1 状态层       | 3   | 5         | zustand stores + 单测全绿（**骨架里程碑**） |
| Phase 2 画布        | 5   | 10        | 可拖拽设计的画布                         |
| Phase 3 面板        | 6   | 16        | 属性编辑闭环                           |
| Phase 4 工具栏/弹窗/打印 | 5   | 21        | 全链路功能完整                          |
| Phase 5 打磨回归      | 4～6 | **25～30** | 生产可用                             |

- 1 人：约 5～6 周
- 2 人并行（一人画布、一人面板）：约 3～4 周
- 上述**不含**新功能开发，纯 1:1 迁移

---

## 七、风险控制

| 风险                     | 等级 | 应对                                                                     |
| ---------------------- | -- | ---------------------------------------------------------------------- |
| 画布交互回归遗漏               | 高  | 先录 Vue 版操作视频做基线；每迁一个控件立即对照                                             |
| Fabric 对象被 React 状态代理  | 中  | Fabric 实例一律放 store 外 / useRef，不进 zustand                               |
| 模板 JSON 协议漂移           | 中  | `core/spec/validator.ts` 的 `assertTemplate` 作为迁移期黄金校验，Vue/React 双向交叉验证 |
| antd 与 naive-ui 组件语义差异 | 中  | Phase 0 先做组件映射表，树/表格/抽屉逐个确认                                            |
| 迁移期两版代码分叉              | 中  | `packages/engine` 单一数据源，双端共用；Vue 版冻结新功能                                |
| 按需加载失效导致体积暴涨           | 低  | Phase 5 用 `rollup-plugin-visualizer` 对比 Vue 版产物体积                      |

---

## 八、替代方案（若工期/人力不允许全量重写）

| 方案                                | 成本       | 适用                                     |
| --------------------------------- | -------- | -------------------------------------- |
| **A. SDK 渲染 + iframe 嵌入 Vue 设计器** | 1～2 人日   | React 项目只需「填数据 → 出打印件」，不需要深度定制设计器      |
| **B. Web Components 包装 Vue 设计器**  | 3～5 人日   | 需要在 React 页面内嵌完整设计器，可接受 Vue runtime 共存 |
| **C. 微前端（qiankun / single-spa）**  | 5～8 人日   | 已有多个子应用，设计器作为独立子应用接入                   |
| **D. 全量 React 重写（本方案）**           | 25～30 人日 | 团队全面 React、需长期深度维护设计器源码                |

---

## 九、立即可以开始的第一步

```bash
# 1. 抽 engine 包（Phase 0.1）
mkdir -p packages/engine
git mv src/core src/types src/utils src/ai src/config src/repository packages/engine/
git mv src/sdk/index.ts packages/engine/index.ts

# 2. 建 React 应用（Phase 0.2）
pnpm create vite apps/designer-react --template react-ts
cd apps/designer-react && pnpm i zustand antd

# 3. 打通验证（Phase 0.3 验收标准）
#    React 端 import { render } from '@engine' → 渲染出打印 HTML
```

**建议先只做 Phase 0 + Phase 1（5 人日）**，拿到「状态层跑通、核心引擎复用」的实证后，再决定是否投入剩余 20 人日。这样沉没成本最低，随时可在方案 A/B/C 之间转向。

---

## 十、实施进度记录（实际执行 vs 计划）

> 以下为已执行部分的实测记录，含与原方案的偏差修正。

### P0 + P1（已完成，2026-09-08）

- ✅ 引擎零复制复用：`designer-react` 通过 vite alias `@ → ../openprint/src` 直接引用，未复制任何引擎代码
- ✅ 4 个 Pinia store 迁 Zustand（designer/history/ui/dataSource + printerProbe）
- ✅ 跨框架契约：13 个场景 golden fixture（Vue 端录制），React 端深比对全绿
- ✅ 变异测试验证契约有效性（3 个注入 bug 全部抓到，修复了场景 04 的设计缺陷）
- ✅ Vue 端全量 50 文件 / 456 测试无回归
- ⚠️ 修正原方案认知：`createDefaultControl` 抽成共享模块 `control-factory.ts`（两端同源，杜绝漂移）


### P2 画布层（已完成，2026-09-08）

- ✅ **画布内核零复制复用成立**：CanvasDesigner(1121行) + 14 类 PrintXxx 控件 + SmartGuides + page-gap/page-geometry 全部 alias 引用，React 端加载成功
- ✅ 解耦 1：`rulers/rulerHighlight.ts` 从 vue ref 改为框架无关 observable（写入方语法不变，Vue 端 RulerOverlay 改显式订阅；**456 测试无回归**）
- ✅ 解耦 2：`@/design/stores/dataSource` 用 shim 顶替（接入 React zustand store 计算 previewData，语义等价 Vue computed 且带缓存）
- ✅ 修复 P1 遗留缺陷：`selectActiveFields` 占位实现导致设计期动态配色在 React 端静默失效
- ✅ 新增 React 组件：`ruler-geometry.ts`（刻度换算纯函数，15 测试）+ `RulerOverlay.tsx`（useSyncExternalStore 接入共享高亮带）+ `CanvasStage.tsx`（挂载幂等，StrictMode 安全）
- ✅ store 补齐：`viewport` / `setViewport` / `setPageCount` / `applyCanvasControl`（画布交互回写，含历史）
- ✅ **依赖纯净性守卫**（kernel-purity.spec）：静态递归解析 CanvasDesigner 整条 import 链（模拟 vite alias），断言永不触及 vue/pinia —— 变异验证有效（shim 失效立刻抓到 3 处框架侵入）
- ⚠️ **修正 P0 评估结论**：core 层并非 100% 零框架 —— `core/fonts/system.ts` 用了 vue ref（系统字体运行时，被 dataSource→usePrinterProbe 链带出；运行时已被 shim 掐断，不在画布链上，但 P3 做字体下拉时必须迁移该模块）

**当前状态**：React 端 5 文件 / 43 测试全绿，tsc 0 错误。下一步 P3：面板层（属性面板 17 个 + 图层树 + 控件库，建议引入 @ant-design/pro-form 或 form-render 做 schema 驱动）。


### P3.1 面板层基建（已完成，2026-09-08）

- ✅ **共享面板逻辑**（`panels/props/shared/panel-logic.ts`，14 测试）：内容三态判别/切换、样式浅合并、格式补丁语义、格式类型首选默认、预设日期模板、绑定字段建议——从 TextProps.vue 的 script 中抽出为纯函数（不碰 store），**Vue 端 TextProps.vue 已改为引用共享实现**（470 测试无回归），两端物理上不可能漂移
- ✅ React 端 `selectors.ts`：`selectSelectedControl` / `useSelectedControl`（等价 Vue 版 selectedControl computed）
- ✅ React 端组件：`ContentValueEditor.tsx`（内容三态，P3.1 精简版暂不含 Variable/Expression 弹窗）、`TextProps.tsx`（antd 6 全量对齐 Vue 版交互）、`RightPanel.tsx`（按控件类型分发的壳，P3.1 接入 text，其余占位）
- ✅ 端到端冒烟：store 造控件 → 选中 → RightPanel 真渲染（React 19 `act`）→ 点击「对齐=中」→ 断言 store 写回 `textAlign: 'center'`——验证「组件 → 共享逻辑 → zustand → 模型」整链路
- ⚠️ 工程事实：antd 用了 **6.6.3**（原生支持 React 19，无需 v5 patch）；`swatches` prop 在 v6 改为 `presets` 分组；两次并行 `npm install` 会互相破坏 node_modules（出现 lib/index.js 缺失），必须串行安装
- ⚠️ 行为发现：「添加控件即选中」是**画布事件回写**的（Fabric setActiveObject → onSelectionChange → store），不是 store 行为——测试环境无画布需显式 selectControl
- ⏳ P3.2 待办：其余 16 个属性面板按 TextProps 模式批量迁移；VariableModal/ExpressionModal；图层树/控件库/数据源树；core/fonts/system.ts 去 vue 化后接入系统字体


### P3.2 批量面板·第一批（已完成，2026-09-08）

- ✅ 新增 React 面板：`CommonProps`（名称/几何/旋转/锁定/打印/辅助线，zone 类型隐藏几何段）、`ZoneProps`（高度联动 height + 每页重复 + antd 6 `title` 写法）、`BindingEditor`（selectFlatFields，mode=tags 单值语义）、`CodeProps`（barcode/qrcode 双渲染，内容三态走共享 panel-logic）、`SignatureProps`（openSignaturePad 接通）、`MathProps`（LaTeX 源码/显示模式/字号/颜色/10 个公式模板）
- ✅ 共享样式 `panels/props.css`：类名与 Vue 版逐一同名（props-section/row/label/tip），视觉行为对齐
- ✅ RightPanel 对齐 Vue 版结构：**类型专属面板在前、CommonProps 在后**（P3.1 写反了顺序，本轮纠正）
- ✅ store 补齐：`signatureModalOpen` / `pendingSignatureDrop` / `openSignaturePad` / `closeSignaturePad`；dataSource 新增 `selectFlatFields`（hidden 过滤 + sort 排序，等价 Vue flatFields computed）
- ✅ 共享逻辑类型放宽：panel-logic 的 `resolveContentMode/contentModePatch` 从 `TextControl` 放宽为结构化的 `ContentCarrier`（type 别名，可赋值 Record<string,unknown>），barcode/qrcode 直接受益，Vue 端零影响
- ✅ 测试：面板冒烟 5 个新用例（zone 结构守卫、barcode/qrcode 双渲染、Math textarea 写回、签名弹窗状态、CommonProps 名称写回）+ 变异验证有效（name→title 立刻红）
- ⚠️ 行为澄清：zone 控件在 `zones[]` 模型而非 `controls[]`，addZone 后需手动 selectControl（画布回写语义）；antd 6 Alert 的 `message` prop 已弃用改 `title`
- ⏳ P3.3 待办：RichText（tiptap → @tiptap/react）、Image、Shape、Chart、LabelGrid、**TableProps（829 行最大）**、VariableModal/ExpressionModal、图层树/控件库/数据源树、fonts/system.ts 去 vue 化

**当前状态**：React 6 文件 / 50 测试全绿、tsc 0 错误；Vue 51 文件 / 470 测试无回归。


### P3.3 字段选择弹窗 + Image 面板（已完成，2026-09-08）

- ✅ **共享示例值逻辑**（`panels/props/shared/sample-value.ts`，9 测试）：resolveSamplePath / formatSampleValue / sampleOfField（数组标记 items[].qty → 首行叶子）/ TYPE_META——从 VariableModal.vue 抽出，**Vue 端 VariableModal 已改为引用共享实现**（479 测试无回归）
- ✅ React `VariableModal.tsx`：按表分组 + 搜索过滤 + 类型标签 + 示例值预览 + 确定回写（antd Modal，样式类名与 Vue 同名）
- ✅ React `ImageProps.tsx`：inline 上传转 Base64（antd Upload customRequest + FileReader）/ URL / binding 三态 + fit/cornerRadius；binding 模式接 VariableModal
- ✅ ContentValueEditor 变量模式接通 VariableModal（P3.1 的禁用按钮占位已移除）；表达式弹窗留 P3.4
- ✅ store 提升：previewData 从 shim 提升进真正 store（`selectPreviewData`，带指纹 memo）——预览面板、弹窗示例值、设计期配色三者同源；shim 降级为纯委托 + 探针计数器
- ✅ store 新增 `selectFieldTree`（等价 Vue fieldTree computed，带 memo）
- ⚠️ **zustand v5 关键坑**：selector 每次返回新数组/新对象会触发「Maximum update depth exceeded」无限重渲染——selectFieldTree 首版即中招，5 个测试连环崩；修复 = 模块级指纹 memo 返回稳定引用（selectPreviewData 同策略）。凡是返回派生数组的 selector 都必须走这个模式
- ⚠️ 测试坑：antd Modal 经 portal 渲染到 document.body 而非组件宿主，断言必须查 body

**当前状态**：React 6 文件 / 53 测试全绿、tsc 0 错误；Vue 52 文件 / 479 测试无回归。


### P4.1 ExpressionModal 表达式弹窗（已完成，2026-09-08）

- ✅ **共享表达式逻辑**（`panels/props/shared/expression-logic.ts`，20 测试）：filterCatalog（目录搜索过滤）/ buildSampleCtx（样例求值上下文）/ evalExpressionPreview（实时预览求值，异常归一为 errors）/ insertSnippetAtCursor（光标插入纯函数，返回 {next, caret}）/ normalizePickedHex（取色 hex 规范化）/ PRESET_COLORS——从 ExpressionModal.vue 抽出，**Vue 端已改为引用共享实现**
- ✅ React `ExpressionModal.tsx`：左（antd Segmented 函数/字段 tab + 搜索 + 目录条目）/ 右（textarea + 预设色块 + ColorPicker onChangeComplete + 实时预览）+ footer 确定回写；样式 expression-modal.css 对齐 Vue 版
- ✅ ContentValueEditor 表达式模式接通 ExpressionModal（「插入函数」按钮激活，P3.4 占位移除）
- ⚠️ **又一个 zustand v5 无限重渲染坑（P3.3 的延续）**：`selectFlatFields` 一直没做指纹 memo（P3.3 只修了 selectFieldTree/selectPreviewData），ExpressionModal 是首个订阅者即触发 Maximum update depth exceeded；修复 = 同款指纹 memo（activeSourceId + 可见字段数 + path/hidden/sort 拼串）。**教训：凡是返回派生数组的 selector 都要 memo，不要等被订阅时才爆**
- ⚠️ 排障技巧：antd Modal 内组件无限重渲染时，错误栈停在 rc-component/portal Portal.js，与真实根因（store selector）相距甚远；用「最小渲染 → 禁 hooks → 二分内容」定位
- ⚠️ 测试坑：previewData 由 FieldDef.sample 经 buildPreviewData 合成，不能直接 setState 注入——mock 数据源 init() 后用 sample 已知字段（order.total=12800.5）断言；antd 按钮两字间有空格（「确 定」）

**当前状态**：React 8 文件 / 60 测试全绿、tsc 0 错误；Vue 53 文件 / 499 测试无回归（+20 expression-logic）。


### P4.2 Shape / Chart / LabelGrid / Table 四面板（已完成，2026-09-08 深夜）

- ✅ **共享逻辑 ×4**（props-logic-p4.spec.ts，33 测试）：
  - shape-props-logic：dashedPatch / unifiedRadiusPatch（清四角覆盖）/ radiusOf（回落链）/ shapeChangePatch（切圆强制正方形）/ perfectCirclePatch
  - chart-props-logic：categoriesPatch（类目编辑同步对齐序列长度）/ alignSeriesData（缺位补 0）/ addSeriesAt（调色板轮转）/ removeSeriesAt（保底 1）/ showLegendDefault
  - label-grid-props-logic：maxColumnsOf / visibleRowsOf / geometryPatch（改布局后容器宽高重算=所见即所得）/ rowsHeightPatch / fitCardPatch
  - table-props-logic：cleanOptions（清 undefined 键）/ mergeClean（清 null/''）/ normalizeColumnFormat（none=清除）/ columnFieldOptions（只列 [] 明细字段）/ groupFieldOptions / summaryFieldOptions / withSummaryExpr / withSummaryFallback / stylePickPatch
- ✅ Vue 端 4 面板已改引共享实现（行为不变）
- ✅ React 四面板 + TableStylePickerModal（共享 tableCss() 真实渲染预览卡）；RightPanel 全类型挂载完毕，**仅剩 richtext（P4.3）**
- ✅ React designer store 补 clearLabelGridChildren（Vue 端有、React 漏）
- ⚠️ 坑：antd6 Select DOM 类名是 ant-select-content（没有 ant-select-selector）；antd6 Button 无 dashed prop → variant="dashed"；LabelGridProps 条件 hook（pageSetup 在提前 return 之后）→ Rendered fewer hooks——hooks 必须全部置于条件 return 之前
- ⚠️ 面板测试在 happy-dom 下较慢（antd Select 下拉 ~4s），全量并行时撞 5s 默认超时连锁失败 → vite.config test.hooks testTimeout 放宽 20s

**当前状态**：React 13 文件 / 69 测试全绿、tsc 0 错误；Vue 54 文件 / 532 测试无回归（+33 props-logic）。


### P4.3 RichText + P4.5 fonts 去 vue 化（已完成，2026-09-08 深夜，P4 收官）

- ✅ **fonts/system.ts 框架无关化**：vue ref/computed 全部移除，改为「模块级单例状态 + 快照对象 + onSystemFontsChange 订阅」；快照引用稳定（仅状态变化时重建），正是 useSyncExternalStore 需要的语义
  - Vue 端新建 composable 包装 （接口与旧版完全一致），6 个消费方（CellToolbar / usePrinterProbe / PreviewPanel / TextProps / RichTextEditor / spec）改导入路径，行为不变
  - React 端新建 hook （useSyncExternalStore 包装）
- ✅ React （@tiptap/react 3.31.3 + StarterKit + TextStyle + FontFamily）：字体下拉（预设 + 电脑系统字体分组）+ 10 个工具按钮 + 编辑区；React.lazy 懒加载对齐 Vue defineAsyncComponent
- ✅ React ：内容（编辑器）+ 尺寸；**RightPanel 全类型挂载完毕，P3–P4 面板迁移全部完成**
- ✅ React TextProps 字体下拉补系统字体分组（对齐 Vue 版）
- ⚠️ **tiptap 双实例坑**：npm 直接装 3.29.2，但 starter-kit 的传递依赖解析到 3.31.3（^range 取 latest），嵌套出第二份 @tiptap/core → 扩展的 Commands 类型增强落在另一份 core 上，toggleBold 等全部 TS 报错。修复 = 直接依赖统一升级 3.31.3 消除分叉。教训：pnpm/monorepo 里的类型增强（declare module）失效先查双实例
- ⚠️ happy-dom 无 document.execCommand，无法端到端模拟 tiptap 输入；控件工厂会用默认 value 覆盖入参 override——测试需 updateControl 显式写入
- ⚠️ React.lazy 在测试里需要 waitFor 轮询等 chunk resolve（Suspense fallback 期断言会失败）

**当前状态（P4 收官）**：React 16 文件 / 77 测试全绿、tsc 0 错误；Vue 54 文件 / 532 测试无回归。面板层两端等价，下一步 P5：整体联调（AppShell / 画布装配 / 顶部工具栏 / 撤销重做链路）与端到端冒烟。

### P5.1 左侧三树（原 P4.4，已完成，2026-09-09 凌晨）

- ✅ **共享拖拽抽取**（`design/hooks/control-drag.ts` 框架无关）：DRAG_TYPE_KEY / pendingInit / startControlDrag / readControlDrag（drop 取回类型+init）/ isControlDragOver / **computeDropMm**（client px → 页面 mm + 内容区 mm 纯换算）；useDragAdd.ts 改引共享实现（Vue 行为不变）
- ✅ React `canvas/useDragDrop.ts`：dragover/drop 落控件，逻辑与 Vue onDrop 逐行等价（标签网格命中 → zone 命中 → 签名弹板 → 正文落控件）；CanvasStage 已挂接
- ✅ React `LeftPanel.tsx`（antd Tabs 三 tab）+ `ControlLibrary.tsx`（5 分类 21 卡片 + 搜索 + 点击插入/拖拽）+ `DataSourceTree.tsx`（三选一 + 数据源选择 + 字段树 + 搜索；**DatabaseExplorer 数据库探索器留 P5.1b 占位**）+ `LayerPanel.tsx`（倒序图层 + 选中/上移/下移/删除）；selectFieldTree 返回类型补 isArray
- ⚠️ 坑：happy-dom 的 DragEvent 不持久 dataTransfer（测试用 stub 对象）；antd Radio 也渲染 input[type=radio]，querySelector('input') 会命中它（按 placeholder 定位）；React 受控 input 必须用原生 setter 绕过 valueTracker；Vue 版 ControlLibrary 的 onClick 对 text/image 无动作（仅拖拽），测试断言需对齐
- ⚠️ Vue 版 useDragAdd 重写后行为逐行保持（hitLabelGridContainer 命中在 zone 检测之前）

**当前状态**：React 21 文件 / 91 测试全绿、tsc 0 错误；Vue 54 文件 / 532 测试无回归。


### P5.2 TopToolbar 顶部工具栏 + 保存/加载链路（已完成，2026-09-09）

- ✅ **共享 toolbar-logic**（`design/toolbar/shared/toolbar-logic.ts` 框架无关，13 测试）：FILE_MENU_ITEMS（8 功能项 + 4 分隔线）/ isMacPlatform + modOf / buildShortcutGroups（快捷键指南三组数据，MOD 随平台）/ printerDotClass / printerTooltip（打印状态灯四态文案）——从 TopToolbar.vue 抽出，**Vue 端已改为引用共享实现**（NDropdown options 由 FILE_MENU_ITEMS 派生）
- ✅ **React designer store 补持久化链路**（对齐 Vue 版）：
  - state 增 `currentTemplateId`（null = 从未保存）/ `backendMode`（'local' | 'cloud'）
  - 模块级 `repository` 单例默认 `createLocalRepository()`（localStorage），`setTemplateRepository()` 供 Phase 6 注入 http 仓库、`resetTemplateRepository()` 测试复位
  - actions：`renameTemplate(name, markDirty)` / `saveTemplate`（唯一持久化入口：buildTemplate → assertTemplate → create|update → markSaved）/ `saveTemplateAs`（新名 + 归零 id）/ `loadTemplate`（先 zone 后 body/子控件装配 + 画布内核驱动 + 清历史）；`newBlankTemplate` 归零 currentTemplateId
  - 直接复用 Vue 端零框架模块（经 `@` alias）：`@/repository/local-repo`、`@/core/spec/validator`（AJV）、`@/design/utils/template-file`、`@/repository/mock/data/demo-template`
- ✅ React `TopToolbar.tsx` + `top-toolbar.css`：品牌区（logo/产品名/版本 SVIP 开关/文件菜单/模板市场/流水标签/后端徽标）+ 中间模板名内联编辑 + 右侧操作区（撤销重做/主题切换/边距参考线/预览/保存/导出/打印状态灯/JSON/快捷键指南/AI/设置）；快捷键指南（? 键唤起 + macOS/Windows 平台切换）、另存为、新建模板三个弹窗全实现；10 个未迁移弹窗（模板管理/设置/市场/数据导入/JSON/打印/流水标签/AI/预览/导出）以占位 Modal 呈现，P5.3+ 逐个替换
- ⚠️ **React 合成事件坑**：antd Dropdown 悬停触发在测试里必须派发原生 `mouseover`（bubbles），`mouseenter` 无效——React 的 onMouseEnter 由 mouseover 合成
- ⚠️ **rc-motion 不闭合坑**：happy-dom 无 CSS transition，下拉菜单展开后不会自动关闭——测试不要等「菜单收起」，点完菜单项即断言
- ⚠️ **编辑工具坑（本轮两次踩中）**：同文件多处 Edit 并行下发时部分编辑会静默丢失（返回成功但内容未变）——同一文件的多处修改必须逐个串行执行
- ⚠️ antd6 Button 两字文案自动插空格（「预 览」），断言需 `textContent.replace(/\s/g,'')` 归一化
- ⚠️ 快捷键指南 kbd 键帽是独立元素，`Ctrl + Z` 在 textContent 中连成 `Ctrl+Z`——按 `.kbd` 元素集合断言
- ⚠️ store 测试必须每次 `useDesignerStore.getState()` 取新快照（旧引用不反映 action 后状态）

**当前状态（P5.2 收官）**：React 24 文件 / 112 测试全绿、tsc 0 错误；Vue 55 文件 / 545 测试无回归（+13 toolbar-logic）。


### P5.3 AppShell 三栏装配 + SignaturePadModal（已完成，2026-09-09 凌晨）

- ✅ **App 三栏布局壳**（`designer-react/src/App.tsx` + `app.css`）：TopToolbar / 左栏 250px（LeftPanel 三 tab）/ 中央 CanvasStage / 右栏 300px（RightPanel，rightPanelVisible 可隐藏）+ SignaturePadModal；antd ConfigProvider 按 effectiveTheme 切 darkAlgorithm
- ✅ **主题单一来源**：`import '@/theme/brand.css'` 经 alias 直用 Vue 端语义变量表（不复制 CSS）；`main.tsx` 对齐 Vue main.tsx 主题闭环（syncDom + bindSystemListener）
- ✅ **React 入口**：`index.html` + `src/main.tsx`（StrictMode）；`vite build` 冒烟通过（chunk 大小警告属 fabric/antd 正常量级）
- ✅ **SignaturePadModal**（`panels/SignaturePadModal.tsx` + `signature-pad.css`，5 测试）：笔画栈绘制/撤销/清空、包围盒裁剪导出 2× PNG、落点用 pendingSignatureDrop（拖入）或回落 (60mm,60mm)、插入即 addControlOfType('signature')
- ✅ **测试基建**：`canvas/test-utils.ts` 新增 `stubCanvas2d()`——happy-dom canvas.getContext 返回 null，Fabric init/渲染必崩；用 **Proxy 万能 ctx stub**（已知属性原样、未知属性返回 no-op 函数）兜住 setLineDash/createLinearGradient 等长尾；AppShell 测试直接 **vi.mock '@/design/canvas/CanvasDesigner'** + '@/core/fonts/loader'（壳层冒烟不跑 Fabric，避免渲染链路未捕获异常污染测试进程）
- ⚠️ 坑：vite.config test 补 `hookTimeout: 30000`（beforeEach 动态 import App 并行满载可超默认 10s）；antd Modal 关闭后 DOM 仍挂载（断言以 store 状态为准）；测试收尾要 root.unmount() 否则 React scheduler 在环境拆除后报 window is not defined
- ⚠️ **端口冲突**：designer-react 与 admin 前端都配 5188——designer-react dev 改用 5189 起

**当前状态（P5.3 收官）**：React 28 文件 / 121 测试全绿、tsc 0 错误、vite build 通过；Vue 55 文件 / 545 测试无回归。


### P5.4 PreviewPanel + ExportDialog（已完成，2026-09-09）

- ✅ **共享 preview-logic**（`openprint/src/design/preview/shared/preview-logic.ts`，3 测试）：WARNING_LABEL（14 个渲染告警码→中文）、SCALE_MIN/MAX/STEP、clampScale；Vue PreviewPanel 改引共享，两端预览缩放与告警文案同源
- ✅ **React PreviewPanel**（`designer-react/src/preview/PreviewPanel.tsx` + css，4 测试）：iframe srcdoc 隔离渲染（防 @page 泄漏）+ 打开即 render() + 翻页（scrollIntoView + scroll 反向同步）+ 告警弹层 + 右下角缩放条（±25%/适应宽度/Ctrl+滚轮）+ 字体 @font-face 注入 + 浏览器打印（打印时强制 1:1）；`@/core/sdk`、`@/core/export-engine`、preview-data、mmToPx、builtinFontFaceCss 全部 alias 直用 Vue 端实现
- ✅ **React ExportDialog**（`designer-react/src/toolbar/ExportDialog.tsx` + css，4 测试）：PDF/JPG/SVG/HTML 四格式单选 + 明细行数（跨页验证）+ 文件名；exportDocument + downloadBlob 逐个下载，失败保持打开
- ✅ **TopToolbar 接线**：预览/导出两个占位 Modal 替换为真实现（剩 8 个占位：打开模板/设置/市场/导入数据/JSON/打印/流水标签/AI）
- ⚠️ 坑：React 自身模块不走 `@` alias（那是 Vue 端映射）——新文件 import stores 用相对路径；antd 静态 message 会在测试环境拆除后延迟挂载 React root → scheduler 报 window is not defined，spec 收尾需在 unmount 后再 act 等一个宏任务（既有 spec 的 3 个同类 unhandled error 同根因，后续统一修）
- ⚠️ Vue 端 vue-tsc 有一批**既有**类型错误（RulerOverlay.vue / TableProps.vue / 若干 spec），与本轮无关，未触碰

**当前状态（P5.4 收官）**：React 30 文件 / 129 测试全绿、tsc 0 错误、vite build 通过；Vue 55 文件 / 548 测试无回归（+3 preview-logic）。


### P5.5 轻弹窗真实现：TemplateModal + TemplateMarket + JsonViewerModal（已完成，2026-09-09 凌晨）

- ✅ **TemplateModal**（`designer-react/src/modals/TemplateModal.tsx` + css）：列表（updatedAt 倒序）/ 打开 / 复制（loadTemplate→saveTemplateAs「xx 副本」）/ 删除（Popconfirm，删当前模板则画布清空）/ 新建（dirty 确认）；repository 经新增的 `getTemplateRepository()` 访问器直连，本地/云端同接口
- ✅ **TemplateMarket**（`modals/TemplateMarket.tsx` + css）：左侧分类计数 + 右侧卡片网格（迷你纸张缩略按宽高比 fit 52×64）+ 关键字搜索 + 使用模板（dirty 时 confirmDialog）；`@/repository/mock/data/market-templates` alias 直用
- ✅ **JsonViewerModal**（`modals/JsonViewerModal.tsx` + css）：CodeMirror 6 只读 JSON 查看器（basicSetup + lang-json + 自定义亮暗 Catppuccin/亮色高亮主题）；**npm install codemirror 全家桶与 Vue 端同版本**，`npm ls @codemirror/state` 确认单实例无分叉（吸取 tiptap 双实例教训）；复制 JSON → 剪贴板 → 关闭
- ✅ **TopToolbar 接线**：打开模板/模板市场/JSON 三个占位替换为真实现；`confirmDialog` 抽到 `src/ui-confirm.ts` 共享（TopToolbar/TemplateModal/TemplateMarket 三处复用）。剩 5 个占位：设置/导入数据/打印/流水标签/AI
- ⚠️ 坑：antd Modal 内容 portal 挂载晚于 React effect → CodeMirror 容器需轮询等待（对齐 Vue 版 20×50ms 策略）；antd 两字按钮文案带空格，测试断言一律 `replace(/\s/g,'')` 归一化；happy-dom navigator.clipboard 是 getter，用 `Object.defineProperty(navigator,'clipboard',{value,configurable:true})` 打桩；会话环境注入 `https_proxy` 会让 curl 探测本地端口 502——探测须 `curl --noproxy '*'`
- ⚠️ designer-react dev server 依赖装包后必须重启（node_modules 重写会挂起旧进程且无输出）

**当前状态（P5.5 收官）**：React 33 文件 / 138 测试全绿（+9）、tsc 0 错误、vite build 通过；Vue 55 文件 / 548 测试无回归。

### P5.6 DataImportModal + store.importTable（已完成，2026-09-09）

- ✅ **store.importTable**（`designer-react/src/stores/designer.ts`）：对齐 Vue 版——内容区宽度均分列宽、`items[].key` field 前缀、`control.data` 内嵌记录（与 dataSource 绑定解耦）、seedSummaryTail 植入「本页合计/总计/大写金额」尾行（数值列采样推断 + 金额列关键字匹配）、历史 undo/redo、落地即选中 + dirty；`seedSummaryTail`/`ImportColumn` 经 @ alias 直用 Vue 端
- ✅ **DataImportModal**（`designer-react/src/modals/DataImportModal.tsx` + css，5 测试）：选文件（CSV/JSON/Excel，`parseDataFile` alias 直用）→ 预览（表头悬浮 × 删列 / 行勾选删行 / 标题改名 / 保留·删除全部行 / 200 行渲染上限）→ 确认导入；TopToolbar「导入数据」占位替换（剩 4 个占位：设置/打印/流水标签/AI）
- ✅ **antdMessage**（`src/ui-confirm.ts`）：统一从 ui-confirm 引出 `message`，方便日后换上下文形态
- ⚠️ 坑：antd 静态 `message` 在测试里异步挂 Notification（act 警告 + 断言时序不稳）——消息类断言以 store 状态为准，DOM 文案断言避免；`保留全部行` 语义是「清空已删集合」（恢复全部），不是「保留非删行」
- ⚠️ 全量跑测时新增 unhandled error 仍为既有 3 个（signature-pad/p42/expression-modal 的 message 残留），未新增

**当前状态（P5.6 收官）**：React 34 文件 / 145 测试全绿（+7）、tsc 0 错误、vite build 通过；Vue 55 文件 / 548 测试无回归。


### P5.7 重弹窗二连：SettingsModal + PrintDialog（已完成，2026-09-09 上午）

- ✅ **SettingsModal**（`designer-react/src/modals/SettingsModal.tsx` + css，4 测试）：六页签（本地打印 / 远程云打印 / AI 助手 / 在线教程 / 功能反馈 / 交流群）；打印设置与 AI 设置经 `readPrintSettings`/`writePrintSettings`/`readAiSettings`/`writeAiSettings` alias 直用并即改即存；本地客户端连接测试（checkHealth + listPrinters）、恢复出厂 18888、远程服务探测、客户端下载、mailto 反馈、剪贴板复制、教程卡片、QQ 群二维码——Vue 版全部交互逐项对齐
- ✅ **PrintDialog**（`designer-react/src/modals/PrintDialog.tsx` + css，5 测试）：本机/云打印目标切换、连接状态 Tag、未连接禁用表单并给出原因提示、打印机下拉 + 能力 Tag（空闲/类型/DPI/彩色/双面/纸盒/驱动）、不支持能力自动收敛（无双面→强制单面、无彩色→强制灰度、DPI 重置为该机默认档）、五种载荷格式（HTML/PDF/ESC-POS/TSC/ZPL）+ 字体内联开关 + PDF 分辨率钳制（maxDpi）、方向覆盖、doPrint 完整链路（buildPrintPayload 进度回调 → submitPrintJob → 100% 停留 700ms 关闭）；探测复用 `usePrinterProbeStore` 共享单例（probeIfStale 15s TTL，与顶栏状态灯同源）
- ✅ **TopToolbar 接线**：「全局设置」「打印」两个占位替换为真实现，**只剩 2 个占位**（流水标签 / AI 助手）
- ⚠️ 坑：antd `Progress.status` 不接受 'error'（须映射 'exception'）；`probeIfStale` 已连接 15s 内免重探——测试直接 setState probe store 模拟已连接，未连接用例让 checkHealthMock 默认 reject 作为基线；**同文件多 Edit 并行再次丢编辑**（3/5 静默丢失，必须串行）

**当前状态（P5.7 收官）**：React 36 文件 / 154 测试全绿（+9）、tsc 0 错误、vite build 通过；Vue 55 文件 / 548 测试无回归。下一步 P5.8：FlowLabelModal（1079 行）或 AI 助手，或两者之后进入主流程打磨（状态栏 / 缩放 / 移动端适配）。


### P5.8 FlowLabelModal 流水标签批量打印（已完成，2026-09-09 下午）

- ✅ **共享纯逻辑抽离**（`openprint/src/design/flow-label/shared/flow-label-logic.ts` + 19 测试）：从 Vue 版 1079 行弹窗里抽出框架无关纯函数——filterRows（剔除已删行）/ buildMappedRowData（映射拍平）/ rowSummary（失败行摘要）/ mergeMapping（自动映射 + 保留列仍存在的手动映射）/ columnOptions / computePrintTotal / computeFlowStats（进度·成功·失败·均张·ETA）/ formatDuration / shouldWaitInterval / clampPreviewIndex / buildPrinterOptions / pickDefaultPrinter / connHint / canStartBatch；**Vue 版 FlowLabelModal.vue 改引共享模块**（删本地重复实现，567 测试全绿含 19 新增）
- ✅ **React 版 FlowLabelModal**（`designer-react/src/modals/FlowLabelModal.tsx` + css，6 测试）：左栏数据源（上传 Excel/CSV/JSON → 列/行 Tag → {{占位符}}→列 映射下拉 → 前 50 行数据表点选行）；右栏标签预览（render 单行渲染 180ms 防抖、iframe srcDoc、行导航）+ 打印机（probeIfStale 复用共享 store、默认机自动选中、能力收敛 DPI/灰度）+ 打印参数（间隔/份数/限行/DPI/颜色/方向覆盖）+ 批量循环（暂停/继续/停止 ref 控制、200ms tick 统计）+ 失败折叠列表（单行/全部重试）；流式渲染每行 1 页推送，内存恒定；TopToolbar「流水标签」占位替换为真实现，**只剩 AI 助手 1 个占位**
- 🐛 **测试抓出真实缺陷**：React 版上传新文件后未重算字段映射（Vue 版有 watch(parsed) 链路，重写时漏掉）→ 上传后 mergeMapping 补齐；该缺陷正是"测试先行"要拦的漂移
- ⚠️ 坑：状态变量命名 `interval` 会遮蔽全局定时器（改 intervalMs）；spec 里 antd 静态 message 在环境拆除后异步挂 Notification 报 `window is not defined`——直接 vi.mock ui-confirm 的 antdMessage 根治；**同文件多 Edit 并行第 N 次丢编辑**（再次确认必须串行）

**当前状态（P5.8 收官）**：React 37 文件 / 160 测试全绿（+6）、tsc 0 错误、vite build 通过；Vue 56 文件 / 567 测试全绿（+19，共享逻辑 spec）。顶栏占位仅剩 AI 助手；下一步 P5.9（AI 助手弹窗收官占位层）或主流程打磨（状态栏 / 缩放工具栏 / 移动端适配）。

### P6.1 主流程打磨一期：ZoomBar + StatusBar（已完成，2026-09-09 下午）

- ✅ **共享引擎扩展**（`openprint/src/design/canvas/CanvasDesigner.ts`，Vue/React 两端共用）：init 时记住宿主 container，新增 `fitToHost()`（缩放工具栏「适应页面」）；Vue 端零影响
- ✅ **React store**：CanvasHost 接口加可选 `zoomIn/zoomOut/setZoom/fitToHost`（测试假对象可不实现）；designer store 补 `setGrid(patch)`（镜像 Vue 版：钳制 sizeMm≤0、只改视图状态不标 dirty 不持久化）
- ✅ **ZoomBar**（`designer-react/src/canvas/ZoomBar.tsx` + css，2 测试）：画布右下角浮动条——− / 百分比下拉（档位与文案 alias 直用共享 `@/design/canvas/zoom` 的 ZOOM_PRESETS/zoomLabel，当前档位打点 + 适应页面） / ＋ / 100% 重置；显示值来自 store viewport（与滚轮缩放、onViewportChange 同源）
- ✅ **StatusBar**（`designer-react/src/statusbar/StatusBar.tsx` + css，3 测试）：底部 26px 状态栏——左：模板名 + 未保存 ● + 已选 n 项；右：页数 + 网格/边距线开关（点击即切、is-on 高亮）+ 缩放%；App.tsx 装配、CanvasStage 内挂 ZoomBar
- 验证：React **165/165**（+5）、tsc 0、build exit 0；CDP 实机量测 ZoomBar 贴画布右下角、StatusBar 全宽贴底，缩放 118%（自适应）两处同步

**当前状态（P6.1 收官）**：React 39 文件 / 165 测试全绿、tsc 0、build 通过。下一步 P6.2 移动端适配（左右面板抽屉化）或 P5.9 AI 助手弹窗（顶栏最后一个占位）。


### P5.9 AiAssistantModal AI 设计助手（已完成，2026-09-09 下午，占位层收官）

- ✅ **共享纯逻辑抽离**（`openprint/src/design/ai/shared/ai-assistant-logic.ts` + 10 测试）：computeRevealStep（打字动画步长：保证整块 SSE 缓冲也有 ≥1.6s 逐字呈现）/ parseDatasourceFields（字段串解析）/ diffSelectedControls（C 模式选区改写 diff：原位改/新增/删除 + 摘要）/ resolveMode（选区丢失回退新建）/ templateMeta（尺寸·控件数摘要）；**Vue AiAssistantPanel.vue 改引共享**（含 revealTick/applySelected/datasourceFields 全部去重）
- ✅ **React AiAssistantModal**（`designer-react/src/modals/AiAssistantModal.tsx` + css，4 测试）：antd Drawer 右侧 440（v6 用 `size={440}`，width 已弃用）；未配置态（提示 + 去设置联动 SettingsModal + 试用示例载 demo 模板）；三模式（新建 / 基于当前模板改 / 选中部分）+ 数据字段接地输入；渐进打字动画 + 停止（AbortController + 定时器清理防泄漏）；模板卡「应用到画布」/ 选区卡「替换选中控件」（共享 diff）；AI 核心 `@/ai/generate`（提示词 → streamChat → 解析 → 归一化 → 校验）零框架依赖全 alias 直用；**TopToolbar 最后 1 个占位替换，顶栏占位全部清零**
- ⚠️ 坑：zustand v5 selector 返回新数组（map/filter）→ useSyncExternalStore 无限渲染（先订阅原值再 useMemo 派生）；vi.mock 工厂默认值被单用例污染须 beforeEach 复位；loadTemplate 有 assertTemplate 校验（测试造数据须用真模板结构）；beforeEach 里给 `isAiConfigured` 复位
- 验证：React **169/169**（+4）、Vue **577/577**（+10）、双端 tsc 0、build exit 0；CDP 实机验证 Drawer 440×900 滑出、3 示例 chips、未配置提示正确

**当前状态（P5.9 收官 / 外壳层全部完成）**：React 40 文件 / 169 测试全绿、tsc 0、build 通过；Vue 58 文件 / 577 测试全绿。**顶栏 0 占位**——Vue 版全部功能面（画布/面板/工具栏/预览导出/模板/数据导入/设置/打印/流水标签/AI）React 版均已真实现。下一步：P6.2 移动端适配（左右面板抽屉化）或继续主流程打磨。

### P6.2 移动端适配一期（已完成，2026-09-09 晚）

> Vue 版无任何 @media 响应式（纯桌面布局），P6.2 为 React 版新增增强，无对齐负担。

- ✅ **useIsNarrow hook**（`designer-react/src/hooks/useIsNarrow.ts`）：matchMedia('(max-width: 900px)') + change 监听（addEventListener/addListener 降级），SSR/测试环境安全返回 false
- ✅ **App.tsx 窄屏抽屉化**：≤900px 时左右面板不渲染，收进 antd Drawer（v6 语义化 `classNames={{ body, root }}`，无 rootClassName）；画布两侧浮动唤起按钮（.app-fab 竖排文字「组件/属性」，贴边垂直居中）；桌面（>900px）布局与 P6.1 完全一致、零改动
- ✅ **窄屏收缩规则**：.is-narrow 类由 hook 驱动（比 @media 可测试）；顶栏次要按钮打 `data-narrow-hide` 标记（边距线/JSON/快捷键，CSS 统一 display:none!important）；toolbar-center（模板名）隐藏；状态栏已选/页数隐藏、模板名缩窄
- ⚠️ 坑：antd v6 Drawer 无 rootClassName（用 classNames.root）；RightPanel 无选中时是空态占位（无主面板类名），断言须按空态文本；happy-dom matchMedia 默认 matches=false，测试用 vi.spyOn(window,'matchMedia') 桩
- 验证：React **173/173**（+4，p62-mobile.spec：桌面无 FAB/窄屏抽屉化/点 FAB 开抽屉/narrow-hide 标记+关键按钮保留）、tsc 0、build exit 0；CDP 实机 800×900 模拟：is-narrow ✓ FAB×2 ✓ 抽屉开含面板 ✓；回 1600×900 自动还原 ✓
- 下一步：P6.3 移动端二期（触控优化/手势缩放/抽屉内属性编辑体验）或继续主流程打磨


### P6.3 移动端二期：触控手势（已完成，2026-09-09 深夜）

- ✅ **共享手势数学**（`openprint/src/design/canvas/touch-gesture.ts` + types + 9 测试）：parsePinch（两指间距+中点）/ pinchTransform（间距比→缩放、中点位移→平移，dist=0 兜底）/ pointerClientXY（Touch/changedTouches/Mouse 统一取点）
- ✅ **共享引擎 CanvasDesigner 触控接线**（Vue/React 两端同时获得）：
  - 双指捏合：宿主容器 capture + passive:false 监听 touchstart/move/end——锚点缩放 + 中点平移、discardActiveObject 防误拖控件、userZoomed=true 停自动 refit、end 后恢复框选；**监听必须挂宿主容器而非传入 el（Fabric 交互在 upper-canvas，兄弟节点）**
  - 单指空白拖拽平移（仅 pointer:coarse）：mouse:down 无 target 时接管 window touchmove/touchend（preventDefault 阻断滚动），桌面空白拖拽保持框选语义不变
  - dispose 清理 touch listeners
- ✅ **触控细节**：canvas `touch-action:none`（双端内联）；弹窗宽度兜底 `.ant-modal max-width calc(100vw-16px)`；FAB ≥44px、窄屏 ZoomBar 触控目标 ≥36px
- ⚠️ 坑：①监听挂 lower-canvas 收不到事件（upper 才是交互层）；②touch 拖拽不产生 mousemove（单指平移须监听 touchmove）；③CDP Input.dispatchTouchEvent 两触点须唯一 id
- 验证：React 173/173、Vue 586/586（+9）、双端 tsc 0、build exit 0；CDP 实机（触摸模拟 800×900）：**捏合 86%→172%**（与两指间距 200→400 精确成比）、**单指空白拖拽 18.8% 像素整体位移且 zoom 不变**（平移生效、未误缩放）
- 下一步：P6.4 或按需（触控长按菜单/移动端属性编辑体验/回主流程性能打磨）

### P6.4 移动端三期：属性编辑体验 + 触屏长按菜单（已完成，2026-09-09 深夜）

- ✅ **窄屏选中 → 属性抽屉自动弹出**（App.tsx）：订阅 selectedIds，≤900px 选中控件自动开右抽屉、取消选中自动收起——修复「移动端点控件后无处编辑属性」的体验断点；抽屉宽度响应式（min(340, 86vw)）
- ✅ **触屏长按菜单**（共享引擎 + React）：
  - CanvasDesignerEvents 新增 `onLongPress(controlId, screen)`；引擎 coarse+单指按控件 500ms 触发，移动>10px/抬手/双指取消，dispose 清理
  - React LongPressMenu 组件：复制（addControlOfType 偏移 2mm + 选中新件）/ 上移一层 / 下移一层（moveControl）/ 删除；视口边缘夹取定位；遮罩点击关闭；长按即选中（属性抽屉联动）
- ⚠️ **排查插曲（重要教训）**：用户报「点击是预览、不能操作」。CDP 多点扫描发现选不中 → 深挖后确认是 **Emulation.setDeviceMetricsOverride 破坏 Fabric 坐标命中**（工具假象）；真实桌面浏览器点击/选中/编辑全部正常（截图验证）。真正的问题是**窄屏下属性面板收进抽屉、点控件无面板出现**——正是 P6.4 自动抽屉要解决的。教训：设备模拟下的交互量测不可信，须 store 直连或真实设备
- 验证：React **177/177**（+4）、Vue 586/586、双端 tsc 0、build exit 0；CDP 实机 800×900：选中 → 抽屉自动开（340px 完整编辑表单）→ 取消选中自动收起 ✓
- 下一步：按需（触控长按菜单实机微调 / 主流程性能打磨 / 收尾发布准备）

### P6.5 修复：窄屏 + 鼠标误入移动端模式（已完成，2026-09-09 深夜，用户报障驱动）

- 🐛 **用户报障**：「鼠标移动到编辑会出现预览功能，不能操作了，要能编辑」
- **根因**：P6.2 移动端模式仅按视口宽度（≤900px）判断。窄窗口 / 内嵌预览面板 / 高显示缩放场景下，**鼠标用户**也被切进移动端布局：左右面板消失、点选控件即弹属性抽屉 + 遮罩盖住画布，后续点击全被拦截——体感「变成预览、不能编辑」
- **修复**：移动端模式改为 **窄屏（≤900px）且主输入为触屏（`pointer: coarse`）** 双条件（`useIsMobile`，与引擎长按/单指平移的 coarsePointer 判定同源）；窄窗口 + 鼠标保持桌面三栏常驻（与 Vue 版任意宽度行为一致）
  - `hooks/useIsNarrow.ts`：新增 `COARSE_QUERY` + `useIsMobile()`（useMediaMatches 复用 change 监听）
  - `App.tsx`：抽屉/FAB/is-narrow 类/自动属性抽屉全部改挂 `isMobile`
- ⚠️ 教训补充（接 P6.4 插曲）：「点击是预览」的另一半真相是**窄视口鼠标用户被误入移动端模式**；设备交互类断点必须同时看宽度与输入方式（pointer/hover），不能只看宽度
- 验证：React **178/178**（+1：窄屏+鼠标→桌面布局回归用例）、双端 tsc 0、build exit 0；CDP 双向实机：
  - 800px + 鼠标：左/右面板常驻、无 FAB、点控件直接选中（sel=bd-no）、无抽屉无遮罩，常驻属性面板可编辑 ✓
  - 800px + 触屏模拟（pointer:coarse）：仍进移动端模式（抽屉 + FAB）✓
