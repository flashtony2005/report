# 《报表引擎系统研究开发》结构化笔记

> 源文：`pdf-text/报表引擎系统研究开发.txt`（84 页扫描 OCR，6.1 万字/3023 行）。OCR 有 `I`↔`l`、`引擎`→`引攀`、`Lock`→`Ick` 等误识，已按上下文校正，不逐处标注。

## 1. 定位与元信息

硕士学位论文（科研报告 + 原型系统），非需求书/工业设计书。裴晓华，西安理工大学计算机应用技术，导师张璟教授，2009 年 3 月。课题来源：863 计划 2007 重点项目「面向流程管理的软件生产线」子课题「报表工具系统」。技术栈：Eclipse 3.2 + Java + 插件/RCP + OSGI + XML/DOM + XSL-FO + iText，UML 建模。发表：《微电子学与计算机·基于滑动窗口协议思想的报表引擎设计与实现》。

**核心判断**：这是**以 Eclipse BIRT 为蓝本**的剖析与复现（实例 XML 直接出现 `http://www.eclipse.org/birt/2005/design`、`oda-data-source`、`JdbcSelectDataSet`）。它**没有**润乾/蒋步星那套「主格—附属格—横纵扩展」非线性模型：其"扩展"是 BIRT 的 `ExtendedItem`（自定义项）与 Eclipse 扩展点，数据展开靠 Table/Grid/List 带状行列迭代。作者结束语自承："对于中国式报表中的交叉格式报表的解析还是显得捉襟见肘"。价值在于完整给出了**「设计文件 → 执行器树 → 二进制中间文档 → 分页 → 多格式发射」的工业管线骨架 + ROM 式模板 Schema + 模块间并发调度优化**。

## 2. 整体架构

### 2.1 七大子系统（3.2）

| 子系统 | 职责 |
|---|---|
| 报表请求器 | 参数封装、统一入口；响应控制与响应分配 |
| 格式定义器 | 输出格式、栏位格式（字体/颜色/框线/样式）、输出内容（对象、简单计算、页头/分组/页尾） |
| 引擎定义器 | 定义运行时算法、**执行次序**、循环/分解、外部接口；形参与实参、数据类型；产出 XML 引擎定义文件 |
| 运行引擎 | 按主题+算法+次序计算并回传结果（性能关键） |
| 策略引擎 | 按参数执行用户定义算法；可外挂业务系统灵活配置业务逻辑；含取数与计算 |
| 引擎监控器 | 采集/分析运行情况；出错跟踪（系统/引擎/算法定义三类）；暂停、中止、恢复、保存、载入 |
| 展现引擎 | 结合格式定义与运行结果生成界面，支持 HTML/EXCEL/WORD |

四大功能域（图 4-2）：请求（报表请求器）｜定义（格式定义器、引擎定义器）｜提取信息（策略引擎、数据引擎）｜生成（生成引擎、展现引擎）。
数据流：`报表文件 → 请求器 → 格式定义器 → 引擎定义器 → [算法|数据] → 策略引擎/生成引擎/数据引擎 → 展现引擎 → 报表`

### 2.2 十七个包（4.2.1）

