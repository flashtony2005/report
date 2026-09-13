# 《基于单元格扩展的报表引擎的研究与实现》结构化笔记

> 来源：`基于单元格扩展的报表引擎-去重.txt`（硕士论文，7 章 / 约 85 页有效内容，Java 实现）
> OCR 有错字，以下已按上下文校正（如 `StyeList`→`StyleList`、`BEB/BE/BoxCE` 断字、`pageRowlndexList`→`pageRowIndexList` 等）。

---

## 1. 问题定义、自述贡献与对比结论

### 1.1 问题定义
- 企业自研报表：针对性强但**编程复杂、重复工作多、通用性差、难复用**。
- 国外工具（BIRT / JasperReport / Pentaho / 润乾）：价格贵、入门难、**设计方式不符合中国式报表习惯**。
- 中国式报表四特征（论文定义，注意它只真正解决了前两项的一部分）：
  1. **多数据源**（同一张报表来自多个异构库）
  2. **跨行组运算**（占比、环比、同期比）
  3. **分片**（同一批数据按不同主题汇总）
  4. **填报合一**（展示 + 录入）

### 1.2 与既有方案的对比结论

| 工具 | 论文评价 |
|---|---|
| BIRT | 基于 Eclipse 的开源报表系统，Java/JavaEE，设计器 + 运行时两件套；降低成本、界面友好 |
| JasperReport (+iReport) | 基于 Java 的开源工具，图形化设计、支持 PDF/HTML 多格式；**但属条带式** |
| Pentaho | 以工作流为核心的 BI 套件，面向大中型企业（非报表专用） |
| 润乾报表 | 纯 Java 企业级，支持 JavaEE 嵌入式部署；论文承认其"高效设计 + 强大展现"，未做实质对比 |

**核心批判**：条带式设计（标题 / 页眉 / 列表头 / 明细 / 列表尾 / 页脚 / 总结 七分区）**格式僵化、缺乏变通**，无法满足复杂中国式报表。

### 1.3 自述创新点（1.3 节原文归纳）
1. 摒弃条带式，借鉴 Excel 采用**基于单元格的设计方式**：
   - 单元格命名方式（A2、C4）
   - 基本属性设置方式（字体、大小、颜色、边框、背景色）
   - 单元格内容表达方式（公式 `=SUM(A3+B5)`）
2. 提出**基于单元格的扩展方法**：以**单元格之间的继承关系**为核心，实现扩展、填充、过滤、合并，得到**最终结果矩阵**。
3. 提出针对最终结果矩阵的**分页方法**（普通分页 + 有重复元素分页）。
4. 工程特性：Java 跨平台、XML 描述模板、天然支持多源、可导出 HTML 便于 J2EE 集成、提供 Excel 导出。

**系统架构**：报表设计器 → **XML 模板描述文件** → 报表引擎（读取/解析 → 查库 → 扩展生成中间结果）→ HTML / XML / Excel。**论文明确不涉及设计器实现**。

---

## 2. 模板描述文件（XML）Schema

一个工作簿 = 一个 XML 文件，解析后在服务器生成一个 `TemplateWorkBook` 对象。

```xml
<WorkBook>
  <DataSet>                                  <!-- 数据源集合 -->
    <TableData name="tableDataName">
      <Parameters>                           <!-- 数据集参数 -->
        <Parameter><Name/><Value/></Parameter>
      </Parameters>
      <Connection>                           <!-- 数据库连接 -->
        <Url/><Driver/><User/><Password/>
      </Connection>
      <Query/>                               <!-- 查询语句 -->
    </TableData>
  </DataSet>

  <WorkSheetList>                            <!-- 工作表列表 -->
    <WorkSheet name="workSheetName">
      <DataGrid>                             <!-- 数据表格 -->
        <CellElement col="colIndex" row="rowIndex"
                     cs="colSpan" rs="rowSpan" s="styleIndex">
          <Value t="valueType"/>             <!-- 单元格值 -->
          <Expand/>                          <!-- 单元格扩展属性 -->
        </CellElement>
      </DataGrid>
      <WorkSheetAttr>                        <!-- 工作表属性 -->
        <Header/><Footer/><Background/>
        <PaperSetting><PaperSize/><Margin/></PaperSetting>
      </WorkSheetAttr>
    </WorkSheet>
  </WorkSheetList>

  <Parameters>                               <!-- 参数列表 -->
    <Parameter><Name/><Dictionary/><DefaultValue/></Parameter>
  </Parameters>

  <StyleList>                                <!-- 样式列表（全局复用） -->
    <Style><Font/><Background/><Border/></Style>
  </StyleList>
</WorkBook>
```

