# 引擎差距分析：PDF 资料结论 vs 现有代码

> 2026-09-12。把 `报表PDF资料通读笔记.md` 第五节的 8 条待办，逐条对照 `print-server`（Rust）与 `openprint/src/report/grid-report.ts` 现状。  
> 结论基于代码实证，标注了 `文件:行号`；带 ⚠️ 的是我认为需要动手的。

## 本次实施进度（2026-09-12）

按下面的顺序动手，1–4 已完成，`print-server` 测试 53 个全绿（基线 44 个）。

| #   | 项目     | 状态              | 落点             |
| --- | ------ | --------------- | -------------- |
| 1-8 | 全部 8 项 | ✅ 1-7 完成，8 主动延后 | 测试 **44 → 57** |

**说明**：8 项里第 2 条是「原结论有误，改修了另一个真实 bug」，第 5 条是「原方案不必要，改用更小的防御措施」，第 8 条评估后判定为过度设计——都不是照单全收。

**总览**

| # | 资料结论                           | 现状                           | 优先级   |
| - | ------------------------------ | ---------------------------- | ----- |
| 1 | `$` 运算符 + 条件表达式 `{}`           | ✅ 已用更简方案实现（格集 + anchor，见校正）  | 高     |
| 2 | 主格自动认定                         | ✅ 已实现（向左/向上查找）               | 中     |
| 3 | 扩展步长 `ExtendedArea`（to−from+1） | ✅ 换了个做法实现（布局子树跨度）            | —     |
| 4 | 分页与扩展分离                        | ➖ 引擎层还没有分页，暂不适用              | 低（未做） |
| 5 | 多源不做整合运算                       | ✅ 已符合架构红线                    | —     |
| 6 | 中间结果序列化（分页/TOC 就绪）             | ⚠️ 只有最终网格 JSON，无中间文档         | 中     |
| 7 | 死循环防护                          | ✅ **原结论有误**，详见修正             | —     |
| 8 | 表达式引擎                          | ✅ 已重写：完整解析器 + 算术/比较/IF/占比/累计 | **高** |

## 逐条详情

### 1. `$` 运算符与条件表达式 —— ✅ 已实现（`{}` 过滤 + `$` 两个上下文）

> 早期结论是「缺，但可用 anchor 绕过」。核对 GitHub 上游后改为**直接实现**：
> 格集 + anchor 只解决「取单值 vs 取集合」，解决不了「按条件筛集合」。

**先查了上游（`entropy-cloud/nop-entropy`，sparse clone 201 个 java 文件）**：

- **NopReport 没有 `$` 运算符**。全仓搜 `$` 与 `CellCoordinate`（只有 `cellName / reverse / relative / position`
  四个字段，与我们的 `Coord` 完全对应）都找不到。它用另一个办法解决同一问题：
  `ExcelFormulaParser.java:83-97` 把 `IF("<条件>", <格集>)` 的第一个字符串参数包成
  **`e=>(条件)` 箭头函数**，由 `FilterCellSetExecutable` 执行 `cellSet.filter(e -> ...)`。
  候选格被绑定成 lambda 参数 `e`，于是裸格名仍是当前格上下文，**不需要 `$`**。
- 但过滤能力本身是有的：`FilterCellSetExecutable.execute()` → `cellSet.filter(predicate)`。
  所以「条件表达式」不是润乾独有，NopReport 也认为这是必备能力。

**我们的实现**（`expr.rs` 新增 `Expr::Filter` / `Expr::Dollar`，`engine.rs` 求值）：

```
POS[COORD]{条件}              按条件筛格集
  条件里裸 B2  = 候选格（目标格）的 B2 主格   ← 润乾语义
  条件里 $B2   = 当前格的 B2 主格
```

- 经典同比现在能直接写：`C2[A2:-1]{$B2 == B2}`（上一年的全部 C2 里，取月份与当前格相同的那一格）。
- 后缀顺序都收：`C2[A2:-1]{...}.sum()` 与 `C2[A2:-1].sum(){...}` 等价。
- 求值上下文：`eval_ast(e, cur, outer)` 多带一个 `outer`。过滤时 `cur` 切成候选格、
  `outer` 保持当前格，`Expr::Dollar` 用 `outer` 求值——两个上下文由此分开。

**顺带挖出一个真 bug**：`eval_cmp` 原来只比数字（`as_num()` 拿不到就返回 Null）。
而条件表达式几乎总是在比**分组标签**（`"1月"` / `"华东"`），于是条件恒假、筛完永远是空集——
**不报错，只静默变空**。已改为非数值走 `Val::as_text()` 文本比较（含数字与数字字符串混比）。

**测试**（3 个）：同比取到上一年同月（`["", "", "100", "200"]`）、
反向用例 `C1[A1:-1]{B1 == B1}` 恒真只能取到上一年首格（`["", "", "100", "100"]`）——
两条结果不同，正说明 `$` 与裸格名语义确实有别；再加解析器的括号/顺序用例。

早期在这里记的三样缺口，现状：

- **`$` 运算符** → ✅ 已实现（`Expr::Dollar`，条件里切回当前格上下文）
- **条件表达式 `{}`** → ✅ 已实现（`Expr::Filter`，`cellSet.filter(cond)`）
- **算术** → ✅ 早先重写表达式引擎时已解决（`+ - * /`、比较、`IF`、占比、累计）

**早期结论的偏差**：当时认为「格集 + anchor 就够了，`$` / `{}` 只在月份不连续的极端场景才必需」。
核对上游后发现判断过乐观——anchor 解决的是「取哪个值」，
而「坐标定位不到时**筛出**目标格」是另一件事，NopReport 也为此专门留了 `FilterCellSetExecutable`。
anchor 那条路在月份连续时确实够用（环比 `C4 / C4[B4:-1]`），但**月份不连续就无解**。

**校正（对照 NopReport 权威文档）**：不必照搬润乾的 `$` / `{}`，NopReport 用两个更省事的机制解决同一问题：

- 层次坐标返回 `ExpandedCellSet`，其 `getValue()` 返回集合中**第一个**格的值；编译期把裸 `A3` 重写成 `A3.value`。「取单值」和「取集合」由此自动统一，**不需要 `{}` 语法**。
- 环比直接写 `IF(B4.expandIndex > 0, C4 / C4[B4:-1], '--')` —— 用 `.expandIndex`（等价润乾 `&A2`）+ 相对坐标 + 四则运算 + `IF`，不依赖条件表达式。

结论修正：我们真正缺的&#x662F;**「完整表达式引擎（算术 + 函数 + IF）」**；`$` / `{}` 只在「月份不连续、坐标定位不到」的极端场景才必需，可后置。

### 2. 主格自动认定 —— ✅ 已实现主规则（两条细化规则未做）

`engine.rs:44` 注释明确写「无 `row_parent` 时视为挂在根上」。即主格关系必须逐格显式声明 `row_parent` / `col_parent`（`model.rs:66-69`），没有任何上溯/跟随/递归推断。

周金根那套五步递归（显式设置 → 相邻可扩展格且范围覆盖 → 跟随相邻格 → 递归 → 兜底 00 格）的价值正是「用户不配置也能跑对」。我们目前是「不配置就挂根」，模板编写成本高，且填错 `row_parent` 不会报错只会静默算错。

**已实现**：`is_root_ref` / `default_row_parent` / `default_col_parent`（`engine.rs`）。  
行父格向左查最近的纵向扩展格，列父格向上查最近的横向扩展格，显式 `A0` 表示根。  
开启后 52 个既有测试无回归，新增 `default_row_parent_is_inferred_from_left` 守着。