| 包 | 职责与关键类 |
|---|---|
| `api` | 对外接口：`IReportEngine`、`IEngineTask`、`IRunTask`/`IRenderTask`、`IRenderOption`、`IPDFRenderOption`、`IPageHandler`、`IHTMLActionHandler`、`IAction`、`IDataExtractionTask`、`ParameterDefn`、`ParameterGroupDefn`、`ICascadingParameterGroup` |
| `adapter` | 适配外部模块；`ExpressionUtil`、`ParseIndicator` |
| `content` | **核心**：`IContent`/`IReportContent`/`IContentVisitor`/`ContentVisitorAdapter`/`ContentFactory`，`CellContent`、`RowContent`、`BandContent`、`ListBandContent`、`TableBandContent`、`TableContent`、`GroupContent`、`ListGroupContent`、`AutoTextContent`、`ImageContent`、`LabelContent`、`ForeignContent`、`PageContent`、`Column`、`IStyle`、`Dimension` |
| `css` | `BIRTCSSEngine`/`CSSEngine`、`ComputedStyle`、`CellComputedStyle`、`StyleDeclaration`、`PropertyManagerFactory`、`BIRTPropertyManagerFactory`、`ValueManager`、`PerfectHash`（`hash()`/`in_word_set()`） |
| `data` | `DataEngineFactory`（单例 `getInstance()`/`createDataEngine()`）、`IDataEngine` |
| `emitter` | `IContentEmitter`、`ContentEmitterAdapter`、`BufferedReportEmitter`、`DOMBuilderEmitter`、`ContentDOMVisitor`、`EngineEmitterServices` |
| `extension` | `IReportItemExecutor`、`ReportItemExecutorBase`、`IExecutorContext`、`IReportItemGeneration`、`BaseResultSet`、`QueryResultSet` |
| `internal` | 文档内部信息回填；`RowSet`/`SingleRowSet`；`wrap` 层 `AbstractContentWrapper`、`CellContentWrapper`、`RowContentWrapper`、`TableContentWrapper`、`TableBandContentWrapper`、`TextContent`、`DataContent` |
| `ir` | 设计侧中间表示：`BandDesign`、`DataItemDesign`、`AutoTextItemDesign`、`CellDesign`、`ColumnDesign`、`RowDesign`、`GridItemDesign`、`ListingDesign`、`ListGroupDesign`、`GroupDesign`、`MasterPageDesign`/`SimpleMasterPageDesign`、`GraphicMasterPageDesign`、`PageSetupDesign`、`PageSequenceDesign`、`Expression`、`RuleDesign`、`HighlightRuleDesign`、`MapRuleDesign`、`ActionDesign`、`DrillThroughActionDesign`、`EngineIRConstants`、`EngineIRWriter`、`IReportItemVisitor`/`DefaultReportItemVisitorImpl` |
| `layout` | `LayoutEngineFactory`、`IReportLayoutEngine`、`ILayoutManager`、`ILineStackingLayoutManager`、`IBlockStackingLayoutManager`、`IStackingLayoutManager`、`IPDFTableLayoutManager`、`ITextLayoutManager`、`IArea`/`IContainerArea`/`ITextArea`/`IImageArea`/`ITemplateArea`、`CompositeLayoutPageHandler`、`PDFConstants` |
| `parser` | `ReportDesignWriter`、`TableItemDesignLayout`（`layout()`/`layoutBand()`/`layoutRow()`/`normalize()`） |
| `presentation` | **展现核心**：`ReportDocumentBuilder`、`LocalizedContentVisitor`、`ContentEmitterVisitor`、`Page`、`PageRegion`、`PageSection`、`PageHint`/`IPageHint`、`UnresolvedRowHint`、`InstanceIndex`、`CompositePageHandler` |
| `script` | 脚本转 Java 调用；`ScriptExecutor`、`ReportContextImpl`；实例层 `CellInstance`、`DataItemInstance`、`GridInstance`、`ListInstance`、`TextItemInstance`、`ImageInstance`、`AutoTextInstance`、`ActionInstance`、`DrillThroughInstance`、`ReportItemInstance` |
| `toc` | `DocumentTOCTree`、`TOCBuilder`、`TOCEntry`、`TOCTree`、`TOCTreeNode` |
| `util` | `ExportManifestUtils`；`FastPool`（对象池 `pool[]`/`poolSize`/`isEmpty()`/`add()`/`remove()`） |
| `executor` | **生成引擎**：解析设计文件并生成二进制报表文档 |
| `i18n` | 消息与本地化 |

### 2.3 运行流程（3.3）

定义器生成 XML 引擎定义文件 → 运行器导入并**解释成引擎可操作对象** → 用户传启动参数+报表 ID → 查找并实例化定义对象 → 按算法次序执行；每个算法按形参从环境读实参，**表达式**交给策略引擎、**外部过程**按定义调用并保存结果 → 全程可监控/暂停/恢复 → 返回结果 → 生成器按格式定义出报表。

## 3. 数据模型与模板模型

### 3.1 两个核心文件（3.4）

| 文件 | 说明 |
|---|---|
| `*.rptdesign` | **XML** 设计文件：结构、格式、数据源、数据集、javascript 事件处理代码 |
| `*.rptdocument` | **二进制**文档文件：设计 + 已集成数据 + **分页信息 + 目录（TOC）信息**，由生成引擎产出、交展现引擎 |

### 3.2 `rptdesign` 元素体系（表 3-15，BIRT ROM，节选）

