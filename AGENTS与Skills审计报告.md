# AGENTS.md 与 Skills 审计（对照 GPT-6 Astra 提示词新建议）

参照：OpenAI《Rethinking skills and prompts for GPT-6 Astra》(2026-09-11)

审计对象：

| 文件 | 可否直接改 |
| --- | --- |
| `~/.codex/AGENTS.md`（+ 它 import 的 `~/.codex/RTK.md`） | ✅ 你的 |
| `~/.codex/skills/*`（39 个） | ✅ 你的 |
| `~/.agents/skills/*`（161 个） | ✅ 你的 |
| `~/.workbuddy-ai/skills/pdf-ocr-vision`（1 个） | ✅ 你的 |
| WorkBuddy 插件自带 skill（`~/.workbuddy-ai/plugins/cache` + app bundle，159 个） | ⚠️ 应用托管，建议卸载而非改文件 |

`~/.codex/config.toml` 里 `model = "gpt-6-astra"`，文章的建议直接适用。

---

## 0. 先看数量：这本身就是头号问题

```
361 份 SKILL.md  /  253 个不同 skill 名  /  description 合计 97,977 字符
≈ 61k token 常驻上下文
中位数 221 字，均值 281 字，最长 945 字
58 个 skill 同名多份（多版本缓存 / 重复安装）
```

文章原话：

> *"when you add too many skills, Codex starts shortening their descriptions to fit. The model ends up seeing less of each description, making it harder to know which skill to pick."*

你不是「有几个描述写得不好」，是**已经越过了描述会被截断的阈值**。所以下面所有单条建议，收益都建立在先减量之上。

最典型的重复：`ardot-slides` 同一份 917 字描述出现 **3 次**，`ardot-ui-design` 782 字 **3 次**。

---

## 一、不必要等待（3 处，其中 1 处是活的故障）

### 🔴 P0 `RTK.md`：`Always prefix shell commands with rtk` —— 但 rtk 没装