要点：
- 数据源用 **Set** 存储（天然多源）。
- 样式**集中管理**，单元格只存样式引用索引 `s`（明确说"事实证明这是有效的"）。
- 单元格值来源三类：**静态数据 / 公式数据 / 数据表数据**。
- 单元格构成：行列位置、合并行列值（cs/rs）、数据值、扩展属性、样式索引。
- **缺口**：第 6 章用到的"条件属性"（隔行换色、薪水 ≥6000 高亮）在 schema 里**没有对应元素**，说明 schema 与实现能力不一致。

---

## 3. 核心对象模型（重中之重）

### 3.1 顶层接口体系（图 3-3）

```
IWorkBook  ──1:N──>  IWorkSheet  ──1:N──>  ICellElement
   │                     │                      │
   ├─ TemplateWorkBook   ├─ TemplateWorkSheet   ├─ TemplateCellElement
   └─ ResultWorkBook     └─ ResultWorkSheet     └─ ResultCellElement
```

| 类 | 关键字段 / 说明 |
|---|---|
| `TemplateWorkBook` | `+dataSet`、`+workSheetList`、`+parameterList`、`+styleList` —— 对应 XML 四大块 |
| `ResultWorkBook` | 扩展填充后的结果工作簿，其单元格实际类型为 `ExtendCellElement`（图 3-11，与 `ResultCellElement` 命名不一致，属论文收尾粗糙处） |
| `SessionInf` | `+sessionID`、`+browser`、`+title`、`+workbookPath`、`+lastTime`、`+srcWorkBook`、`+resWorkBook`、`+pageSet` —— 会话级状态，只返回请求页码的数据 |

### 3.2 扩展核心四层结构（第四章）

```
BEB (Box Element Box)                 # 一个抽象单元格 ↔ 一个 BEB
 └─ beList : List<BE>                 # 因父格扩展而派生出的多个 BE
      BE (Box Element)                # 单元格的"一次展开实例"
       ├─ rowPE      : BE             # 行父格引用（只能存 1 个）
       ├─ columnPE   : BE             # 列父格引用（只能存 1 个）
       ├─ extendedBoxCEList : List<BoxCE>   # 本实例扩展出的具体值
       └─ childBEs   : BE[]           # 子格实例
            BoxCE（抽象值容器）
             ├─ NormalBoxCE           # 非扩展值（静态）
             └─ ExtendBoxCE           # 扩展值（查库/公式得到的每个具体值）
```

**为什么必须有 BEB**：`BE` 只能保存**一个**行父格或列父格引用；而当父格扩展出 N 个值时，子格也需扩展为 N 个且**每个子格实例要分别指向不同的父格值**，BE 无法表达。因此上层加 `BEB` 用 `beList` 管理这批 BE。

### 3.3 继承关系矩阵

```
genealogy : FamilyMember[rowCount][columnCount]
FamilyMember {
  selfCellElement : CellElement       # 单元格引用
  rowParent       : FamilyMember      # 行父格
  columnParent    : FamilyMember      # 列父格
  childMembers    : List<FamilyMember># 所有子格（父→子反查）
}
```
存在的理由：继承关系原本只存在单元格属性字段里，**只能子查父、不能父查子**，矩阵化后扩展每一步都依赖它。