- **属性基础**：`Property`（简单值，DOM 查元属性数据集确定类型）、`xml-property`（自定义 XML 属性，用于扩充存储）、`property-list`（列表属性：自定义颜色、绑定）、`Expression`（被表达式定义的属性）、`ex-property`（不规整属性）、`Structure`（属性集合）、`DesignElement`/`ReportElementDesign`（抽象，`ID`/`name`/`extends`/`javaClass`/命名表达式）、`ReportDesign`（根）、`ReportItemDesign`（`x`/`y`/`width`/`height`、书签、内容树、页中断点、可视性、行为、查询、执行状态）、`StyledElementDesign`（`styleName`/maps/highlights）。
- **容器**：`Grid`（行列表格）、`Table`、`Row`、`Cell`、`Column`、`List`、`FreeForm`、`Rectangle`、`Line`、`TableGroup`、`ListGroup`/`ListingGroup`、`Listing`（抽象）、`MasterPage`/`SimpleMasterPage`（每页头尾）、`GraphicMasterPage`、`PageSetupDesign`、`PageSequenceDesign`（`pageRefs` 哈希地图排序主页中的页）。
- **内容项**：`Label`（可多语言静态文本）、`Data Item`（DB 列/表达式）、`Text item`/`Text`/`TextData`/`MultiLineItemDesign`、`Image`、`AutoText`（页码）、`Chart`、`Matrix`、`Table-of-contents item`、`Browser`、`Extended item`（自定义项，提供可扩展能力）、`Include`、`Library`、`Theme`。
- **数据与参数**：`Data Source`、`DataSet`（简单/联合数据集父节点）、`SimpleDataSet`、`JointDataSet`、`ScriptDataSet`（js 定义）、`OdaDataSet`/`OdaDataSource`（ODA 开放数据访问接口驱动）、`OdaDataSetParam`、`OdaResultSetColumn`、`OdaDesignerState`、`TemplateDataSet`、`Data`、`Parameter`、`ScalarParameter`、`CascadingParameterGroup`、`ParameterGroup`、`TemplateParameterDefinition`、`TemplateElement`、`TemplateReportItem`、`Config Var`。
- **规则/格式/其他**：`HideRule`（按输出格式定义可视化规则）、`HighlightRule`、`MapRule`、`RuleDesign`（抽象：`testExpression`/`value1`/`value2`/`operator`/`expression`）、`SortKey`（表达式+分类说明）、`SearchKey`、`SelectionChoice`、`ComputedColumn`、`ColumnHint`、`CachedMetaData`（**缓存派生数据集属性**）、`Style`、`CustomColor`、`NumberFormatValue`/`DateTimeFormatValue`/`StringFormatValue`/`ParameterFormatValue`、`EmbeddedImage`、`ScriptLib`、`IncludeScript`、`IncludeLibrary`、`Action`、`PropertyBinding`、`ParamBinding`、`ExtendedProperty`、`UserProperty`、`PropertyMask`（第三方锁定/隐藏属性）。
- IR 包 `Expression` 类字段：`表达式ID`、`组名称`、`表达式`、`整数型数据类型`。

### 3.3 设计文件片段（6.1）

```xml
<report xmlns="http://www.eclipse.org/birt/2005/design" version="3.2.7" id="1">
  <property name="units">in</property>
  <data-sources>
    <oda-data-source extensionID="org.eclipse.birt.report.data.oda.jdbc" name="Data Source" id="41">
      <property name="odaDriverClass">org.eclipse.birt.report.data.oda.sampledb.Driver</property>
      <property name="odaURL">jdbc:classicmodels:sampledb</property>
      <property name="odaUser">ClassicModels</property>
    </oda-data-source>
  </data-sources>
  <data-sets>
    <oda-data-set extensionID="...jdbc.JdbcSelectDataSet" name="Data Set" id="42">
      <structure name="cachedMetaData">
        <list-property name="resultSet">
          <structure>
            <property name="position">1</property>
            <property name="name">CUSTOMERNAME</property>
            <property name="dataType">string</property>
          </structure>
        </list-property>
      </structure>
      <property name="dataSource">Data Source</property>
    </oda-data-set>
  </data-sets>
</report>
```

要点：列元数据以 `cachedMetaData/resultSet` 缓存 `position`/`name`/`dataType`；数据集按 `name` 引用数据源而非内联——**设计期缓存元数据，运行期无需回查库**。

### 3.4 关键设计类（4.2.3，节选）