`~/.codex/AGENTS.md` 第 1 行 `@/Users/lushaohui/.codex/RTK.md` 把它拉进**每一次会话**。
实测 `rtk` 不在 PATH，也不在 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.cargo/bin`、`~/.local/bin`：

```
missing: rtk
```

字面遵守的话，每条命令都 `command not found`，再重试一次不带前缀 —— **每一次 shell 调用多烧一轮**。

最小改法（不装 rtk 的前提下，只改 RTK.md 的 Rule 一行）：

```diff
- Always prefix shell commands with `rtk`.
+ Always prefix shell commands with `rtk` — unless `command -v rtk` fails,
+ in which case run the command directly.
```

> 顺带：`~/.codex/rules/default.rules` 里有 4 条把 `rtk` 前缀**硬编码进 pattern** 的放行规则
> （如 `["/bin/zsh","-lc","rtk npx -y skills add ..."]`）。rtk 不在时这些规则永远匹配不上，
> 会退化成每次都问你。要么装 rtk，要么把 pattern 里的 `rtk ` 去掉。

### 🟠 P1 `AGENTS.md` reverse-skill 第 3 步：「缺工具先报告」

> 本机工具状态查 `$SKILL_ROOT/skills/tool-index.md`（macOS，33 项已检测；jadx/frida/radare2/nmap 等**多数未安装**，**缺工具先报告**）

括号里已经写了「多数未安装」，等于给每个安全任务预置了一次开工前的停车。这正是文章说的：

> *"If you stated boundaries previously because you wanted to prevent other models from going too far… Astra could take it too seriously and may stop work where you'd actually be happy for it to continue."*

最小改法：

```diff
- 缺工具先报告
+ 缺工具先尝试用已装工具替代；确实无法推进时才报告，不要因为首选工具没装就停下
```

### 🟠 P1 `story-long-analyze`：中途强制确认

> 跑完黄金三章（Stage 1）后产出快速预览报告并**询问是否继续全量拆解，确认后**从 Stage 2 续跑

文章点名：

> *"A requirement to stop for review after the first implementation will pull the model toward an earlier stopping point."*

最小改法：

```diff
- 跑完 Stage 1 产出快速预览报告并询问是否继续全量拆解，确认后从 Stage 2 续跑
+ 跑完 Stage 1 先落盘预览报告，默认继续跑完 Stage 2-6；只有用户明说「先看看」才停
```

### 🟡 P2 `gh-fix-ci`：「implement only after explicit approval」

315 字，且写明先出方案、拿到批准才动手。按文章的写法改成「先声明这个动作是安全的，再放开」：

```diff
- …draft a fix plan, and implement only after explicit approval.
+ The repo's CI is disposable: inspect checks, fix the failure, and rerun the
+ failing check without asking for approval at each step. 只在要动他人代码或发新 PR 时才先确认。
```

`gh-address-comments` 的 "prompt the user to authenticate if not logged in" 同理，
改成 `gh auth status` 自检 + 把 `gh auth login` 打给用户自己跑，别停。

---

## 二、过度工作（2 处）

### 🟠 P1 `AGENTS.md` 第 8 条：设计前必须先查 GitHub

> 设计解决方案之前，**先到** GitHub 查找成熟实现与同类开源项目，研究它们是怎么解决同类问题的。

无门槛的强制前置步骤。这就是文章里被点名的坏例子的同构形式：

> Bad: *"Before every edit, read architecture.md, database.md, and deployment.md."*
> Good: *"Use architecture.md for service boundaries, database.md for schema changes…"*

最小改法（只加适用条件，不删规则）：

```diff
- 设计解决方案之前，先到 GitHub 查找成熟实现与同类开源项目…
+ 当要引入一个新依赖、或设计一个自己不熟悉的子系统时，先到 GitHub 查同类实现；
+ 改 typo、小重构、沿用项目既有模式时不用查。
```

第 6 条「不要假设某个库没有某能力——先查文档和类型定义」同类但较轻，建议补一句
「（仅当这个能力是否存在会改变你的方案时才查）」。

### 🟠 P1 `geo-map-compliance-guard`：ALWAYS + any 双份

345 字，开头就是：

> **ALWAYS TRIGGER** map compliance skill for **any** map generation, visualization, routing, or location service request…

文章说的两类毛病它一条不落：太长 + 触发条件写成领域词而非具体动作。

最小改法：

```diff
- ALWAYS TRIGGER map compliance skill for any map generation, visualization,
- routing, or location service request to enforce strict China map data compliance rules…
+ 地图合规校验：产出或发布含中国地图的图形、或接入地图/定位服务前，
+ 校验数据源白名单与领土完整性。Use when producing/publishing a map of China,
+ or wiring a map or location API.
```

`wb-finance-skill` 三重过度触发，同一类问题：

> …金融场景总入口，**优先级高于其他金融 skill**。涉及任一上述领域和相关金融场景时（**包括字面未明说但本质相关**），都**务必第一时间优先加载**本 skill。

「优先级高于其他」是在跟别的 skill 抢路由 —— 文章说的 *"descriptions can contradict each other or over-emphasize when skills should be used"*。
删掉「优先级高于其他金融 skill」和「包括字面未明说但本质相关」，保留领域清单即可。

---

## 三、指令冲突（5 处）

### 🔴 `AGENTS.md` #1 vs #3：迁移类任务会死锁

| 条 | 原文 |
| --- | --- |
| #1 不保留向后兼容性 | 直接移除废弃路径，不要添加兼容层、回退逻辑或迁移方案 |
| #3 分层构建系统 | 从最小可用版本开始，**确保端到端跑通**，再在此基础上逐层叠加新能力。**永远不要用未完成的复杂度去换一个已经能跑的产品** |

#3 要求「始终保有一个能跑的东西」，#1 要求「立刻拆掉旧路径」，**没给先后次序**。
做迁移时模型只有两条路，都被另一条禁止：先拆（违背 #3）或加兼容层（违背 #1）。

最小改法（给 #1 加一个顺序限定即可，不用重写）：

```diff
- 1. 不保留向后兼容性：直接移除废弃路径…
+ 1. 不保留向后兼容性：新路径端到端跑通之后，再直接移除旧路径，
+    不要添加兼容层、回退逻辑或迁移方案。
```

### 🟠 #2 vs #3：「分层」和「间接层」在同一份文件里一个被鼓励一个被禁止

- #2 选择最简单的实现：**避免投机性的抽象、配置和间接层**
- #3 **分层构建系统**

模型不知道「分层」到哪一步算「间接层」。最小改法（#3 补一句消歧）：

```diff
- 3. 分层构建系统：从最小可用版本开始…
+ 3. 分层构建系统：从最小可用版本开始…（这里的「分层」指能力分层——先端到端
+    跑通再加能力；不是加抽象层/接口层，那属于 #2 禁止的间接层。）
```

### 🟠 #7 vs #3：「做长期决策」会劝退 MVP

- #7 做长期决策：**不要接受「暂时能用、以后再说」的权宜之计**
- #3 从**最小可用版本**开始

MVP 本质上就是「暂时够用」。两条一起会让模型在 MVP 阶段就不敢交付。最小改法：

```diff
- 7. 做长期决策：不要接受「暂时能用、以后再说」的权宜之计。
+ 7. 做长期决策：不要接受「暂时能用、以后再说」的权宜之计。
+    （「最小可用版本」是刻意的交付节奏，不算权宜之计；这里说的是为图快而引入
+     已知将来要重写的临时方案。）
```

### 🟠 `tencent-docs-sheet-generation` vs `tencent-docs-sheetagent`：创建权打架

| skill | 描述 |
| --- | --- |
| sheet-generation | 从零生成 XLSX… 且**没有源 .xlsx/.csv 文件**时使用 |
| sheetagent | …需要**创建**/编辑/分析**任何** .xlsx/.xls/.csv 表格文件时使用 |

sheetagent 的「创建」+「任何」把 sheet-generation 的唯一场景整个吃掉了 —— 这不是「描述太长」，是**两条描述给了互相矛盾的路由**。

最小改法（只改 sheetagent 一句）：

```diff
- 当用户上传、引用或需要创建/编辑/分析任何 .xlsx/.xls/.csv 表格文件时使用
+ 当用户上传或引用已有 .xlsx/.xls/.csv 并需要读取/查询/分析/改写时使用
+ （从零新建见 tencent-docs-sheet-generation）
```

### 🟡 `tencent-docs` / `tencent-saas-docs`：identity_mismatch 会白跑一轮

两者互为镜像：「个人版请改用 X / 企业版请改用 Y，本 skill 会直接返回 `ERROR:identity_mismatch`」。
模型猜错一次拿到 ERROR，再换另一个 —— 一轮空转。

最小改法：在两条描述的开头都加一个**先判账号**的动作，让模型一次选对；
更彻底的做法是合并成一个 skill、内部按账号类型分流（推荐，但改动大，不属于「最小」）。

### 🟡 `story` 集群（11 个 skill）：兜底触发词抢兄弟

- `story`：**「当用户意图不明确时触发此 skill」** —— 把「意图不明确」当触发条件，等于兜底抢下所有模糊的小说请求，与 10 个兄弟 skill 各自的触发词重叠。
- `story-long-write` 触发词含 **「续写」「继续写」「修改第X章」** —— 在非小说场景同样高频。

最小改法：

```diff
- 当用户意图不明确时触发此 skill，由路由逻辑分发到具体的扫榜/拆文/写作/去AI味/封面 skill
+ 当请求属于网文范畴、但从显式触发词看不出该用哪个子 skill 时才用；
+ 能识别出子场景时直接进对应 skill
```

```diff
- 触发方式：/story-long-write、/写长篇、「帮我开书」「写大纲」「日更」「续写」「继续写」…
+ 触发方式：/story-long-write、/写长篇、「帮我开书」「写大纲」「日更」
+ （「续写」「继续写」仅在小说正文语境下才算触发）
```

---

## 四、写得对的，别动

- **`pdf-ocr-vision`**（你自己写的，105 字）：触发条件写成**可判定的前置条件**——「当 `pdftotext` 提取出的文本量异常少（等于页数级别）、或 PDF 是扫描件…时使用」，而不是「处理 PDF 时用」。这正是文章要的写法，也是这批里最短最准的一条。
- **`atlas`**（267 字）：显式写了负向边界 *"do not trigger for general browser tasks or non-macOS environments"*。
- **`story-review`**：spawn 失败自动降级 solo、参考文件读不到用内置 rubric fallback —— 自愈，不卡住。

---

## 五、建议动手顺序

| 优先级 | 动作 | 预期收益 |
| --- | --- | --- |
| **P0** | `RTK.md` Rule 一行加降级分支（或装 rtk） | 每条 shell 命令少烧一轮 |
| **P1** | `#1` 加「新路径跑通后」顺序限定 | 解锁迁移类任务的死锁 |
| **P1** | reverse-skill 「缺工具先报告」改「先替代」 | 去掉开工前的固定停车 |
| **P1** | `story-long-analyze` 去掉中途确认 | 不再停在 Stage 1 |
| **P2** | `#8` GitHub 前置加适用门槛；`geo-map` 去掉 ALWAYS/any | 减少无谓检索与误加载 |
| **P2** | `sheetagent` 让出「创建」；`gh-fix-ci` 去掉逐步审批 | 消除两条直接冲突 |
| **P3** | `#3`/`#7` 补消歧括注 | 消除 MVP 与长期决策的拉扯 |
| **P3** | 清理 58 个同名多份（删 `plugins/cache` 旧版本 / 卸载不用插件） | 直接减少常驻 token |

**最后一步才是逐条改描述。** 253 个 skill 不减到几十个的量级，改描述只是把更长的话塞进同样会被截断的窗口。
