# AI-first 差距分析（OpenPrint / report）

> 分析对象：本仓库（Rust `print-server` + TS `openprint` + React `designer-react`）
> 方法：只认代码与实测。所有「有 / 没有」都给出文件行号或可复现命令；凡是推断都标注为推断。
> 日期：2026-09-24

---

## 0. 一句话结论

**本项目已经是「AI 可验证」的，但还不是「AI 可编写」的。**

- **可验证**：探针 / 故障注入 / 可判定不变量 / 「闸必须能红」——这套纪律恰好是 AI-first 最需要的地基，大多数项目到不了这一步。
- **不可编写**：AI 只挂在**自由画布**那一层；项目的差异化内核（非线性报表 `ReportDef` / `CellTpl` / 主格 / 表达式）对 AI **完全不可见**。
- **而且**：画布协议的**三种描述已经漂移**（13 / 9 / 8 个控件类型），漂移**已经造成一个静默删控件的 bug**（本文 §3.1，已复现）。

> 所以真正的差距不是「有没有 AI」。是**AI 被接在了产品的最外层，而项目最值钱的那一层对 AI 不透明**；并且**在收敛到「一份机器可读的真相」之前，每一分 AI 投入都在持续缴漂移税**。

---

## 1. 先纠正一个前提：本项目已经有 AI，而且比想象中完整

`openprint/src/ai/` 有 716 行、5 个文件，`designer-react` 里有完整 UI 接入。它不是玩具：

| 已有能力 | 位置 | 评价 |
| --- | --- | --- |
| 协议提示词 + 2 组 few-shot | `openprint/src/ai/schema.ts:14` `:36` | ✅ 少样本示例写得具体（含坐标换算演算） |
| OpenAI 兼容流式客户端（SSE + 非流式兜底） | `openprint/src/ai/client.ts:47` | ✅ 连「端点忽略 `stream:true`」都兜了 |
| 容错 JSON 提取（3 级回退） | `openprint/src/ai/generate.ts:37` | ✅ 纯 JSON / ```json 块 / 首尾花括号 |
| **归一化 + 校验 + 把结构化错误回喂模型重试一次** | `generate.ts:118-163` | ✅ **这是真正的 AI-first 结构**，不是「生成完就完」 |
| 输出修复层（补 id、坐标纠偏） | `openprint/src/ai/normalize.ts:70` | ⚠️ 见 §3.8，是表征问题的补丁 |
| 三种模式：新建 / 改当前模板 / **只改选中控件** | `designer-react/src/modals/AiAssistantModal.tsx:243` | ✅ 选区改写走 diff 应用（原位改/加/删） |
| provider 预设（OpenAI / DeepSeek / 通义 / Moonshot） | `openprint/src/config/ai-settings.ts:24` | ✅ |

**结论：不是「从 0 开始做 AI」，而是「已有的这层没有长在内核上，也没有长在平台接口上」。**

---

## 2. 理念差别

| 维度 | 本项目现状 | 当前 AI-first 理念 |
| --- | --- | --- |
| **产物是什么** | 人用设计器**画**出来的版面 + 手写的绑定声明 | 一段**意图描述**，系统负责编译 |
| **谁在写** | 人（AI 是辅助按钮） | AI 是一等作者，人做审阅 |
| **能力怎么被发现** | 读 Rust / TS 源码，或看设计器面板 | 运行时**能力清单**（schema / manifest / tool 定义） |
| **错误怎么表达** | 中文散文（且两套方言，见 §3.4） | 结构化 code + 可操作的修复提示 |
| **失败怎么处理** | **披露**（横幅 / 响应头 / 日志），不中断 | **必须响**——agent 没有眼睛去看横幅 |
| **正确性靠什么保证** | 可判定不变量 + 故障注入（很硬） | 同左，**外加**「让 agent 自己能看出来错了」 |
| **AI 在哪** | 产品**内部**的一个前端功能 | 产品**对外**是一组工具（MCP / API） |
| **凭证模型** | 每个浏览器一份 key（`localStorage`） | agent 有自己的身份与授权 |

### 最本质的一条

本项目的正确性哲学是**「确定性 + 可判定」**：同一份模板 + 同一份数据 → 逐字节相同；验渲染只能截图数像素；docx 只能用四条不变量替代 Word。

**这与 AI-first 不冲突，反而正是 AI-first 需要的地基。** 冲突在于：这套纪律目前是**开发者面向**的（脚本、单测、探针），而 AI-first 要求它**agent 可调用**。也就是说——**你有真相，但只对人开放。**

---

## 3. 差距清单（按优先级，每条带证据）

### 3.1 【P0】三份协议描述已经漂移，且已造成静默数据丢失（**已复现**）

同一个「画布控件类型」集合，仓库里有**三份互不相同的声明**：

| 声明处 | 类型数 | 缺哪些 |
| --- | --- | --- |
| `openprint/src/core/spec/template.schema.json`（`definitions.component.type`） | **13** | — （**这是对的**） |
| `openprint/src/types/control.ts:10-23` `ControlType` | **13** | — （与 schema 一致） |
| `openprint/src/ai/normalize.ts:8-18` `VALID_TYPES` | **9** | `chart` `math` `signature` `labelgrid` |
| `openprint/src/ai/schema.ts:14` 提示词散文 | **8** | `zone` `chart` `math` `signature` `labelgrid` |

`normalizeControl` 对不在 `VALID_TYPES` 里的类型**返回 `null`**，调用方 `.filter(c => c !== null)` 直接丢掉：

```ts
// openprint/src/ai/normalize.ts:32-34
const type = raw.type as ControlType
if (!VALID_TYPES.includes(type)) return null      // ← 静默丢弃，无日志无错误
```

**后果链（已逐环验证）：**

1. 用户选中画布上的一个**图表**控件，让 AI「换个配色」；
2. 模型按提示词要求「保留 id、不改 type」返回了 `type:"chart"`；
3. `normalizeControl` 把它变成 `null` → 被过滤掉；
4. `diffSelectedControls`（`openprint/src/design/ai/shared/ai-assistant-logic.ts:66`）：
   `removedIds = lockedIds.filter(id => !returnedIds.has(id))` → 该控件进 `removedIds`；
5. `AiAssistantModal.tsx:250` → `s.removeControl(id)` → **控件从画布上消失**；
6. `AiAssistantModal.tsx:251` 弹出**绿色成功提示**：`已应用到选中控件（改 0 / 加 0 / 删 1）`。

**复现（本次实际跑过，4 failed / 2 passed）：**

```bash
W=/tmp/ai-proof && rm -rf $W && mkdir -p $W
ln -sfn /Users/lushaohui/project/report/openprint/node_modules $W/node_modules
cp /Users/lushaohui/project/report/openprint/src/ai/normalize.ts $W/
cat > $W/proof.spec.ts <<'EOF'
import { describe, it, expect } from 'vitest'
import { normalizeTemplate } from './normalize'
const mk = (type: string) => ({ document: { page: { width: 100, height: 150 },
  sections: [{ type: 'body', components: [{ type, left: 0, top: 0, width: 40, height: 20 }] }] } })