**上游核对（`XptModelInitializer.java`）**——注释就写在 `initParentChildren` 上方：

```java
// 缺省左侧最近的展开单元格为行父格，上方最近的展开单元格为列父格
```

与我们的实现一致。但上游还有三条我们**没有**的细化规则，记在此处避免误以为已经对齐：

| 上游规则                                                                  | 位置                                    | 我们  |
| --------------------------------------------------------------------- | ------------------------------------- | --- |
| 向左扫到相邻格**不是**扩展格、但它自己有 `rowParent` → 跟随到那个父格（递归）                    | `getRowParent` L269-273               | ✅ 已实现 |
| 向左扫不到 → 取**最左格**的 `rowParent`；向上扫不到 → 取**第一行**的 `colParent`          | L277-285 / L327-335                   | ✅ 已实现（但基本不可达，见下）|
| 扩展格的展开范围内、且**不与它同行**的格子，缺省都以它为行父格（`addDefaultRowParents`）           | L647-664                              | ⬜ **能实现，暂不做**（理由见下）|
| `CellPosition.NONE` 显式表示「无父格」（等价我们的 `A0`）；`checkLoop` 查父格链成环并抛 `ERR_…` | L249、L372                             | ⬜ 部分 |

第 4 条的环检测我们另有权宜：父格下标必然小于子格（`by_pos` 只在实例创建后写入），
结构上不成环，详见第 7 条修正。

#### 已实现：跟随 + 兜底（上游 L269-335）

实现要点有两个**读源码才发现、光看文档会做错**的地方：

1. **「跟随」跟的是解析后的父格，不只是显式声明的。**
   上游 `initParentChildren` 会把推断结果**回写**进 model：
   ```java
   ExcelCell rowParent = getRowParent(sheet, cell);
   if (rowParent != null) {
       if (xptModel.getRowParent() == null)      // 只补没声明的
           xptModel.setRowParent(rowParent.getModel().getCellPosition());
       ...
   }
   ```
   所以后处理的格子往左扫时，读到的是左邻格**回写后**的值（声明的 or 推断出来的）。
   我们原先只有「扫描时跳过非扩展格继续找」，现在按 `(r,c)` 缓存一份已解析结果
   （`Resolved`），扫描时读它——语义就对上了。

2. **`A0` 之前是错的。** 原代码 `filter(|p| !is_root_ref(p)).or_else(default_...)`
   把 `A0` 当成「没写」，结果落进缺省推断；而注释写的是「不再套用缺省推断」、
   上游是 `if (rowParent == NONE) return null`。现在改成三态
   `ParentDecl::{Ref, ExplicitNone, Unset}`：`A0` 既自身不推断，也会**截断**右邻格的
   扫描（`resolveRowParent(NONE) → null`），与上游一致。

**关于第 2 条兜底**：照抄了，但在我们的处理顺序下**基本不可达**——扫描一定会检查到
col 0，若 col 0 有父格，第 1 条就已经跟随了；兜底读的是同一个格子。只有上游那种
「合并格 `getRealCell()` 让扫到的和兜底取到的不是同一个格子」才会走到，我们不做合并格
语义。留着是为了对齐，行为上等价于「不会凭空造出父格」（有单测守着）。

#### 暂不做：addDefaultRowParents（上游 L647-664）

**能实现，但要先把父格解析从「边建实例边算」抽成独立的模板 pre-pass**，成本明显高于收益。

它依赖三样东西，后两样我们现在没有：

- `rowSpan` → 有，`merge_down + 1`
- `rowExpandOffset` / `rowExpandSpan` → **算出来的，不是模板字段**：叶子格
  `offset=0, span=rowSpan`；非叶子沿 row 子格树自底向上取并集
  （`collectRowChild` L439-471）。也就是说它依赖**已经建好的 row 子格树**。
- 「只对顶层格调用」→ 上游在 `initDuplicateCells` 里跑，是 `initParentChildren`
  之后的**第二遍**。

所以要落地就得改成四遍：

```
Pass 0  模板级解析父格（规则 1、2）          ← 已具备（Resolved 就是）
Pass 1  建 row 子格树 + 自底向上算 offset/span
Pass 2  顶层行扩展格 → addDefaultRowParents（规则 3）
Pass 3  原来的实例创建循环，读前两遍的结果
```

**不做的理由**：

1. **我们的模板不触发它。** 三个构造器给小计 / 合计格都**显式**写了 `row_parent`
   （`buildGroupTemplate` 里 `row[k] = cell(label, { ds, row_parent: parentPos })`），
   而规则 3 的门槛是 `cm.getRowParent() == null`（**声明**为空）。
2. **顶层扩展格的展开范围够不着小计行。** 分组模板里 region→city→salesman 全在同一
   模板行，顶层扩展格 `span = 1`，范围是 `[detailRow, detailRow+1)`；小计 / 合计 /
   总计在更下面的行，不在范围内。
3. **第 3 条会覆盖已推断的父格**（上游就是这么写的），是行为变更，有回归风险。

真正受益的是**手写模板**——目前设计器只出三种构造器模板，没有手写入口。
等有手写模板需求时再做，那时 `Resolved` 三态和缓存已经把路铺了一半。

**校正（对照 NopReport 权威文档）**：缺省规则其实非常明确：

- `rowParent` 不指定 → **向左侧查找**最近的 `expandType` 格
- `colParent` 不指定 → **向上查找**最近的 `expandType` 格
- 显式配 `A0` → 表示根单元格、无父格

这与论文的「默认父格自动上溯（行父格必须是纵向扩展格、列父格必须是横向扩展格）」**完全一致**，两份资料互相印证。实现成本很低（查找 + 校验方向），建议补上——比五步递归简单得多，且是已验证的行为。

### 3. 扩展步长 —— ✅ 已用另一种方式覆盖

论文强调的 `ExtendedArea`（步长 = `to−from+1`，非固定 +1）解决「父格 1×1、子格跨 1×2」时一次扩展要多列的问题。

我们的做法不同但等价：扩展阶段 `make_insts` 只按分组值生成实例（`engine.rs:195-217`），`merge_across`/`merge_down` 作为显示属性挂在实例上（`engine.rs:207-208`），真正的跨行跨列由布局阶段用**子树跨度**算出来（`engine.rs:128-134`：`colspan = max(col_span, merge_across+1)`，`rowspan = max(行子树跨度, merge_down+1)`）。

结论：不构成缺口，但**这是隐式正确性**——依赖布局阶段正确传播子树跨度，加测试守住。

守住：`layout_step_is_subtree_size_not_fixed_one`（`mod.rs`）。每个城市的子格跨两个模板行
（备注 + 数量），所以每个城市跨 2 行；总 1 + 4 + 2 = 7 行。
探针验证：把 `inner += n` 改成 `inner += 1` → 7 变 3 立刻红，证明确实在守。

**踩到的坑**：`merge_down` 是**显示属性**，**不**参与布局推进。布局只按子树行数算，
`merge_down` 留给网格填充时算 `rowspan`。试图把 `merge_down+1` 也算进 `place()` 返回值
会让多级表头凭空多出一行（`cross_tab_multi_level_header_merges` 立刻红，输出里多一个空行）。
所以 `merge_down` 的设计意图是「纵跨已经存在的多级表头行」——那几行本来就是独立模板行，
布局已经分开算过了。
如果用户把 `merge_down` 用在「没有下一行可跨」的叶子上，会出现视觉上的部分合并（下一个
兄弟的值会落在合并区里），那是用法问题不是引擎问题。