### 3.4 最终结果 / 分页对象

| 对象 | 字段 |
|---|---|
| `BoxCase` | `rowMappingArray:int[]`（最终第 5 行 ↔ 抽象第 3 行）、`columnMappingArray:int[]`、`boxCEMatrix:BoxCE[][]`（初始为抽象行列数，随定位逐步扩展） |
| `ExtendedArea` | `column`、`row`、`fromColumn`、`toColumn`、`fromRow`、`toRow`、`extendedBEList` —— 描述以某 BE 为父格的**继承区域** |
| `IdxHeaderFooter` | `idx`（区域起始行/列）、`headerRepeatList:int[]`、`footerRepeatList:int[]` |
| `ClippedECI`（分页对象） | `source_element_case`、`row_line_array`、`column_line_array`、`rowHeightList`、`columnWidthList`、`row_height_index_list`、`column_width_index_list`、`paperSetting`、`totalPageNumber` |
| `DirectExtendedBEContainer` / `IndirectExtendedBEContainer` | 分别承载"直接更新"与"间接更新"的扩展结果链表 |
| `Tag` / `TextHtml` | HTML 输出：`tagName,id,classes,styles,attributes,subHtmlList,siblingHtmlList` / `text` |

### 3.5 三层缓存 / 会话优化（3.6）

| 机制 | 内容 |
|---|---|
| `WorkBookEntry` + `WorkBookEntryMap: <workbookPath, WorkBookEntry>` | 模板 XML 解析结果复用，避免重复读盘解析 |
| `ResultCache` + `ResultCacheMap: <ReportCacheID, ResultWorkBook>` | 结果工作簿复用，**带时效检查**（过期则重算） |
| `SessionInf` | 服务端只输出当前请求页码，保存分页集合 `pageSet` |

---

## 4. 单元格扩展算法（第四章，核心）

**定义**：单元格由一变多的现象。数据库单元格事先不知道查库得到多少值，若结果 >1 则按扩展方向（横/纵）扩展；**父格扩展后，依赖它的子格也要扩展**，且扩展出的每个单元格之间的继承关系需刷新。

### 总流程（5 步）
1. 计算单元格继承关系
2. 初始化表格矩阵
3. 填充表格矩阵
4. 扩展子格、更新继承关系
5. 计算最终结果矩阵

贯穿示例：年级成绩表（`score(class, studentName, subject, score)`）
`A1` 标题；`A3` 表头；`C3`=subject **横向扩展**；`D3` 表头；`A4`=class **纵向扩展**；`B4`=studentName **纵向扩展**；`C4`=score 无扩展（汇总）；`D4`=`SUM(C4)`；`A5` 静态"总分"；`C5`=`AVERAGE(C4)`；`D5`=`AVERAGE(D4)`。

### 4.1 计算继承关系（4.2）

**黄金规则**：
- **行父格**必须是**具有纵向扩展属性**的单元格 → 行父格对子格做**行数据过滤**。
- **列父格**必须是**具有横向扩展属性**的单元格 → 列父格对子格做**列数据过滤**。
- 默认父格不具备相应扩展属性时，**沿默认父格链上溯**，直到找到具备者；找不到则为 null。
  - 例：`D4` 默认行父格是 `C4`，`C4` 不纵向扩展 → 上溯到 `B4`（纵向扩展） ⇒ `D4` 行父格 = `B4`。
  - 例：`C5` 默认列父格 `C4` 不横向扩展 → 上溯 `C3` ⇒ 列父格 = `C3`。
  - 例：`D5` 两个方向都找不到 ⇒ 行父格与列父格均为 null。

**行父格计算（`calculateLeftParent`，列父格同理）**：