| 类 | 关键字段/能力 |
|---|---|
| `DataSetID` | 父数据集 ID、行 ID、查询名、数据集名 → 组合成相关信息组供处理模块使用 |
| `EngineConfig` | 引擎/数据源/图像存放位置；允许自定义图像、超链接、字体处理 |
| `CatchedImage` | 图像 ID、URL、MIME、图像映射 → 提供**图像缓存地址** |
| `ExpressionUtil` | `getParseIndicator()`；`transformConditionalExpression()` 增加属性前缀；`prepareTotalExpression()` 把 `row` 转成 `dataSetRow` |
| `IColumnBinding` | 列绑定命名表达式对：`getResultSetColumnName()`、`getBoundExpression()` |
| `ITotalExprBindings` | `getNewExpression()` 把所有 `Total` 表达式替换为 `row` 表达式；`getColumnBindings()` 返回其中出现的列名绑定 |
| `ModelOdaApiAdapter` | 从 model.api 创建数据引擎接口对象；可传 `ExecutionContext` 与 JavaScript 视图（评估 data source/data set 绑定表达式） |
| `AbstractReportContentWriter` | `writeFullContent`；内部类 `ContentWriterVisitor` 把内容输出到磁盘 |
| `DocumentExtension` | 12 个方法遍历文档树：`getIndex`/`setIndex`、`getFirstChild`/`setFirstChild`、`getParent` … |
| `GroupDesign` | 抽象：整数数组`水平`、`pageBreakBefore`/`pageBreakAfter`、`hideDetail`、`repeatHeader` → 列与图表中的**组类型** |
| `GridItemDesign` | 序列行和列（静态表格）；`ListingDesign`：`repeatHeader`、表头/表尾/细节、`pageBreakInterval` |

## 4. 生成引擎：执行器树与展开机制（5.1，重点）

本文的"展开"= **以执行器为节点、按设计树深度优先递归生成报表项实例**。

### 4.1 执行器族（`executor` 包，图 4-10）

| 类 | 角色 |
|---|---|
| `ExecutorManager` | **工厂方法**统一管理创建与运行；用**代号给执行器编号（17 个报表执行项目 → 17 个编号）**；持有执行环境（上下文）、执行器工厂、内容发射器 |
| `ReportItemExecutor` | 抽象类，**所有项目执行类的超类**。持有：项目运行管理器（提供环境信息与发射器）、**父项目执行器**（实时信息交互）、内容属性（暂存已运行项目）、报表项目设计属性、树形文档目录实体、异常信息 |
| `GroupExecutor` | 抽象子类；多个布尔变量；**组执行器，负责分页**；`createPageExecutor()`/`execute()`/`close()`/`hasNextChild()`/`getNextChild()` |
| `StyledItemExecutor` | 抽象基类（数据项/文本项处理器）；`processStyle()`、`processColumnStyle()`、`createHighlightStyle()`、`processMappingValue()` |
| `AutoTextItemExecutor` | 执行 AutoText 并输出内容；处理 action、bookmark、style、文本可见性 |
| `CellExecutor` | 处理**单元格**；字段 `cellId:int`、`currentItem:int` |
| `QueryItemExecutor` | 抽象；`resultSetEmpty:boolean`；`executeQuery()`/`accessQuery()`/`closeQuery()` |
| `DataItemExecutor` | 数据项**表达式计算**、生成内容实例、评估样式/书签/行为、送实例到输出器 |
| `GridItemExecutor` | `curRowDesign:int`、`curRowContent:int`；生成栅格并发射 |
| `ExtendedItemExecutor` | 自定义项；`getQueryResults()`、`getParent()` |

### 4.2 `ReportItemExecutor.execute()` 算法（5.1.1）

```
1)  调用子类中执行器，执行该项目的运行任务
2)  IF（该项目有子项目节点）
3)      IF（只是环境被注销 / context.isCanceled()）
4)          关闭执行器（break）
5)      获取该项目下一个子项目节点
6)      实现子项目节点运行任务
7)      跳转到步骤 2
```

```java
public void execute( ReportItemDesign item, IContentEmitter emitter )
{
    execute();
    while ( hasNextChild() )
    {
        if ( context.isCanceled() )
        {
            break;
        }
        ReportItemExecutor child = ( ReportItemExecutor ) getNextChild();
        child.execute( child.getDesign(), emitter );
    }
    close();
}
```

结构要点：`execute()`/`hasNextChild()`/`getNextChild()`/`close()` 构成**可中断的迭代器式遍历**（非一次性递归），是大报表流式生成的前提；节点自带 `context`（支持取消）、`parent`（父子上下文/分组状态继承）、`content`；`IContentEmitter` 随递归下传，**边生成边发射**。另有专门的书签处理方法与可见性处理方法（控制行隐藏/显现）。