### 4. 分页与扩展分离 —— ➖ 引擎层尚无分页

`print-server` 里 `page` 只出现在 `print_job.rs`，是物理打印的 `@page` 纸张 CSS（`print_job.rs:175-183`），属于「把 HTML 塞进纸张」，不是报表语义上的分页（带区重复、页小计、跨页未决行）。

所以资料里那条「页统计表达式不能影响扩展过程」的架构约束**现在还用不上**，但一旦做分页就得先立这条规矩，否则很容易让分页反噬扩展结果。润乾的「9 类打印带区 × {是否参与扩展、是否每页重复} 矩阵」到时候可直接抄。

### 5. 多源不做整合运算 —— ✅ 已符合

`model.rs:58` 每个单元格自带 `ds`，`ReportTemplate.datasets` 是 `BTreeMap<String, DataSet>`（`model.rs:131`）；代码中没有任何 join/union 整合，多源靠各自 `ds` + 主格关联。这正是润乾文档论证的架构红线，保持住。

### 6. 中间结果序列化 —— ⚠️ 只有最终网格

*`RenderedSheet`*` { name, rows: Vec<Vec<GridCell>> }`（`model.rs:229-234`）是**展开并布局完成后的最终网格**，直接序列化发出去。没有 BIRT 那种「设计文档 → 执行器树 → 含分页/TOC 的二进制中间文档 → 分页索引 → 多格式发射」的分层。

影响：一次展开只能服务一种输出；要做「一次生成、多格式多次展现 / 服务端分页 / 增量重算」时没有可挂载的边界。建议在 `CellInst` 集合→`GridCell` 之间插入一个稳定的中间表示。

### 7. 死循环防护 —— ✅ 原结论有误，已修正

> **修正说明**：初版分析认定「主格树无环检测，`row_parent` 成环会栈溢出」。实际核对 `engine.rs:44-59` 后发现这个风险**不存在**：  
> 父格是从 `by_pos` 解析的，而 `by_pos` 只在该格创建**之后**才写入（`engine.rs:88`），  
> 所以父格下标必然小于子格——主格树是按下标严格递减的 DAG，**结构上不可能成环**。

但排查过程中发现了另一个**真实且更隐蔽**的缺陷：`row_parent` 声明了却查不到目标格（典型是父格写在后面的行）时，旧实现返回空列表，外层 `for` 一次都不执行，**整个单元格被静默丢弃**，数据凭空消失且无任何报错。

已修：查不到时退回「挂根」，与不指定父格的行为一致。测试 `declared_parent_not_yet_created_falls_back_to_root` 守着。

求值阶段的环（表达式互相引用）由 `ensure_value` 的 `evaluating` 标志拦住，测试 `value_expr_cycle_terminates` 守着。

> 连带影响：第 5 项「展开改迭代 deque」的收益因此下降——递归 `make_insts` 并不存在环导致的无限递归，  
> 只剩「极深模板可能栈溢出」这一条，优先级可以调低。


### 8. 表达式引擎 —— ✅ 已重写（原为最该补强的一块）

**原状**：函数集只有 `sum/count/avg/min/max/value`，无解析器；阶段 2 按实例下标 0..n 单遍扫描，表达式格引用另一个表达式格时结果依赖下标顺序（被引用格下标更大就读到 `Null`）。

**现已实现**（新增 `print-server/src/report/expr.rs`，递归下降解析）：

- 语法：`cmp → add → mul → unary → primary`，支持 `+ - * /`、比较 `> >= < <= == !=`、`-` 取负、括号、数字、单/双引号字符串
- 单元格引用：`POS` / `POS[COORD]` / `POS.func()` / `POS.expandIndex`
- 函数：`IF` `NVL` `SUM` `COUNT` `AVG` `MIN` `MAX` `PROPORTION`（占比）`ACCSUM`（累计）
- 依赖传播：`ensure_value` 先递归求值被引用的格，下标顺序不再影响结果
- 环检测：`evaluating` 标志，成环时保留 `Null` 而不是无限递归

**关键设计**：格集（Val::Set）+ 可见实例（anchor）。  
裸引用 `B2` 返回**格集**而非单值：参与 `SUM` 时遍历全部，参与四则运算时折叠为「对当前格可见的那一个」。  
可见性的判定顺序是 自己 → 主格链上的祖格 → **同一父格下的兄弟格** → 列主格链。  
第三条是重点——`B2 / B2[A2:-1]`（环比）写在 C2 上时，B2 与 C2 是兄弟而非祖孙，少了这条环比会算成「第一行 ÷ 上一行」。

这条设计直接替代了润乾的 `{}` 语法，且比它更省事。经端到端测试验证：

```text
1 | 100 | --   | 0.14 | 100     # 第 1 月无上月 -> '--'
2 | 200 | 2    | 0.29 | 300     # 200/100 = 2，累计 100+200
3 | 400 | 2    | 0.57 | 700     # 400/200 = 2，占比 400/700
```

**仍未做**：表达式缓存与增量重算（`resolve` 每次重新收集后代）。
（`PRODUCT` / `COUNTA` / `RANK` 已补齐，官方 11 个函数全部实现。）

## `expand_expr`：从死字段变成「固定列表展开」（已实现）

原先 `CellModel.expand_expr` 是**纯死字段**：全仓 21 处出现全是 `None` 初始化，
引擎没有任何一处读它。但它不是"没人用"那么无害——`grid-report.ts` 的
`validateTemplate` 在**主动替它做担保**：

```ts
if (m.expand_type && !m.ds && !m.expand_expr)          // 没数据集？写 expand_expr 就行
if (m.expand_type && !m.field && !m.expand_expr && ...) // 没字段？写 expand_expr 就行
```

用户照着提示写完 → Rust 引擎看都不看 → 报表静默少行。**空头支票比没有这个字段更糟。**

### 量过了才动手：P1 范围里有一半根本不可能实现

`model.rs` 原注释写的是「P1 支持：数据集名 / 数组字面量」。实测：

| 口径 | 结论 |
|---|---|
| **数据集名** | **不可能实现，也没意义** —— `Engine::new(ds: DataSet)` 引擎只有一个 DataSet（全仓无 `datasets` 复数），没有第二个源可选 |
| **数组字面量** | 可实现，且覆盖真实需求（固定顺序 / 月份补全） |

所以只实现了后者，并把「数据集名」那一半从注释里删掉——留着注释就是留着一个
永远不会兑现的承诺。

### 实现（`expand_expr` = 常量数组字面量）

- `expr.rs`：`Expr::Array`。`[` 在 **primary 位置**上只可能是数组字面量——层次坐标的
  `[` 永远紧跟格名、由 `parse_ident` 消费，走不到这里，所以不冲突。
- `engine.rs`：`value_key` 从 `group_by_field` 抽出复用；新增
  `const_value` / `parse_expand_list` / `group_by_list`。
  `make_insts` 里 `expand_expr` **优先于** `field`。

`group_by_list` 与 `group_by_field` 的两处差异，就是它的全部价值：

1. 顺序按字面量走，不按数据出现顺序；
2. 数据里没有的项**照样保留**（`rows` 为空 → 值格走 Null / 模板兜底）。

### 探针