```
rowParentArray = new CellElement[rowCount]        // 每一行对应一个行父格
For (每个已定义单元格 cellElement)
  cellExpandAttr = cellElement 的扩展属性
  IF (cellElement 有默认行父格)
      得到 row 与 rowSpan
      遍历 rowParentArray 的 [row, row+rowSpan] 区间
      直到找到 rowParent != null 且 rowParent != cellElement
      IF 找到: cellElement.rowParent = rowParent
      ELSE   : cellElement.rowParent = null
  IF (cellElement 具有纵向扩展属性)
      将 rowParentArray 的 [row, row+rowSpan] 位置全部置为 cellElement
```

**构建 genealogy（`buildGenealogy`，递归 + HashSet 防环）**：

```
genealogy = new FamilyMember[rowCount][columnCount]
set = new HashSet()
For (每个 cellElement) buildGenealogy(cellElement, set)

buildGenealogy(cellElement, set):
  row, column = cellElement 的行列
  if genealogy[row][column] != null: return genealogy[row][column]
  if set.contains(cellElement): throw 死循环异常
  set.add(cellElement)
  rowParentMember    = cellElement.rowParent    != null ? buildGenealogy(rowParent,    set) : null
  columnParentMember = cellElement.columnParent != null ? buildGenealogy(columnParent, set) : null
  currentMember = new FamilyMember(cellElement, rowParentMember, columnParentMember)
  genealogy[row][column] = currentMember
  set.remove(cellElement)
  rowParentMember?.childMembers.add(currentMember)
  columnParentMember?.childMembers.add(currentMember)
  return currentMember
```

### 4.2 初始化表格矩阵（4.3）
遍历 `genealogy`，为每个单元格建 `BEB` + 首个 `BE`（`rowPE`/`columnPE` 指向父格 BE，`childBEs` 数组长度 = `childMembers.size()`），并把自己加入父格的 `childBEs`。初始每个 `BEB.beList` 只有 1 个 `BE`，其 `extendedBoxCEList` 为空。结果矩阵为 `be_beb_2D`。

### 4.3 填充表格矩阵（4.4）

顺序：**从左到右、从上到下**；**有父格则先算父格**。
两个防护结构：`isCalStateMatrix: boolean[][]`（已算过标记）、`isCalculatingSet: HashSet`（计算中，重复进入即判为循环引用并抛异常）。

```
calCellElementAndSetState(cellElement):
  if isCalStateMatrix[row][column] == true: return
  if isCalculatingSet.contains(cellElement): throw 死循环异常
  isCalculatingSet.add(cellElement)
  if familyMember.rowParent    != null: 递归计算行父格
  if familyMember.columnParent != null: 递归计算列父格
  beb = 该单元格的 BEB;  beList = beb.beList
  calBoxElements(beList)                // 对每个 be 求值并填入 extendedBoxCEList
  扩展子格、更新继承关系                  // 见 4.4
  isCalculatingSet.remove(cellElement); isCalStateMatrix[row][column] = true

calBoxElements(beList):
  for be in beList:
     非扩展数据单元格 -> 初始化 1 个 NormalBoxCE 存入 be.extendedBoxCEList
     可扩展数据单元格 -> 查库/计算公式，每个值初始化 1 个 ExtendBoxCE 全部存入
```
示例：`C3` 填充后 `extendedBoxCEList` 有 6 项（语文/数学/英语/物理/化学/生物）。

### 4.4 扩展子格、更新继承关系（4.5）—— 关键概念

设 `be1` 查库得到 n 个值，`be2` 是 `be1` 子格，`be3` 是 `be2` 子格：

- **直接更新（Direct）**：`be1` 有实际值 → `be2` 需**拷贝出 n−1 份**变成 n 个 BE，每个的父格分别指向 `be1.extendedBoxCEList` 的第 i 项 ⇒ **be1 : be2 = 1 : N**，用 `DirectExtendedBEContainer`。
- **间接更新（Indirect）**：`be2`、`be3` 都被扩成 n 个 ⇒ 两串一一对应 ⇒ **be2 : be3 = 1 : 1**，用 `IndirectExtendedBEContainer`。
- **交叉单元格**（同时有行、列父格）：更新完一个方向后，**必须再更新另一个方向**。