### 4.3 `AutoTextItemExecutor.execute()`（5.1.2，页码）

```
1) 获得报表项目的详细设计信息
2) 在报表内容中创建自动文本内容，用于存放处理过的自动文本项目
3) 设置、保存并初始化内容
4) 处理报表中的样式和报表项目可见性
5) 从被执行的报表项目中获取自动文本的类型
6)   IF     能够得到当前页的信息   → 在自动文本内容中设置页号
     ELSE IF 能得到自动文本总页数   → 设置自动文本总页数
7) IF 发射器存在 → 调用发射器执行发送自动文本的工作
8) 返回自动文本内容
```

### 4.4 `ExecutorManager` 与 .lck 文件锁（5.1.3）

流程：`收到待执行项目触发 → 分析所需执行器类型 → 工厂创建执行器 → 执行器按环境信息解析 → 发射器发往下一模块`。

用户想独占某文件时必须加锁：

```
1) 接受模块查询独立使用文件的详细信息
2) IF 文件被占用 → 等待
3) ELSE 在该文件的同名目录下新建一个与该文件同名的 .lck 文件 → 加锁
4) 用户独立使用该文件
5) 删除 .lck 文件 → 解锁
```

`.lck` 存在=已加锁（须等释放），不存在=未加锁或已解锁。（OCR 把 `lck` 识别为 `Ick`。）

## 5. 展现引擎：组装、分页与发射（5.2）

```
报表文档文件(二进制)
 → ReportDocumentBuilder（管理/组装成完整报表文档）
 → LocalizedContentVisitor（访问者模式遍历；信息存于 Page）
 → PageHint（建立页项目索引）
 → ContentEmitterVisitor（访问发射器）
 → HTML / PDF / Excel / Word ...
```

| 类 | 职责 |
|---|---|
| `Page` | 暂存文档信息，并指定相应发射器 |
| `PageRegion` | 初始化 `Page` 中的发射器（含 `rootRegion`） |
| `CompositePageHandler` | 管理发射器接收的文档：注册与注销 |
| `PageHint`/`IPageHint`/`PageSection`/`UnresolvedRowHint`/`InstanceIndex` | 分页索引：`UnresolvedRowHint` 处理**跨页未决行**（行级续页），`InstanceIndex` 定位实例 |
| `ReportDocumentBuilder` | 组装 + 异常日志 + 执行上下文 + 文档读写器；**哈希表存书签索引号**；把"保存内容到内容流的发射器"与"保存主页框架的发射器"做成**内部类**以减少调用开销 |

配合 `layout` 包的 `ILayoutPageHandler`/`CompositeLayoutPageHandler`/`IBlockStackingLayoutManager`/`IPDFTableLayoutManager`，"页→区间→实例索引"三级结构使大报表**无需整体驻留内存、可按需定位到页/行**。

### 5.1 图片项处理（`ReportDocumentBuilder`，4 种来源）

```java
switch ( imageDesign.getImageSource() )
{
    case ImageItemDesign.IMAGE_URI:            // URI
        String imageExpr = imageDesign.getImageUri();
        if ( imageExpr != null ) handleURIImage( imageExpr, imageContent );
        break;
    case ImageItemDesign.IMAGE_FILE:           // 文件
        String fileExpr = imageDesign.getImageUri();
        assert fileExpr != null;
        handleFileExpressionImage( fileExpr, imageContent );
        break;
    case ImageItemDesign.IMAGE_NAME:           // 嵌入式图片
        String imageName = imageDesign.getImageName();
        assert imageName != null;
        handleNamedImage( imageName, imageContent );
        break;
    case ImageItemDesign.IMAGE_EXPRESSION:     // 从数据库中获取到的图片
        String imgExpr = imageDesign.getImageExpression();
        String fmtExpr = imageDesign.getImageFormat();
        assert imgExpr != null;
        handleValueImage( imgExpr, fmtExpr, imageContent );
        break;
    default:
        logger.log( Level.SEVERE, "[ImageItemExecutor] invalid image source" );
        context.addException( imageDesign.getHandle(),
            new EngineException( MessageConstants.INVALID_IMAGE_SOURCE_TYPE_ERROR ) );
        assert false;
}
```