for (const t of ['text', 'zone', 'chart', 'math', 'signature', 'labelgrid']) {
  it(`保留 ${t}`, () => {
    const body = normalizeTemplate(mk(t)).document.sections.find(s => s.type === 'body')!
    expect(body.components!.map(c => c.type)).toEqual([t])
  })
}
EOF
cd $W && node node_modules/vitest/vitest.mjs run
```

结果：`text` / `zone` 通过；`chart` / `math` / `signature` / `labelgrid` **全部返回 `[]`**（控件凭空消失）。

> 这是本项目最讨厌的那类 bug：**看着成功、结果少东西**。
> 注意它**不是 AI 的错**，是**三份声明漂移**的错——而漂移之所以能发生，是因为没有任何东西在盯着它们一致。

### 3.2 【P0】AI 只覆盖三种「表格模型」中的一种

本项目的核心事实是**三个「表格」不是一回事**（见 `MEMORY.md`）：自由画布 / 表格控件 / **非线性报表**。AI 只碰第一个：

- `ai/schema.ts` 的协议摘要**整篇**是 `component{left,top,width,height}`——静态版面。
- 非线性报表的 `ReportDef`（`CellTpl` / `main` 主格 / `expand_type` / `{{...}}` / `=ds1.city`）在 `ai/` 下**一次都没出现**（`grep -rn 'ReportDef\|CellTpl\|expand' openprint/src/ai/` 无命中）。

**即：AI 会画固定版面，但不会做「会长的报表」——而那才是这个项目区别于任何模板编辑器的东西。**

### 3.3 【P0】`ReportDef` 没有 schema，所以非线性报表**既不能生成也不能校验**

- 唯一的 schema 是 `openprint/src/core/spec/template.schema.json`，描述的是**自由画布**（`Document→Page→Section→Component`）。
- `ReportDef` 的形状只存在于 Rust 结构体（`print-server/src/report/model.rs`）与 TS 类型里；`CellModel` 有 **22 个字段**，`CellTpl` 另有 11 个。
- 实测：`GET /api/report/sample-template` 返回的是**内层 `template`**（`{sheets, datasets}`，7 926 B），而 `GET /api/reports/:id` / `PUT /api/reports/save` 用的是**外层 `ReportDef`**（实测 10 个键：`format` `version` `id` `name` `description` `updatedAt` `template` `sources` `params` `options`）。两个端点名字只差一个 `s` 和一个 `:id`，形状却是「内层 / 外层」两回事。

→ 一个 agent 想「存一份报表」，得先猜外层结构；想「生成一份非线性模板」，得先读 Rust 源码。**没有 schema 就没有可靠的生成-校验-重试闭环**（而画布那侧已经有了，见 §1）。

### 3.4 【P1】错误是散文，而且是两套方言

实测三个请求：

```
POST /api/report/render   → 400 text/plain  「模板中没有 sheet」
GET  /api/reports/../../etc/passwd
                          → 404 text/plain  「报表 id 不合法（只允许字母数字、-、_，最长 80）: "../../etc/passwd"」