```
calCellElementAndSetState'(cellElement):
  计算 BEB 放入 be_beb_2D; beList = beb.beList
  refresh_be_array_relation(beList)

refresh_be_array_relation(beList):
  cellElementExtendBEsMap = new HashMap()
  for be in beList: refresh_be_relation(be, cellElementExtendBEsMap)
  refreshBEB(cellElementExtendBEsMap)          // 把新 BE 链表写回各单元格 BEB.beList

refresh_be_relation(be, cellElementExtendBEsMap):
  beExtendBEsMap = new HashMap()
  beExtendBEsMap.put(be, new DirectExtendedBEContainer(be.extendedBoxCEList))
  extendedCount = be.extendedBoxCEList.size()
  for childBE in be.childBEs:
      childBE 拷贝出 extendedCount-1 份（共 extendedCount 个）
      beExtendBEsMap.put(childBE, new IndirectExtendedBEContainer(那 extendedCount 个 childBE))
      cellElementExtendBEsMap.put(childBE.cellElement, 那 extendedCount 个 childBE 的链表)
      对 childBE 的子格递归执行本过程     // 沿继承链一路向下
  for <k, container> in beExtendBEsMap:
      Direct   -> 从 beExtendBEsMap 取每个 childBE 的 childExtendBEList，
                  与 extendCellList 一一对应；结果放回 be.childBEs
      Indirect -> 同上做一一对应；若 k 是交叉单元格，还需更新另一方向

refreshBEB(cellElementExtendBEsMap):
  for <cellElement, list> : beb = cellElement 的 BEB; beb.beList = list
```

### 4.5 计算最终结果矩阵（4.6）

**Step 1 深度序列 `deepList`**：`deepIndex = MAX(行父格深度, 列父格深度) + 1`，同深度的多个单元格放同一层 list。
年级成绩表：`0 层 {A1,A3,C3,D3,A4,A5,D5}`、`1 层 {B4,C5}`、`2 层 {C4,D4}`。

**Step 2 定位顺序**：
- 不同深度：**由浅入深**（子格位置依赖父格）。
- 同深度：**先定位有扩展属性的，再定位无扩展属性的** —— 否则先定位的静态格会因矩阵增行/列而被**二次搬迁**，先扩展可免除二次定位，提升效率。

**Step 3 `ExtendedArea` 决定步长**（处理 colspan/rowspan 的关键）：
父格占 1×1，但它的子格可能占 1×2、1×3，则父格各数据值之间应间隔：
- 横向扩展：间隔 `toColumn − fromColumn + 1` 列，共增加 `(toColumn−fromColumn+1) * (size−1)` 列
- 纵向扩展：间隔 `toRow − fromRow + 1` 行，共增加 `(toRow−fromRow+1) * (size−1)` 行

**Step 4 设置最终位置**：
```
offset = 此前定位已累计增加的行/列数
fromIndex/toIndex = ExtendedArea 起止（横向取列，纵向取行）
offsetBetweenBoxCEs = toIndex - fromIndex + 1
addedBoxCECount     = offsetBetweenBoxCEs * (extendedBELength - 1)
nextIndex = 0
for boxCE in extendedBEList:
   横向: boxCE.row = area.row;  boxCE.column = area.column + nextIndex + offset
   纵向: boxCE.column = area.column; boxCE.row = area.row + nextIndex + offset
   nextIndex += offsetBetweenBoxCEs
return addedBoxCECount
```