### 5.2 `LocalizedContentVisitor`（5.2.2，访问者模式）

可访问列表、表格、行、单元格、数据项、标签、图片、文本、外部文件等子项目。属性：执行环境信息、本地环境信息、输出格式、模板的哈希报表属性；每类项目各建对应方法。图片访问算法：

```
1) 创建一个图像内容
2) 把图片项目入栈
3) 打开查询并游历到第一条数据
4) 初始化内容
5) 处理图片项目所必须的基本元素
6) 访问处理图像内容
7) IF 执行环境存在工厂 → 执行图片的展现功能
8) 返回图片对象
```

## 6. 表达式与运算

- **脚本**：`rptdesign` 内嵌 **javascript** 事件处理代码；`ScriptDataSet` 用 js 定义数据集；`script` 包「接受脚本 → 转化为 java 程序 → 调用相应模块」。
- **表达式改写（关键）**：`prepareTotalExpression()` 把 `row` → `dataSetRow`；`ITotalExprBindings.getNewExpression()` 把所有 `Total` 表达式**替换为 `row` 表达式**，并由 `getColumnBindings()` 给出列绑定集合 —— **聚合在进入数据引擎前被降级为行级表达式 + 列绑定，真正下推到数据集/DB 层**，而非展现层二次遍历。
- **解析辅助**：`ParseIndicator` 提供 `getRetrieveSize()`、`getNewIndex()`、`isCandidateKey()`、`omitNextQuote()`、`getCandidateKey1/2()`。
- **规则结构统一**：`RuleDesign{testExpression, value1, value2, operator, expression}` 一套结构同时服务 `HighlightRule`、`MapRule`、`HideRule`、`SortKey`——条件样式/条件隐藏/排序不必各建一套。
- **样式引擎**：`BIRTCSSEngine` + `PropertyManagerFactory`/`BIRTPropertyManagerFactory` + `ValueManager` + `ComputedStyle`/`CellComputedStyle`（`resolveProperty()`、`isBackgroundProperties()`）；用 `PerfectHash`（`hash()`/`in_word_set()`）做属性名**完美哈希**查找。
- **缓存**：`CachedMetaData`（缓存派生数据集属性）、`CatchedImage`、`FastPool` 对象池、滑动窗口缓冲区。1.3 节把"定时计算、缓存"列为**服务器方式优于控件方式**的核心理由。

## 7. 性能与工程实践：滑动窗口协议（5.2.3–5.2.5，本文最大创新点）

**动机**：系统切 7 个模块，各模块在指定时间只处理报表相应部分；无调度算法则**下游等待过长**，效率大降。

**方案：选择重传（Selective Repeat）**。发送方维持发送窗口（已发未确认帧序号），接收方维持接收窗口，二者上下界与大小可不同；发完一帧**不停下来等应答**，可连续发送；接收方发现出错帧时，其后继帧**不立即递交高层而存入缓冲区**，要求重传出错帧，收齐后与该帧**按正确顺序一起递交**。

在引擎中的映射（图 5-4）：上游已处理模块 → 本模块处理 → **为每个模块设定定时器** → 发下游 → **已发模块放入缓冲区** → 进入监听；接收方收到即发确认；发送方收到确认即清缓冲；**超时或收到出错信息 → 从缓冲区取出重发**。

**发送方算法**：
```
1) 处理已接受的报表文件的各个报表文件块
2) 依次发送已接受本模块处理的报表文件块
3) 对各个报表文件块设置要求确认的标记，启动定时
4) 如果收到确认
       If（确认信息） → 释放已经得到确认的缓冲区
       If（出错信息） → 重新发送出错模块
5) 定时器时间到
6) 依次重发确认超时的报表文件块
7) 继续步骤（3）
```
**接收方算法**：
```
1) 收到报表文件块
2) 判断报表文件块是否符合要求
3) If 报表符合要求
4)     If 有待发返回信息 → 捎带确认（piggyback）→ 返回
5) else 不符合要求
6)     发送出错信息
```

### 7.1 实测数据（5.2.5）

环境：Windows Server 2003 / Pentium 2.4 / 768MB。对比有/无窗口控制生成同样大小报表的耗时：

| 表格 (kb) | 无窗口 (ms) | 有窗口 (ms) |
|---|---|---|
| 15 | 10 | 10 |
| 50 | 13 | 12 |
| 100 | 18 | 19 |
| 200 | 25 | 20 |
| 300 | 29 | 26 |
| 500 | 40 | 36 |
| 1000 | 52 | 40 |
| 3000 | 103 | 80 |