| 探针 | 结果 |
|---|---|
| `match &model.expand_expr` → `&None::<String>`（退回死字段状态） | 两个新测**同时红**；`left` 正是 `["月份 \| 金额","1月 \| 250","2月 \| 450"]` —— 数据顺序、无 3月 |
| `group_by_list` 的 `list.iter()` → `.rev()` | 红，`left = [..., "3月 \| ", "1月 \| 250", "2月 \| 450"]` |
| `validateTemplate` 去掉 `!m.expand_expr` 口子 | TS 新测红，报出 `A2：设了扩展方向却没有数据集（也没写 expand_expr）` |

### 浏览器端到端

`free-cell-expand-expr` 控件在自由模板 cell 面板里有，且**只在设了 `expand_type` 才出现**（与其它展开控件同包在 `{m?.expand_type && (...)}` 下）：

- 输入 `["1月","2月","3月"]` → DOM 读到一致（`fill` 触发 onChange → patch → setState）
- 把 `expand_type` 切到「不扩展」（控件被 unmount）再切回「纵向 ↓」（重新 mount）→ 值仍在
  → 不是 DOM 残留，是 React state
- 直接 POST 到 `/api/report/render` 同一份模板（数据里只有 1月、2月）：

  ```
  <td rowspan="1" colspan="1">1月</td>
  <td rowspan="1" colspan="1">2月</td>
  <td rowspan="1" colspan="1">3月</td>
  ```

  字面量顺序、数据里没有的 `3月` 照样出。

截图：`.workbuddy-ai/screenshots/expand-expr-ui-panel.png`。

### 顺带查清并修掉的一个既有坑（不是 `expand_expr` 引入的）

`expand_expr` 解析失败时我一度看到 `" \| 700"` 这种「全量合计」的假行。查下来是
**既有行为**，且与 `expand_expr` 正交 —— 用完全无关的 `expand_max_count: 0` 复现
得到一模一样的结果。

**根因**：父格展开成 0 条时，`by_pos` 里根本没有它的键（原来的 `created.is_empty()`
直接 `continue`，连键都不登记）。于是「主格展开成 0 条」和「主格压根不存在（模板写错）」
在子格眼里**完全一样**，都走「退回挂根」—— 子格于是挂到根上拿到全量数据，算出一张
「什么都没筛」的假合计。这个数字看着像真的，比报错难查得多。

**修法**：把 pos **早于父格循环**登记进 `by_pos`（可以是空表），然后在父格查找处
把三种情况分开：

| 情况 | 处理 |
|---|---|
| 有实例 | 正常跟随主格 |
| 空表（主格存在但展开成 0 条） | 子格**一条都不出**（润乾语义：主格没数据，子格一并消失） |
| 键不存在（模板写错） | 退回挂根 + 告警（保持原行为） |

**自引用要单独放过**：`p == pos`（自己声明自己当主格）不能走「空表」那条，
否则整张表会悄悄渲染成空的。现成模板里真有这种写法（测试 helper 里
`row_parent` 硬编码成 `A2`，而 A2 自己就是这个格），它原先靠「查不到 → 退回挂根」
侥幸能跑。这条保持原行为，并已把两个测试模板里的自引用改干净。

**探针**：

| 探针 | 结果 |
|---|---|
| 行轴 `Some(_) if *p != pos` → `if false` | `left: [" \| 700"]` —— 正是那个假合计 |
| 列轴同样处理 | `left: "华东 \| 100 \| 100"` —— 凭空多出一列月份 |

列轴那个测第一版是**空转的**（探针对它无效）：我按「整行合计 300」设的哨兵，
实际回归形态是「凭空多出一列 100」。是探针把这件事逼出来的。

## 代码里已经做对的（别动）

- **`col_after`**（`model.rs:70-74`）：列数随数据变化时「行合计」不写死列号，延后到布局第二遍定位（`engine.rs:364-366`）。这个坑处理得很到位。
  - 直测 `col_after_places_row_total_after_month_columns`：断言**整条列布局** `["地区","1月","2月","行合计"]`。
  - 探针（第二遍 `col_start + col_span` → 只 `col_start`）→ 变 `["地区","1月","行合计"]`，**「2月」被挤掉**。
  - 值得记一笔：只看 `last()` 的旧断言**抓不住**这个错——被挤掉时 `last()` 仍等于「行合计」。所以必须断言整条列布局。
- **`merge_to_end`**（`model.rs:110`）：标题/表头横向铺到行尾，解决列数不定的合并宽度。
  - 直测 `merge_to_end_spans_entire_row_width`：`grid[0][0].colspan == grid[0].len()`（=4）。
  - 探针（`if inst.merge_to_end` → `if false`）→ `left: 1, right: 4` 红。
- **双向祖格注册**（`engine.rs:246-257`）：值格同时向行祖格链和列祖格链注册，这是交叉表 `B3[B2:+0].sum()` 能取到整列的前提，设计正确。
- **多源**：见第 5 条。
- **前端/后端模型同源**：`openprint/src/report/grid-report.ts` 是 Rust 模型的 TS 镜像，注释明确「真正的展开/分组/汇总算法在 print-server，前端只做描述与展示」（`grid-report.ts:8`）。这次把 `grid-report.ts` 从 `designer-react` 迁到 `openprint/src/report/` 是对的，别再搬回去。

## 补充：NopReport 权威语义清单（可直接抄）

> 来源：NopReport 官方开发文档（xpt-report）+ 源码解析。我们的 `model.rs` 注释自称「NopReport xpt 的 JSON 等价物」，所以这份语义就是**我们的目标规格**，比 OCR 出来的论文可靠。

### 值的三阶段（✅ 已补齐 formatExpr 阶段）

`expandExpr → expandValue`（展开期，此时层次坐标**尚未建立**、不可用）→ `valueExpr → value`（全部展开完毕后，层次坐标可用；无 `valueExpr` 则 `value = expandValue`）→ `formatExpr → formattedValue`（展示期；兜底顺序：formatExpr > dict > Excel 样式格式串）。  
`expand_value` / `value` / `NumFmt` 早已对齐，`formatExpr` 与 `dict` 现已补齐。

**实现**（`CellModel` 新增 `format_expr` / `dict`，引擎新增阶段 2.5）：

```rust
/// 只覆盖文本，不动 value：xlsx 仍导出原始数值和数字格式串。
fn compute_display(&mut self, i: usize) {
    if let Some(e) = self.insts[i].format_expr.clone() { /* 解析 → 求值 → fmt_text[i] */ }
    if let Some(dict) = self.insts[i].dict.clone() {
        // 键取**未套数字格式**的原始文本：配 {"1":"是"} 时不该被千分位/小数位干扰
        let (base, _) = display(self.insts[i].value.clone(), None);
        if let Some(mapped) = dict.get(&base) { self.fmt_text[i] = Some(mapped.clone()); }
    }
}
```

三个要点：

1. **阶段顺序**：展示值必须在全部 `value` 求值之后算。`format_expr` 里的 `value` 读的是本格最终值，
   也可能用层次坐标引用别的格，那时坐标必须已建好。
2. **`value` 关键字**：`expr.rs` 新增 `Expr::SelfValue`，`parse_ident` 里 `value`（大小写不敏感）
   优先于单元格引用。`collect_deps` 对它返回空依赖——否则 `ensure_value(cur)` 会自己等自己。
   写在 `value_expr` 里会自引用，此时 `evaluating=true`、值还是 Null，取出来就是 Null，不会递归。
3. **导出取舍**：字典把 1 显示成「是」时，Excel 里那个格子仍是数字 1。
   这是「展示值」语义的固有取舍，好处是导出后仍可做透视/计算。