**Step 5 重算映射序列**：每段扩展记录 `info = [startPos, fromIndex, toIndex, copyLength]`，多段组成 `infoList`。
`addedCount = Σ (toIndex − fromIndex) * copyLength`。
新序列 = `原样拷贝[startPos 之前]` + `把 [fromIndex, toIndex] 复制 copyLength 份` + `原样拷贝剩余`。
`columnMappingArray` 例：`[0,1,2,3]` → C3 扩展后 `[0,1,2,2,2,2,2,2,3]`。

**Step 6 `boxCEMatrix` 扩容**：与映射序列"扩展+设置同时进行"不同，结果矩阵**先整体扩容、再逐行搬迁并重置每个 BoxCE 的行列号**，逐行遍历、按 `infoList` 三段拷贝，`destCol += copyLength * (toIndex − fromIndex + 1)`。

---

## 5. 表达式与计算（论文的真实覆盖度）

**结论：论文在表达式层几乎空白，这是它最大的短板。**

- 唯一出现的公式是 `SUM(C4)`、`AVERAGE(C4)`、`AVERAGE(D4)`、`=SUM(A3+B5)`，仅作为"借鉴 Excel 表达方式"的示例。
- **没有**表达式解析器 / AST / 词法语法分析；**没有**依赖图或拓扑排序；**没有**层次坐标（润乾的 `C4[A4:1]{...}` 之类）或聚集表达式语法。
- 依赖与循环引用仅靠 `isCalculatingSet` 粗暴判定：一旦重入即抛"死循环异常"——无法区分"非法自引用"与"合法的相对/累计引用"。
- 跨行组运算（占比、环比、同期比）作为立项动机提出，但**正文未给出任何实现**。
- C4 这类交叉单元格如何按"当前班级 + 当前科目"取到唯一分数，论文只用"**继承关系的过滤作用**"一句话带过，**未给出过滤算法**（score 表是 (班级,姓名,科目,分数) 明细行，取值必须按行父格+列父格的当前值过滤）。
- 多源关联同样只是声明式：`D2 = dept.deptName`，条件"deptId 等于 employee 表中的 deptId 列"——**无 join / 主子表 / 过滤条件的建模**。

---

## 6. 输出层

### 6.1 分页（第五章）
- **影响因素 4 个**：纸张可用宽高（去页边距/页眉页脚）、单元格大小、重复标题行/结尾行、行列分页属性（行前/行后/列前/列后）。
- **步骤**：遍历工作表 → 取纸张可用宽高 → 取 `pageByRowList` / `pageByColList`（行前分页记 `row`，行后分页记 `row+rowSpan`）→ 无重复元素走普通分页、有重复元素走重复分页 → 生成 `ClippedECI` 分页对象集合。
- **区域分布序列**：`pageRowIndexList` / `pageColumnIndexList`，元素为 `IdxHeaderFooter{idx, headerRepeatList, footerRepeatList}`。**总页数 = 行区域数 × 列区域数**。
- **普通分页 `dealWithRowBreak`**：累加 `totalRowHeight`，超 `pageHeight` 或命中 `pageByRowList` 则开新区；若 `pageRowIndexList.last.idx == currentRow`（零进展）或单行高度 > 可用高度 → **抛死循环异常**；末尾补一个 `idx=maxRow` 的哨兵区域。
- **重复分页 `paginate_according_to_repeat`**：额外维护 `repeatHeaderMappingRowList` / `repeatFooterMappingRowList` / `repeatFooterRowList`、`totalRepeatHeight`；跳过本区已包含的重复行；分页时向前/向后寻找重复标题行与结尾行写入新区域的 header/footer 列表。
- 示例：华北 70 单 + 华东 20 单，地区格设行前分页、末行设重复结尾行，每页 50 行 ⇒ 行方向 3 个区域、列方向 1 个 ⇒ 3 页。

### 6.2 HTML 展示
`Tag`（一般标签）+ `TextHtml`（数据内容）两个类，按 `table → tbody → tr → td → TextHtml` 逐层生成。