> OCR 把表格拆成乱序两列（如 `15/50/10/300/13/500/100/18/...` 与 `15/10/300/26/50/12/...`）。上表按大小序列 {15,50,100,200,300,500,1000,3000} + 耗时单调递增**推断还原**；与论文结论（曲线 1/2 小文件接近、大文件拉开，y 轴上限约 140ms）一致。小报表相差无几，1000kb −23%、3000kb −22%。

### 7.2 其他工程实践

- **部署形态对比**（1.3）：控件方式（ActiveX，部署重、升级须重装、无法利用服务器定时计算与缓存，只适合小型简单报表）｜独立服务器（性能好但难跨平台、集群/连接池扩展性差）｜**Java 引擎**（跨平台；以类包嵌入 J2EE，可复用负载均衡、连接池等一切手段）——本文选第三种。
- **模块化解耦**：7 个子系统各做一个 Eclipse 插件（OSGI bundle），松散耦合、便于维护复用与团队并行。
- **内部类降本**：`ReportDocumentBuilder` 把高频发射器做成内部类，"省去类之间调用所花费的时间和空间"。
- **模式**：工厂方法（`ExecutorManager`）、访问者（`LocalizedContentVisitor`/`ContentWriterVisitor`/`ContentEmitterVisitor`）、单例（`DataEngineFactory`）、适配器（`adapter` 包/`ModelOdaApiAdapter`）。
- **错误定位**：`context.addException(design.getHandle(), new EngineException(...))` + `logger.log(Level.SEVERE, ...)`，异常挂到设计对象句柄，可回显到具体模板节点。
- **输出格式**：HTML、Excel、PDF（iText / XSL-FO+FOP）、CSV、SVG、Word、XML、RTF、SpreadsheetML、WordML（部分来自对 Windward/EOS 的调研）。

## 8. 运行实例（第 6 章）

1. **直接解析设计文档**（电信城八区销售分类统计+排名）：`创建引擎配置 → 创建运行任务 → 创建展现任务 → 设置输出格式 → 创建报表引擎 → 打开报表 → 得到顶层树形节点 → 显示子节点信息 → 得到输出格式的报表`。
2. **嵌入设计器**：新建报表 → 选模板 → 设计（Outline 树：数据源/数据集/报表参数；Master Page 与 Layout 分 Tab；Palette / Data Explorer / Source / Preview）→ 报表查看器出 HTML → "在 PDF 中查看报表"出 PDF（PDF 侧呈分组折叠树：President / Sale Manager(EMEA·APAC·NA) / Sales Rep / VP Marketing / VP Sales）。
3. **图表**：饼图（Classic Cars 35,582 / Trucks and Buses 22,933 / Motorcycles 12,778 …）→ 一键转柱状图。

## 9. 与润乾/蒋步星体系的差异及可借鉴点

### 9.1 差异

| 维度 | 本文（BIRT 系） | 润乾 / 蒋步星非线性模型 |
|---|---|---|
| 模型 | **带状模型**：Grid/Table/List + Row/Cell + Group，行列迭代与分组展开 | **单元格扩展模型**：主格/附属格，按扩展方向复制展开，构成扩展树 |
| "扩展"语义 | `ExtendedItem` = 自定义项 / Eclipse 扩展点 | 单元格横纵扩展、跟随扩展、比例膨胀 |
| 交叉表 | 仅 `Matrix` 元素与 `TableGroup`；作者承认**中国式交叉表力不从心** | 非线性模型的核心能力 |
| 表达式 | javascript；`Total`→`row` 改写 + 列绑定下推数据引擎 | 单元格引用 + 层次坐标/主格坐标 + 集合运算 |
| 分页 | 先生成二进制文档，再 `PageHint`/`UnresolvedRowHint` 分页 | 在展开后的行列空间上统一分页 |
| 中间产物 | `rptdocument`（二进制，含分页与 TOC） | 已展开的单元格矩阵 / 内存报表对象 |

补充：文中调研的 **EOS 报表**反而更贴近我们的方向——支持"展开区域"、字段集**横向（列展开）/纵向（行展开）/双向展开及交叉表展开**，并用标准 javascript 扩充了"数据引用、单元格引用、汇总"等报表函数。润乾在文中仅一句带过（创新报表模型、跨平台大型应用、HTML/EXCEL/PDF 展现、填报、强大 API；缺点是走高端、价格贵、外围功能少、入门难）。