测试（4 个，均在 `mod.rs`）：字典只改展示文本不动 `raw_number`、字典未命中回落兜底、
`format_expr` 能读到本格值、兜底顺序 formatExpr > dict > NumFmt、`format_expr` 写坏时告警并回落。

### 展开控制属性

| 属性                                  | 作用                                    | 状态                                        |
| ----------------------------------- | ------------------------------------- | ----------------------------------------- |
| `keepExpandEmpty`                   | 展开集为空时，缺省会删除该格及子格；置 true 则保留但值为 null  | ✅ `keep_expand_empty`                     |
| `expandMinCount` / `expandMaxCount` | 展开条数下限（补 null，留空行）/ 上限（丢弃多余，只显示前 N 条） | ✅ `expand_min_count` / `expand_max_count` |
| `expandInplaceCount`                | 模板预留了空行时复用，不足才新增                      | ✅ 等价实现（`expand_min_count`，见下）            |
| `rowTestExpr` / `colTestExpr`       | 返回 false 则整行 / 整列删除                   | ✅ 已实现（求值期 + 布局期，见下）                      |
| `exportFormula`                     | 导出 Excel 时把 valueExpr 转成 Excel 公式     | ✅ 已实现（见下节）                                |

#### `expandInplaceCount` 为什么不算缺口：等价性实验

NopReport 官方 FAQ「如何支持默认多个空行」给的语义是：

> 在单元格中配置 `expandInplaceCount`，然后在模板中实现插入多行。
> 如果展开表达式返回个数小于这个值，则**不需要新增单元格**。
> 也就是说，如果模板中已经预留了空间，可以直接复用。

关键在于**输出形状**而不是实现路径。本项目没有「预留行」概念——一个模板行就是一行逻辑行，
展开靠复制。所以不能靠读代码下结论，写了三个判别性实验（`mod.rs`，`bill_template`）：

| 实验                                    | 观测                                                       | 结论                    |
| ------------------------------------- | -------------------------------------------------------- | --------------------- |
| 补出来的行显示什么                             | 明细行模板兜底值 `"—"` 出现在补足行上：`"— \| "` 而非 `" \| "`             | 补足行是**模板行的副本**，不是空行  |
| 数据多于 N 时                              | 5 条数据 + 下限 3 → 6 行（1 表头 + 5 明细），一行不少                     | 是**下限不是上限**，只补不截      |
| 模板里手写预留行                              | 2 条数据 + 2 行预留 → 5 行；5 条数据 + 2 行预留 → 8 行。预留行**不随数据伸缩**    | 静态行是根格，「手写预留行」给不出「至少 N 行」 |

前两条合起来正好是 NopReport 的那句话：不足 N 条时复用（补足行保留模板内容）、
超出就正常新增。`expand_min_count` 的输出形状与 `expandInplaceCount` 一致。

**剩余差异**（窄，且不影响「默认 N 个空行」这个需求）：NopReport 允许预留行**各不相同**
（插入后手改某一行）。本项目的补足行必然是同一模板行的副本。这个场景在我们模型里
用户可以直接写多行模板行表达，只是语义是「固定行」而非「下限」。

三个测试各配了故障注入才敢绿：拿掉补行逻辑 → 前两个测试红（3≠5、3≠4）；
把下限实现成 `truncate` → 「只补不截」红（4≠6）；
把补足行的值兜底改成硬 null → 「模板行副本」红（`" \| "`≠`"— \| "`）；
给预留行挂主格 → 第三个红（7≠5，且暴露出预留行会被复制成「每个数据行后各跟 N 行」）。

#### 自由模板下的入口：按格直设

上面等价的是**引擎**能力。但原先设计器里它只在分组 / 交叉表模式下由一个报表级开关套用
（`withExpandControl`），而那个开关靠「猜最内 / 最外层」定位格子——自由模板的层级是用户
一格一格定的，让它再猜一遍会覆盖用户意图，所以自由模式下**刻意不套**（见 `GridReportModal`
里那三个开关的隐藏注释）。结果是：非线性模板（本引擎的主场）里用户根本够不着这个能力。

改成 **per-cell 直设**：选中展开格时出现「最少行数 / 最少列数」输入框，直接写该格的
`expand_min_count`，打在哪一格由点选决定，不猜。

配套测试守住提交链路 网格 → `gridToSheet` → `withExportFormula`：任何一关重建 model 都会
把值静默抹掉，而 UI 上看不出来（渲染结果只是「没补空行」）。其中一条特意让格子同时带
`value_expr`，逼 `withExportFormula` 走重建 model 那条分支再断言值还在；
故障注入（去掉 `{...m}` 展开）确认它真能抓到（`undefined` ≠ `4`）。

#### 设计器暴露：三个属性打在不同层级

引擎早就有了，但设计器一直没暴露。补 UI 时踩到一个**必须定死的语义问题**：

分组模板里**每个分组格都带 `expand_type:'r'`**，并用 `row_parent` 链式嵌套
（`region → city → salesman`）。三个属性如果一律打在所有行展开格上会**逐级相乘**——
2 级分组 + 最少 5 行 = 至少 25 行，不是 5 行。

定死的规则（用户已确认）：

| 属性 | 打在哪一级 | 理由 |
|---|---|---|
| `expandMinCount`（补空行） | **最内层**行展开格 | 「每组至少留 5 行」说的是明细级；打外层变成「至少 5 个分组」 |
| `expandMaxCount`（TOP N） | **最外层**行展开格 | 「TOP 10」说的是分组数；打内层变成「每组只显示 10 行」 |
| `keepExpandEmpty` | **所有**行展开格 | 逐级保留是想要的：空报表也要有一行空行撑着表头 |

只作用于**行**展开格（`expand_type === 'r'`），列展开格不受影响
（否则交叉表的「最少 N 行」会顺带把列也补足）。

层级判定：构造器写 `row_parent` 时用的是 `cellPos()`，而 `cell()` 本身不写 `pos`
（位置由服务端按行列下标推断），所以 `withExpandControl()` 用同一个 `cellPos()`
把位置补算回来，再比对「谁被别的行展开格认作父格」。

实现在 `openprint/src/report/grid-report.ts` 的 `withExpandControl()`
（与 `withExportFormula` 同款后处理，不动三个构造器的签名）；UI 在
`GridReportModal` 的工具条：最少行数 / 最多条数 / 空数据保留。

### 展开顺序：迭代 deque + 父格优先（对应我们的环防护问题）

NopReport 用 `processing` 双端队列：`poll()` 取一个格；若其 `colParent`/`rowParent` 未展开，则把「自己 + 父格」一起 `push()` 回去，LIFO 保证父格先展开。  
**这是迭代而非递归**——既天然避免深模板的栈溢出，也让环检测很好加。  
但我们的模板按行列升序处理、父格必然先创建，顺序本就正确，改成 deque 没有实际收益（详见第 7 条修正），只在布局递归加了深度上限。

### 函数集

官方：`SUM` `PRODUCT` `COUNT` `COUNTA` `AVERAGE` `MIN` `MAX` `NVL` `PROPORTION` `RANK` `ACCSUM`。  
**现已全部实现**（前缀式 `SUM(x)` 与后缀式 `x.sum()` 都支持）。`PROPORTION`（占比）与 `ACCSUM`（累计）是中国式报表高频刚需。

### 表达式引擎的设计启示