### 6.3 Excel 展示（POI）
| 类 | 用途 |
|---|---|
| `HSSFWorkbook` | .xls（03 及以前，每 sheet 65536 行上限） |
| `XSSFWorkbook` | .xlsx（每 sheet 1048576 行），全量内存，大数据会 OOM |
| `SXSSFWorkbook` | 流式写，仅 07+，**适合大数据导出** |

API：`createSheet / createRow / createCell / setCellValue`、`CellRangeAddress + addMergedRegion`（合并单元格）、`createCellStyle`（居中、背景色）、`createFont`（加粗、字号）。论文给的理由是"基于单元格的引擎天然支持导出 Excel"。

---

## 7. 实验与结论（第六章 / 第七章）

**测试方式**：6 个场景的**功能验证 + 截图**，全部是"由上图可见，该报表引擎可以处理 X 报表"式的定性结论。

| 场景 | 内容 |
|---|---|
| 6.1 多源报表 | employee + dept 两表，D2 靠 deptId 相等跨源取值 |
| 6.2 条件属性 | 隔行换色（偶数行加背景）、薪水 ≥6000 高亮 |
| 6.3 分组报表 | classInfo 按班级分组合并 |
| 6.4 交叉报表 | 年级成绩表（行班级/学生 × 列科目） |
| 6.5 按组分页 | 每个班级的学生信息单独一页（行前分页 + 分组） |
| 6.6 导出 Excel | 员工表、年级成绩表导出 |

**关键事实：全文没有任何性能数据**——无响应时间、无数据量级、无并发数、无内存占用、无与润乾/Jasper 的对比基准。第七章只说"测试结果表明……能够**基本**满足中国式报表要求"。

**自述不足与展望（第七章）**：
1. 数据钻取（改变维的粒度层层深入）
2. 树形报表（左树右表联动）
3. **报表设计器**（当前只能手写 XML，明确承认缺失）
4. 多种导出格式（PDF / WORD / PNG）

未被自述但实际缺失的：填报（立项时列为四特征之一）、图表、表达式引擎、性能工程。

---

## 8. 对自研非线性报表引擎的可借鉴做法

### 8.1 直接可搬的数据结构（建议 Rust 化）
```rust
struct Beb { be_list: Vec<Rc<RefCell<Be>>> }          // 一个抽象单元格
struct Be  { row_pe: Option<Weak<Be>>,                 // 注意：论文用强引用图，Rust 下应 Weak 防环
             col_pe: Option<Weak<Be>>,
             extended_box_ce_list: Vec<BoxCe>,
             child_bes: Vec<Rc<RefCell<Be>>>,
             cell_element: CellId }
enum BoxCe { Normal(Value), Extended(Value) }
```
`BEB → BE → BoxCE` 三层、以及 "BE 只能持有一个父格引用所以需要 BEB" 的论证，是我们设计扩展容器时最直接可复用的模型。

### 8.2 值得抄的 6 条机制
1. **默认父格自动推导 + 上溯规则**：用户不写父格，按"行父格必须是纵向扩展格、列父格必须是横向扩展格"沿默认父格链上溯，找不到置空。这条极大降低模板编写成本，是润乾式体验的核心。
2. **继承关系矩阵 `genealogy` 双向化**：父→子反查（`childMembers`）是扩展传播的基础，别把继承关系只存在单元格属性里。
3. **直接更新 / 间接更新二分**：父格有实值 → 子格 1:N 拷贝；父子同被拷贝 → 1:1 对应。用 `Direct/IndirectExtendedBEContainer` 区分，逻辑清晰、可单测。
4. **`deepList` + 定位顺序（同深度先扩展后非扩展）**：避免已定位单元格的二次搬迁，是零成本的性能优化。
5. **`ExtendedArea` 决定扩展步长**（`to−from+1`，而非固定 +1）：正确处理"父格 1×1、子格跨 1×2/1×3"导致的一次扩展要多列/多行的情况。这一点容易被自研时漏掉。
6. **双映射序列 `rowMappingArray` / `columnMappingArray` + `info[startPos, fromIndex, toIndex, copyLength]` 三段式增量扩容**：不必每次重建大矩阵，且映射序列本身可直接服务于分页、按组分页、行列回溯。映射序列"边扩边设"、结果矩阵"先扩后设"的差异处理也值得照抄。