### 9.2 可直接借鉴（按优先级）

1. **双阶段 + 二进制中间文档**：`rptdesign`（XML 设计）→ 生成引擎 → `rptdocument`（二进制，含数据与分页/TOC）→ 展现引擎。生成与展现彻底解耦，一次生成多格式多次展现，天然支持缓存与续跑。建议作为 `print-server` 的稳定序列化边界（用扁平/列式 buffer，而非语言级序列化）。
2. **迭代器式执行器树**（强推）：`execute()/hasNextChild()/getNextChild()/close()` + `context.isCanceled()` + `parent` 引用 + 随递归下传的 `emitter`，让"流式生成 + 可取消 + 父子上下文继承"同时成立。几乎可直映射为 Rust trait，并保留"按代号编号的执行器注册表"（本文 17 种）→ `enum ItemKind` + 工厂表零成本分发：
   ```rust
   trait ItemExecutor { fn execute(&mut self, ctx:&mut ExecCtx, out:&mut dyn Emitter);
                        fn has_next_child(&self)->bool;
                        fn next_child(&mut self)->Option<Box<dyn ItemExecutor>>;
                        fn close(&mut self); }
   ```
3. **`UnresolvedRowHint`/`PageHint`/`InstanceIndex` 三级分页索引**：把"行在页间拆分"建模成一等公民（未决行），避免分页逻辑里塞满特判。
4. **表达式下推改写**：`Total`→`row` + 列绑定集合，让聚合真正下推到数据集/DB 层。
5. **规则结构统一**：`RuleDesign` 一套结构服务 Highlight/Map/Hide/Sort。
6. **样式属性名完美哈希**：`PerfectHash` → Rust 侧可用 `phf` crate 编译期常量映射。
7. **多形态图片源 switch**：`IMAGE_URI/FILE/NAME/EXPRESSION` 四路分发 + `default` 统一报错并挂设计句柄 → `enum ImageSource` + 四个 handler。
8. **`.lck` 文件锁**：模板/文档独占读写的极简并发协议（建同名 `.lck` → 使用 → 删除）。需补超时与崩溃残留清理（本文未涉及）。
9. **模块间流水线调度**：本文用滑动窗口提速，落在我们更贴切的是**生成侧与发射侧之间用有界队列 + 序号 + 确认/超时重传解耦**，天然契合 Rust channel（背压=窗口，序号+ack=确认，超时重投=选择重传）。同进程管线建议先上有界 channel 背压，再按需加序号/重试。
10. **对象池与缓存**：`FastPool`、`CachedMetaData`（设计期缓存列元数据 `position/name/dataType`）、`CatchedImage`。
11. **插件化模块边界**：子系统各自独立插件/bundle。映射到三个子项目，即 `openprint`(Vue 设计器) / `designer-react`(设计器重写) / `print-server`(Rust 引擎) 之间**只通过 `rptdesign` 文本与 `rptdocument` 二进制交互**，避免语言/运行时耦合。
12. **错误定位惯例**：异常绑定模板节点句柄 + 结构化错误码常量（`EngineConstants`/`MessageConstants`），精确回显到设计器的具体单元格/元素。

### 9.3 不建议照搬

- **javascript 作为表达式/脚本语言**并"转化为 java 程序"：Vue 设计器 + Rust 引擎下应改为自研小型表达式 AST（或 WASM 沙箱），否则背负 JS 运行时与跨语言一致性成本。
- **XSL-FO + FOP** 出 PDF：排版控制力弱、链路长；建议自研布局后直出 PDF。
- 论文**实测方法偏弱**（8 个样本点、无方差/多次运行、仅测总耗时），−22% 只能作定性参考，不能当性能预算依据。

---

附：主要 OCR 勘误——`引攀/引繁/引毫`→引擎；`Ick`→`.lck`；`ReportitemExecutor`→`ReportItemExecutor`；`Exector`→`executor`；`HodelDteApiAdapter`→`ModelOdaApiAdapter`；`Matmx`→`Matrix`；`ScmptDataSet/ScrptLib`→`Script*`/`ScriptLib`；`Prsentation`→`presentation`；`UnresofvedRowHint`→`UnresolvedRowHint`；`IMAGE_FLLE/IMAGE_UNI`→`IMAGE_FILE/IMAGE_URI`；`西岛招工大学`→西安理工大学。