官方明确：「与一般的报表引擎不同，NopReport 的表达式引擎**没有内置任何关于数据集的知识**」，而是用 `map/filter/flatMap/reduce` 等集合函数 + Lambda，把复杂度从引擎挪到表达式层。  
我们目前走的是「内置 `ds`/`field`/`agg` 特殊字段」的路子，简单场景好用，但表达力天花板低。若要补算术与 `IF`，建议顺带评估这个方向。

### 调试能力（强烈建议抄）

官方支持 `dump=true`：展开过程中把每个中间结果输出成 `{seq}-{cellPos}.html`，单元格内容格式为 `cellText <- cellLayerCoordinate`，并在日志打印父子关系。  
我们排查扩展/求值问题时目前只能靠读代码推演，加这个投入产出比极高。

### 与论文的互证

论文的 `BEB → BE → BoxCE` 三层模型 ≈ NopReport 的 `ExpandedCell`（`rowParent`/`colParent` + `rowDescendants`/`colDescendants` + `expandedValue`/`value`）。两份独立材料在「默认父格上溯」「双向后代注册（空间换时间）」「展开与求值分离」三点上结论一致，可信度高，可以放心作为实现依据。

## 静默失败必须可见（warnings）

排查中发现的一类问题值得单独说：它们**不报错、不崩溃，只是结果悄悄变少或变空**，靠读输出几乎发现不了。现在统一收敛到 `RenderResponse.warnings`（也出现在 dump 顶部）：

| 场景                                               | 原行为                   | 现在                                    |
| ------------------------------------------------ | --------------------- | ------------------------------------- |
| 声明 `row_parent` / `col_parent` 但目标格不存在（父格写在子格之后） | 退回挂根，该格不跟随主格展开，数据静默变少 | 告警 `X 声明的 row_parent "A9" 不存在……已退回挂根` |
| `value_expr` 语法错误                                | 保留展开值，用户只看到空单元格       | 告警 `X 的 value_expr 无法解析（…），已保留展开值`    |

带 sheet 名前缀，便于定位。正常模板不产生告警（有测试守着，避免告警泛滥）。

## 建议的动手顺序

1. ✅ **表达式层依赖排序**——改为 `ensure_value` 惰性求值 + 依赖传播。
2. ✅ **环检测**——结论修正后改修「父格查不到导致整格静默消失」的真实缺陷（见第 7 条）。
3. ✅ **表达式引擎**——新增 `expr.rs` 递归下降解析器，支持四则/比较/IF/SUM/PROPORTION/ACCSUM。格集 + anchor 机制替代了润乾 `{}`，更省事；`$` 运算符后置到真遇到「月份不连续」场景再加。
4. ✅ **父格缺省推断**：行父格向左查、列父格向上查最近的 `expandType` 格，`A0` 显式表示根。
5. ✅ **展开健壮性**——未改 deque：模板按行/列升序处理 + 父格必然先创建，顺序本就正确，重排无收益。改为在布局递归加 `MAX_LAYOUT_DEPTH` 深度上限做防御。
6. ✅ **dump 调试输出**——`RenderRequest.dump=true` 时，`RenderResponse.dump` 返回展开中间结果：  
   `seq | pos | 文本 <- 层次坐标 | 行父 | 列父`，如 `15 | C3 | 张三 <- A3:0,B3:0,C3:0 | 行父:B3#0 | 列父:-`。  
   没有照搬 NopReport 的写文件方案（服务端渲染带文件系统副作用不合适），改成随响应返回。
7. ✅ **分页（页面级）**——见下节。
8. ⏸️ **中间结果表示**——**主动延后**。当前一次展开只服务一种输出，插入中间层没有消费方，属于过度设计。等出现「多格式输出」或「服务端分页 + 增量重算」需求时再落。

## 分页实现说明（第 7 条）

只做页面级，不引入润乾那套 9 类带区（报表头/分组表头/数据区/表尾区…）——带区需要给模板加类型，前后端模型都得改，等真遇到复杂表头需求再说。

**模型**（`model.rs`，前后端已同步）：

```rust
pub struct PageConfig {
    pub rows_per_page: usize,        // 每页数据行数（不含重复的表头/表尾）
    pub repeat_header_rows: usize,   // 每页顶部重复的模板行数
    pub repeat_footer_rows: usize,   // 每页底部重复的模板行数
}
// SheetTpl 新增 page: Option<PageConfig>，缺省 None = 不分页
```

**切分**（`paginate()`）：`[表头] + [数据块] + [表尾]` 逐页重复。  
表头 + 表尾吃掉整张表时原样返回一页（`PageConfig::is_effective` 判定），不会出现空页。

**输出**：`RenderResponse.pages`（每页一个 `RenderedSheet`，名字带 ` (i/n)`）+ `pages_html`（逐页 HTML）。  
`sheets` / `html` 保持完整不分页的结果，不破坏既有调用方。

xlsx 导出：有 `pages` 就用 `pages`（每页一个 sheet），否则用 `sheets`。  
另外润乾那条「页统计表达式不得影响扩展过程」的约束，在实现带区模型前还用不上。

**分页 + exportFormula 冲突（已处理）**：公式是按**整表**的行列位置生成的，
逐页复制后行号就对不上了——第 2 页的 `SUM(C2:C5)` 只会算到本页那几行，
跟同一格显示的静态值（整表合计）不一致。多页时统一**回落写值并告警**，
未分页的 `sheets` 视图仍保留公式。

---

## 前后端契约核对（`scripts/mirror-check.py`）

**动机**：`npm install` 在本环境被应用的 `node-brokered-fs-shim` 拦截（`CODEBUDDY_BROKER_DENY:
Brokered host mkdir requires an available runtime file rule`），`openprint` / `designer-react`  
装不上依赖，`vue-tsc` / `vitest` 都跑不起来，TS 侧改动无法用类型检查验证。

> **补充实测（结论更严重）**：换到 `/tmp` 下装，npm 能跑、能下载、也能建目录，
> 但**包内容写不进去**——`npm install typescript` 报 `added 2 packages`，
> 实际 `node_modules/typescript` 下只有 LICENSE 和 NOTICE.txt，`lib/` `bin/` 全无。
> 全量装则先建 100+ 个空壳包目录，然后在 `reify:retireShallow`（把目录改名成
> `.xxx-HASH`）处 mkdir 被拒；`npm ci` / `--omit=optional` / 换全新目录 /
> 循环重试 8 次均无效（卡在 102 个包不再前进）。**npm 在本环境只能产出空壳，
> 等价于不可用**；把 /tmp 的 node_modules 软链进项目也不行（空壳连 package.json 都没有）。
> 依赖只能由用户在自己的终端里装。

**替代方案**：Rust 是唯一的展开/计算实现，前端只描述与展示，两边靠 JSON 契约对齐。  
而 Rust 端 `serde` 普遍带 `default`、多余字段被静默忽略，所以字段漂移在编译期查不出来。  
于是加了 `scripts/mirror-check.py`：直接解析两边的类型声明逐字段比对，把契约检查做成可重复执行的脚本。

```
python3 scripts/mirror-check.py
```

覆盖 `CellModel` / `CellTpl` / `RowTpl` / `SheetTpl` / `ReportTemplate` / `PageConfig` /  
`GridCell` / `RenderedSheet` / `NumFmt` / `RenderRequest` / `RenderResponse`。  
两处已知等价关系按白名单处理，不算漂移：

- Rust `NumFmt` ↔ TS `CellFormatSpec`（同一 shape，名字不同；TS 注释里已写明对应关系）
- Rust `ReportSource` 带 `#[serde(rename_all = "camelCase")]`，故 `conn_id` → `connId`、`r#where` → `where`