### 8.3 其他工程细节
- **三处死循环防护**值得全面引入：`buildGenealogy` 的 HashSet（继承环）、`isCalculatingSet`（求值环）、分页的 `last.idx == currentRow`（零进展分区）。
- **两级缓存** `WorkBookEntryMap`（模板解析）+ `ResultCacheMap`（结果，带时效）+ `SessionInf`（按页输出）：服务端架构可直接对应我们的 print-server。
- **扩展与分页解耦**：先得完整结果矩阵，再按"行区域 × 列区域"生成分页，并用 `IdxHeaderFooter` 承载每页的重复表头/表尾，思路干净。
- **样式集中成 `StyleList`，单元格只存索引**——对 designer-react 的模板 JSON 同样适用。

---

## 9. 论文方案的明显缺陷与局限

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | **表达式引擎缺失** | 只举例 SUM/AVERAGE，无解析器、无依赖图、无层次坐标；跨行组运算（占比/环比/同期比）作为动机却无实现 |
| 2 | **交叉单元格取值算法未给出** | 只用"继承关系的过滤作用"一笔带过，score 明细行如何按 (班级, 科目) 过滤出唯一分数没有算法 |
| 3 | **无任何性能数据** | 无响应时间/数据量/并发/内存，结论仅"基本满足"，工程参考价值有限 |
| 4 | **多源关联能力弱** | 靠"deptId 等于 employee.deptId"的声明式等值条件，无 join / 主子表 / 过滤条件建模，且数据集是"一格一 SQL"级别抽象，极易 N+1 查询 |
| 5 | **算法复杂度与内存** | 每次父格扩展都整链拷贝子 BE，横纵交叉是笛卡尔展开；无流式/惰性求值，大数据量下 O(∏n) 膨胀，没有分页级裁剪 |
| 6 | **缓存一致性粗糙** | `WorkBookEntry` 无模板文件变更监听与失效；`ResultCache` 只有过期时间；**参数化报表与缓存 key 的关系完全没说明**（只提 `ReportCacheID`） |
| 7 | **schema 与能力不一致** | 第 6 章的条件属性在 XML schema 中无对应元素；`ResultCellElement` 与图 3-11 的 `ExtendCellElement` 命名冲突 |
| 8 | **分页能力有限** | 仅按行高/列宽贪心切分，不支持合并单元格跨页拆分；"按组分页"仅靠行前分页属性；普通分页与重复分页两份高度重复的逻辑 |
| 9 | **分页在扩展之后全量做** | 必须先生成完整结果矩阵再分页，内存峰值 = 全量结果，无法边扩展边分页 |
| 10 | **能力覆盖不全** | 填报、图表、PDF/WORD/PNG 导出、设计器、钻取、树形报表全部缺失；立项时提的"分片""填报合一"实际未做 |
| 11 | **扩展方向只有横/纵两态** | 未定义"跟随但不扩展"的显式第三态及其与父格值的一一对应规则（论文靠"无扩展格由父格驱动拷贝"隐式处理，语义含糊） |

---

## 10. 一句话定位

这是一篇**把"单元格继承关系驱动的扩展"完整落地一遍**的工程型硕士论文：第 4 章的 `BEB/BE/BoxCE` 模型、`genealogy` 矩阵、直接/间接更新、`deepList` + `ExtendedArea` + 双映射序列的最终矩阵计算，是**真正有复用价值的骨架**；而表达式、聚集/层次坐标、查询与过滤、性能工程这四块**基本是空白**，正是我们自研时需要自己补足（或直接沿用润乾既有方案）的部分。