GET  /api/reports/nope    → 404 text/plain  「报表不存在: nope」
PUT  /api/reports/save    → 422 text/plain  「Failed to deserialize the JSON body into the target type:
                                              missing field `format` at line 1 column 51」
```

两个问题：

1. **没有错误码。** 全部是 `(StatusCode, String)`（`print-server/src/report/mod.rs` 内 20+ 处 `map_err(|e| (StatusCode::X, e))`）。agent 只能正则中文散文来分支。
2. **两套方言。** 业务错误是中文 `text/plain`；axum 的 `Json` 提取器错误是英文 serde 散文 + 422。同一个 API 两种语言两种形状。

另外**时间格式也不统一**：`/api/reports` 的 `updatedAt` 是 UTC（`...T02:24:57Z`），`/health` 的 `time` 是本地（`+08:00`）。

### 3.5 【P1】「披露而不失败」对人是够的，对 agent 是致命的

这是本项目最需要重新审视的一条**设计取向**。已知的三条「静默失败」红线（报表目录跟 cwd 走、预览与导出两套表头口径、`connId` camelCase），当前的处理方式是**披露**：横幅 / `/health` 字段 / 响应头。

对人是合理的——**人看得见横幅**。但：

- agent 不会去看横幅，它只会看**返回值**；
- `/health` 确实暴露了 `reportsDir`（实测：`"reportsDir":"/Users/lushaohui/project/report/print-server/reports"`）——**这是很好的设计**，但它是**可选项**，不是**必答项**；
- 实测 `POST /api/reports/sales-by-region/run` 直接 400：`数据集「ds1」取数失败：sqlite 文件不存在: /tmp/report-demo.db`——仓库里那份**样例报表开箱即不可跑**，而 agent 拿到的只有这一句散文。

**AI-first 的判据：agent 拿到的每一个返回值，都要自带「这次结果可不可信」的机器可读信号。** 本项目已经有一半：

```rust
// print-server/src/report/mod.rs:103-106
/// 会静默产出错误数据的可疑情况（父格查不到、表达式解析失败等）。
/// 不中断渲染，但调用方应当展示给用户。
pub warnings: Option<Vec<String>>,
```

**`warnings` 存在、`dump=true` 的展开轨迹也存在——但都是散文，且默认关闭。** 离「agent 能自检」只差一层结构化。

### 3.6 【P1】没有工具面

- `grep -rn 'mcp|modelcontextprotocol'`（排除 `node_modules`）→ **0 命中**。
- 路由清单（`print-server/src/main.rs:183-224`）共 **33** 条（`grep -c '\.route('`），**全是给人/给前端用的 REST**，没有一条是「描述我能干什么」。
- AI 层是**纯前端**（`ai/client.ts` 直连 `chat/completions`），**不经过 `print-server`**。

**后果：外部 agent（Claude / Cursor / WorkBuddy / 任意 MCP 客户端）无法驱动这个引擎。** AI 只是产品内部的一个按钮，产品对外不是一个工具。

### 3.7 【P2】AI 的测试不在任何闸里

`scripts/ts-test.sh` 只拷 `openprint/src/report/*.ts`（脚本注释里自己写了「拷的是整个目录，白名单就是上次漏跑新 spec 的原因」），**不覆盖 `openprint/src/ai/`**；`grep -rn 'src/ai|ai.spec' scripts/` → **0 命中**。

即 `openprint/src/ai/ai.spec.ts` 的 7 条用例**没有任何脚本会跑**。§3.1 的 bug 能长期存活，这是直接原因之一。

### 3.8 【P2】坐标「铁律」+ 启发式纠偏 = 在给表征问题打补丁

`ai/schema.ts:31` 用加粗的「**坐标铁律**」反复强调「`left/top` 是相对内容区，不要包含 margin」——**提示词里要写「铁律」，说明模型反复做错**。而 `normalize.ts:87-104` 又加了一层启发式纠偏：

```ts
// 触发条件：minLeft ≈ margin.left 且 minTop ≈ margin.top → 统一减去页边距
if (minLeft > 1 && Math.abs(minLeft - ml) <= EPS && minTop > 1 && Math.abs(minTop - mt) <= EPS)
```

- **假阴性**：模型只错一个轴时（比如只把 margin.left 算进去了）不触发 → 整页右移；
- **假阳性**：一份**合法**的设计若最左控件恰好在 `x=margin.left`、最上恰好在 `y=margin.top`（两轴同时命中）→ 被无端左移上移。

这是在**用启发式去猜模型的意图**，而不是**让表征本身无歧义**。AI-first 的做法是：坐标只有一种原点（或坐标带显式参照系），错就**报错**，不猜。

### 3.9 【P2】凭证模型与 agent 不共享

`ai-settings.ts:32` → `localStorage['openprint:ai:config']`，`apiKey` **明文存本地**（注释自陈「仅本地单用户场景」），浏览器直连模型服务。

对人的单机场景这是合理的（零后端、key 不出本机）。但 AI-first 的凭证模型是：**agent 有自己的身份与授权，key 不随浏览器走**。当前模型下，换台机器 / 换个浏览器 = AI 能力归零；而 agent 也永远拿不到 key。

---

## 4. 改进路线

原则：**每一阶段独立可交付，且不破坏现有的确定性**。不要为了 AI-first 引入兼容层。

### 阶段 0：收敛真相 + 让静默失败变响（不新增能力，只消灭歧义）

这是**唯一必须最先做**的一步，因为后面每一步都建立在它之上。

| 动作 | 具体做法 | 为什么先做 |
| --- | --- | --- |
| **0.1 三份协议声明收敛成一份** | 以 `template.schema.json` 为唯一真相，`VALID_TYPES` 由它派生（或反过来生成 schema）；补上提示词里缺的 5 类 | 直接消灭 §3.1 的静默删控件 |
| **0.2 加一条「一致性闸」** | 一条单测：断言 `schema.enum ≡ ControlType ≡ VALID_TYPES`。**这条闸必须能被证明会红**（故意删一个类型 → 必须失败） | 把「未来的漂移」从静默变成红灯 |
| **0.3 归一化丢弃必须出声** | `normalizeControl` 丢控件时返回原因；`generateTemplate` 把「丢了 N 个控件（类型 X）」放进 `error`/警告，并**阻止** diff 把它当成「用户要删」 | 未识别的类型不能再等于「删掉」 |
| **0.4 AI 的测试进闸** | `ts-test.sh` 覆盖 `openprint/src/ai/`（同 `src/report` 的办法：整目录拷 + 通配 include） | §3.7：不在闸里的测试等于没有 |

### 阶段 1：把内核暴露成「可生成 + 可校验」

| 动作 | 具体做法 |
| --- | --- |
| **1.1 给 `ReportDef` 出 JSON Schema** | 从 `model.rs` 的 serde 结构体生成（`schemars` 是 Rust 侧最省力的路），覆盖 `CellTpl` / `CellModel` / `sources` / `options` / `page` |
| **1.2 暴露「能力清单」端点** | `GET /api/report/capabilities` → 控件类型 / 展开类型 / **表达式函数全表**（现在只在 `engine.rs:3006` 的大 `match` 里，只能读源码）/ 单元格字段 / 支持的数据源引擎 / 导出格式 |
| **1.3 让生成器变成 API** | 现在「分组汇总 / 交叉表」等生成器是**前端**逻辑；把它变成 `POST /api/report/generate {intent}`，返回 `ReportDef`。**这是「意图 → 模板」的编译器入口**，也是 AI 最该调用的那个原语 |
| **1.4 错误结构化** | 错误体统一成 `{code, message, path?, hint?, details?}`，保留人话 message；补错误码。**先把两套方言并成一套** |

### 阶段 2：工具面（让外部 agent 能用）

| 动作 | 具体做法 |
| --- | --- |
| **2.1 MCP server** | 把阶段 1 的端点包成工具：`capabilities.describe` / `report.list` / `report.get` / `report.save` / `report.run` / `report.export` / `dataset.preview` / `template.validate`。`print-server` 已是 Rust，加一个 MCP 入口即可 |
| **2.2 `template.validate` 独立成工具** | 纯校验、无副作用、幂等 —— **这是 agent 最重要的一个工具**，因为它把「生成-校验-重试」闭环从产品内部搬到 agent 手里 |
| **2.3 把 `warnings` 结构化** | `warnings: [{code, path, message, severity}]`，并**默认开启**。agent 每次 `run` 都能自检「这次结果可不可信」 |

### 阶段 3：闭环（AI 真正成为作者）

| 动作 | 具体做法 |
| --- | --- |
| **3.1 把 AI 从画布层扩展到非线性报表** | 复用已有的 `validate → 回喂错误 → 重试` 骨架（`generate.ts:118-163`），只是换成 `ReportDef` 的 schema。**骨架已经在，缺的是 schema 和提示词** |
| **3.2 用 `dump` 做自检通道** | `dump=true` 已经返回展开轨迹（`seq | pos | 文本 <- 层次坐标 | 行父 | 列父`）。让它成为 agent 的「看看我算得对不对」通道，而不是调试开关 |
| **3.3 凭证与授权** | key 从 `localStorage` 上移到服务端（或至少支持服务端持有）；agent 用 token 而非浏览器 key |

---

## 5. 不该做的（避免为了 AI-first 毁掉已有的东西）

1. **不要把确定性判断交给 LLM。** 本项目的强项是「可判定不变量」——渲染对不对由像素/不变量回答，不由模型回答。AI 负责**生成候选**，验证仍然归确定性工具。
2. **不要做「自然语言 → 直接渲染」跳过中间表示。** `ReportDef` 就是那个中间表示，它是本项目最值钱的资产。让 AI 产出 `ReportDef`，不要让它直接产 PDF。
3. **不要为了兼容旧输出引入兼容层。** 阶段 0.2 的一致性闸已经能保证迁移是安全的。
4. **不要先做「AI 对话式设计器」再补 schema。** 顺序反了就会像现在这样：先有 AI，后有漂移，再回来还债。
5. **不要因为「agent 会用」就放宽安全边界。** `id` 白名单、图片只收 data URI、URL 取数只在前端（不做后端 SSRF）——这些取舍**要保留**，并且要在能力清单里**明说**，让 agent 知道边界而不是撞上去。

---

## 附：本次分析的可复现证据

```bash
# 环境
curl -s --noproxy '*' http://127.0.0.1:18888/health
# → reportsDir / odbc 均暴露（好的设计）

# 错误形状（两套方言）
curl -s --noproxy '*' -X POST http://127.0.0.1:18888/api/report/render \
  -H 'Content-Type: application/json' -d '{"template":{"sheets":[]}}' -w ' [%{http_code} %{content_type}]\n'
curl -s --noproxy '*' -X PUT http://127.0.0.1:18888/api/reports/save \
  -H 'Content-Type: application/json' -d '{"id":"bad/id","name":"x","template":{"sheets":[]}}' -w ' [%{http_code}]\n'

# 内层/外层两种形状
curl -s --noproxy '*' http://127.0.0.1:18888/api/report/sample-template | head -c 200
curl -s --noproxy '*' http://127.0.0.1:18888/api/reports/sales-by-region | head -c 300

# 样例报表开箱不可跑
curl -s --noproxy '*' -X POST http://127.0.0.1:18888/api/reports/sales-by-region/run \
  -H 'Content-Type: application/json' -d '{}'
# → 400 「数据集「ds1」取数失败：sqlite 文件不存在: /tmp/report-demo.db」

# 三份声明漂移 + 静默丢控件：见 §3.1 的复现脚本

# AI 测试不在闸里
grep -rn 'src/ai\|ai.spec' scripts/    # → 无命中

# 没有 MCP
grep -rl 'mcp\|modelcontextprotocol' --exclude-dir=node_modules .   # → 无命中
```

### 本文未做的事（诚实声明）

- **没有修 §3.1 的 bug**。修法有两种（拓宽白名单 / 让丢弃出声），我倾向后者——**拓宽白名单会让模型有机会产出它并不理解载荷的图表控件**，而「出声」在任何情况下都是对的。这是取舍，应交由你定。
- **没有实测 `chart` / `labelgrid` 等控件在渲染器里是否真的完整可用**（只验证了 `ControlType` 与 schema 承认它们、而 AI 层不承认）。若它们其实半成品，那 §3.1 的「正确修法」还要再变。
- 阶段 1/2/3 的工作量**未做评估**，本文只给方向与依赖顺序。