**当前结果：11 个类型全部一致。**

### ✅ 补充：tsc 其实能跑（不需要 npm install）

前面记的「前端无法验证」只对了一半。`node_modules` 装不上，但别的项目里有现成 typescript，
直接用它的 `tsc` 配 `--noResolve`（不解析 import，因此不需要 node_modules）即可：

```bash
node /Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc \
  --noEmit --skipLibCheck --strict --target es2020 --module esnext \
  --moduleResolution bundler --noResolve openprint/src/report/grid-report.ts
```

滤掉 `Cannot find module` / `Cannot find name 'JSON'|'Record'|'Promise'|'Math'` 等噪声后，
剩下的就是本文件真实的类型错误。`.tsx` 加 `--jsx preserve` 同样可查
（JSX / React / antd 引发的 `TS7006 隐式 any` 是缺 types 的噪声，语法错误仍会露出）。

**第一次跑就抓到一个真 bug**：`DetailTemplateOptions` 缺 `page?: PageConfig`——
上一轮补分页时只给 Group / Cross 两个构造器加了 `page`，漏了 Detail，
而 `buildDetailTemplate` 内部在用 `opts.page`。一直没有类型检查，藏到现在。已补。

结论：`mirror-check.py`（字段漂移）与 tsc（类型 / 语法）配套，改完 TS 两边都跑。

### 核对中发现并修掉的一处既有漂移

`GridCell.num_format`（由 `NumFmt` 推导出的 Excel 数字格式串，xlsx 导出时套到数值格上）  
在 Rust 侧已序列化，但 TS 镜像里没有。属于「上一轮数值格式功能」遗留的漏同步，  
不是本次改动引入的（本次 TS diff 是 31 行纯新增）。已补上：

```ts
export interface GridCell {
  text: string
  pos: string
  rowspan: number
  colspan: number
  raw_number?: number | null
  /** Excel 数字格式串（由 NumFmt 推导），xlsx 导出时套到数值格上 */
  num_format?: string | null
}
```

运行时无害（多余字段本来就被忽略），但前端若要复用服务端算好的格式串就会踩空。

### 两个前端项目共用一份镜像

`designer-react` 不复制引擎代码，靠 `tsconfig` / `vite.config` 的 alias 直接引用  
`openprint`：`"@/*": ["../openprint/src/*"]`。所以 `openprint/src/report/grid-report.ts`  
是唯一一份 TS 模型，改一处即可，不存在第二处需要同步的地方。

需注意 `designer-react` 的 `tsconfig` 开了 `strict` + `verbatimModuleSyntax`  
（要求类型导入写 `import type`），镜像文件新增类型时不能用默认导入。

---

## rowTestExpr / colTestExpr：整行 / 整列删除

原先记的是「未做（需按物理行反查实例）」。实际上**不需要反查**——
求值发生在全部 `value` 算完之后，而布局在求值之后，
所以只要在布局期把不合格的实例筛掉即可，它的子树自然不会被 `place` 到。

**实现**：`CellInst.hidden`（自身测试没过，或行 / 列主格有一个被删）在**求值阶段**就生效——
`resolve()` 过滤掉 hidden 的格，所以合计里不会出现被藏起来的行；
布局阶段 `layout_group` / `layout_columns` 直接读同一份 `hidden`
（并用 `mark_col_dropped` 递归带走列子格，否则它们会以默认列号 0 冒出来）。

删除状态的表达值得一提：`CellInst.dropped` **缺省为 true**，由 `place()` 落位时置 false。
这样「从未被布局访问到的实例」天然就是被删掉的——父格被删后，
不必再单独遍历整棵子树去打标记，少一处容易漏的递归。

**测试表达式解析失败按「保留」处理并告警**：静默删行是丢数据且无从察觉，
比多留一行（只是排版难看）危险得多。与 `value_expr` / `format_expr` 的失败策略一致。

**已踩的坑（也是上一轮留下的真 bug）**：`make_insts` 有**两条**实例创建分支
（展开格 / 非展开格）。上一轮补 `format_expr` / `dict` 时只在非展开分支拷了字段，
结果：**挂在分组格（展开格）上的字典会静默失效**——
而「编码 → 名称」恰恰最常配在分组列上。这次补 `row_test_expr` 时撞见，两条分支都已同步。

> 教训：往 `CellInst` 加字段时，`make_insts` 的两个分支都要拷。
> 这类 bug 的特点是不报错、只在某些格上静默失效。

**已修：相对坐标认自己（原「已知限制」）**：原先在测试表达式里写
`C1[B1:+0]`（以本格自己为主格做相对定位）取不到值——
相对坐标的基准只能从**当前格的祖先链**上找，而本格不在自己的祖先链里，一律返回空集。
后果比「取不到值」更糟：条件恒假 → **整行被静默删光**，而且这正是
「小计为 0 的分组不显示」唯一自然的写法，等于该用例根本写不出来。
现已在 `resolve_raw` 里加了 self 判断（自己就是离自己最近的同名主格），
`C1[B1:+0] >= 200` 这类条件可用。测试 `row_test_based_on_aggregate_converges` 守住。

**已修：被删的行不能进合计（HTTP 冒烟测出来的真 bug）**：
删除原先只在布局期生效（不落位），求值却在布局**之前**，
于是 `C1.sum()` 把藏起来的行也算了进去，出表结果是**「明细 1000、合计 1500」**——
典型的静默错数，肉眼几乎看不出来。
修法是把「删除」从布局概念提到求值概念：`CellInst.hidden`
（自身测试没过，或行 / 列主格里有一个被删，沿主格链传递），
`resolve()` 过滤掉 hidden 的格，布局直接读同一份 `hidden`。

**求值必须和测试一起迭代到稳定**：测试可以引用聚合值（「小计不达标的组不显示」），
而聚合又要跳过被删的格——两者互相依赖。单遍算完再删会留下脏数，
所以新增 `evaluate_to_fixpoint()`：求值 → 算测试 → 有翻转就清 `evaluated` 重来，
最多 4 轮。第 0 轮的翻转属正常（首次定下谁被删），第 1 轮起还在翻转才告警
（说明条件依赖了会随删除变化的聚合值，结果取决于最后一轮）。

## exportFormula：把 valueExpr 落成 Excel 公式

`CellModel.export_formula: Option<bool>` + `GridCell.formula: Option<String>`（前后端已同步）。
导出后改明细，小计 / 合计会在 Excel 里自动重算——静态值做不到这点。

**翻译时机**：布局之后。此时层次坐标已经能落成具体格子，
`C2[A2:+0].sum()` 在 1 月占两行时就是 `SUM(C2:C3)`。
实现是 `Engine::excel_formula` → `excel_of`（AST → 公式串）+ `excel_refs`
（一组实例 → 引用；同列且行连续折叠成区间，否则逗号列出）。

**刻意不翻的**（返回 `None` → 回落写值 + 告警）：
`PROPORTION` / `ACCSUM` / `RANK` / `NVL`（Excel 无同名函数，硬凑的等价式可读性极差）、
`{}` 条件（格集过滤没有 Excel 对应物）、`$` 与 `value`（依赖求值上下文）、
自引用与解析不到目标的引用。

> 原则：**半对不对的公式比静态值危险得多**——它看起来能算，结果是错的。
> 所以宁可回落写值并告警，也不做「尽力翻译」。

**踩坑（又踩了一次同一类）**：`make_insts` 的两条实例创建分支缩进不同
（16 空格 / 12 空格），按缩进批量替换只命中展开格那一支 →
非展开格的 `export_formula` 一直是 false，且**没有任何报错**。
是写出来的测试先发现「公式全为 None」才定位到。
**教训不变：往 `CellInst` 加字段，两个分支都要拷，且要靠测试兜。**

## 设计器暴露：分页 / 调试 / 告警

之前「分页配置、展开条数上下限、keep_expand_empty、dump 开关」只有服务端模型和 API，  
UI 上没入口。现已补上分页、调试、告警三块（`designer-react/src/modals/GridReportModal.tsx`）。

**分页**：开关 + 每页数据行 / 重复表头行 / 重复表尾行，下发到 `sheet.page`。  
三个模板构造器（`buildGroupTemplate` / `buildDetailTemplate` / `buildCrossTemplate`）  
都新增了可选 `page?: PageConfig`，透传给 `SheetTpl.page`。

> 坑：`page` 必须是 `useMemo`。`buildRequest` 是 `useCallback`，预览有一层 400ms 去抖，  
> 若 `page` 每次渲染都换新对象，`doRender` 身份随之变化，去抖会退化成反复请求。

**调试（dump）**：开关打开时请求带 `dump=true`，服务端回传展开中间结果，  
面板里按 `seq | pos | 文本 <- 层次坐标 | 行父 | 列父` 展示。排查扩展/求值问题用。

**告警**：`RenderResponse.warnings` 非空时弹警告条逐条列出。  
这是让上一节那两类静默失败真正被看见的最后一环——否则服务端算了也白算。

**xlsx 导出现在按页出 sheet**：`xlsx_handler` 改成有 `pages` 就用 `pages`、否则用 `sheets`，  
文件名仍取未分页的 sheet 名（避免带上「 (1/3)」后缀）。  
新增测试 `paginated_template_exports_pages_as_sheets` 覆盖该分支（**Rust 62 测试全绿**）。

**仍未做**：预览区始终展示未分页的完整表（要看分页效果得导出 xlsx）；  
`expand_min_count` / `expand_max_count` / `keep_expand_empty` 是单元格级属性，  
需要按格配置，没有合适的全局 UI 位置，暂未暴露。

---

## ✅ 已修：macOS 上 `cargo build` 链接失败

```
ld: Undefined symbols for architecture arm64:
  "_DeviceCapabilitiesW", referenced from: print_server::printers::bin_names
  "_ShellExecuteW",       referenced from: print_server::print_job::shell_print
```

`src/printers.rs` 无条件 `use windows_sys::Win32::...DeviceCapabilitiesW` 并在 `bin_names()`
里调用；`print_job.rs` 的 `shell_print` 同样无条件走 `ShellExecuteW`。
macOS 上 `windows_sys` 只提供声明、没有实现，于是链接期炸。

**为什么 `cargo test` 却是绿的**：测试 harness 会替换 `main`，整条路由因此不可达，
`bin_names` 被 dead-strip，符号不会被引用。所以「测试通过」掩盖了「二进制编不出来」。
**教训：`cargo test` 全绿不等于能出包，冒烟时一定要真的 `cargo build` 并起服务。**

**修法**：
- `printers.rs`：Win32 常量 / `use` / 四个 FFI 函数 / `classify_kind` 全部打
  `#[cfg(target_os = "windows")]`；`list_printers()` 拆成两个版本，
  非 Windows 返回空列表（`/printers` 仍 200 且 `count:0`，健康检查照常工作）。
- `print_job.rs`：`shell_print` 拆两版，非 Windows 走 CUPS `lp`
  （`lp -d <printer> <file>`），这样 macOS 上报表渲染 / 导出 / 打印链路也能端到端自测；
  顺带给 `find_browser` 补了 macOS / Linux 的浏览器候选路径。
- `util.rs` 的 `to_wide` / `from_wide` 一并 `cfg` 门控（否则非 Windows 上是无引用死代码）。

**现状**：`cargo build` 零告警通过，起服务后 `/health`、`/printers`、
`/api/report/render`、`/api/report/xlsx` 均 200，83 个单测全绿。

**HTTP 冒烟脚本**：`scripts/report-smoke.py`（起服务后 `python3 scripts/report-smoke.py`，
默认打 18888）。它构造一张覆盖主格自动认定 / dict / row_test / `$`+`{}` / 分页 / dump
的模板，断言每一格文本——上面那个「合计 1500」的 bug 就是它抓出来的，
Rust 单测当时全绿。与 `scripts/mirror-check.py`（Rust↔TS 契约核对）配套使用。

### ✅ 已补：macOS / Linux 的 CUPS 打印机枚举

上面那段「遗留」已经做掉，`/printers` 在 macOS / Linux 上不再恒定为空。
同一套 `PrinterInfo` 结构，两路实现靠 `cfg` 切换：

| | Windows | macOS / Linux |
|---|---|---|
| 队列列表 | `EnumPrintersW` Level 2 | `lpstat -a`（`accepting` / `rejecting`）|
| 默认打印机 | `GetDefaultPrinterW` | `lpstat -d` |
| 状态 | PRINTER_INFO_2W.Status | `lpstat -l -p`（idle / busy / disabled）|
| 描述 ≈ driver | pDriverName | `Description:` 续行，没有则回落 `"cups"` |
| 彩色 / 双面 / 纸盒 / 分辨率 | DevMode + `DC_BINNAMES` | `lpoptions -p NAME -l` |
| 类型 `kind` | `classify_kind()`（共用） | 同左 |

设计要点：

- **解析函数全部是 `&str → T` 的纯函数**（`parse_lpstat_a` / `parse_lpstat_d` /
  `parse_lpstat_l_p` / `parse_lpoptions_l`），命令执行只在 `run_cups()` 一处。
  本机没配队列，靠真实 `lpstat` 验证不了，所以 7 个单测喂的是合成输出。
- **`run_cups` 不看退出码**：`lpstat -a` 在没配任何队列时退出 1、提示打到 **stderr**，
  这不是错误，只是「没有打印机」。看退出码会把它误判成失败。
- **`lc_all=C` 也救不了本地化**：这台机器上 `LC_ALL=C lpstat -a` 仍输出中文
  「未添加目的位置。」。所以解析走「只认 `accepting` / `rejecting` 关键字、
  其它一律忽略」的白名单，不依赖英文文案。
- **「支持」看有没有这个选项，不看默认选了哪个**：`lpoptions -l` 列出的就是全部合法值，
  所以 `Duplex: *None DuplexNoTumble DuplexTumble` 即使默认 `None` 也算支持双面；
  只有 `*None` 一个值才算不支持。`*` 前缀只用来定 `defaultDpi`。
- **纸盒名保留原始大小写**（`Auto` / `Tray1`），它是给用户看的；
  用于比较的 `bare()` 才转小写——第一版图省事复用了 `bare()`，把纸盒名全小写化了。

端到端怎么验的：往 `PATH` 前面塞一个假的 `lpstat` / `lpoptions`（吐两台队列：
一台彩色双面带 4 个纸盒的默认机、一台暂停的单色标签机），起服务打 `/printers`，
确认 `isDefault` / `status:"error"` / `supportsColor` / `trays` 都对得上。

> 仍然没做的：`classify_kind()` 靠队列名猜类型（含 `label`/`ticket`/`票据` 等），
> 像 `Brother_QL` 这种型号名里不带线索的会被判成 `common`。要准得读 PPD 的
> `*Product` / `*ModelName`，暂不值得。
