//! 网格报表模板模型（NopReport xpt 的 JSON 等价物）
//!
//! 设计要点与 NopReport 对齐：
//! - 单元格通过 `row_parent` / `col_parent` 声明主格（父子）关系，构成主格树
//! - `expand_type = r` 表示纵向展开；配合 `ds` + `field` 时按字段自动分组去重
//! - 展开与求值分两阶段：先得到 expand_value，再执行 value_expr（可用层次坐标）

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

/// 一行数据：字段名 -> 值
pub type DataRow = BTreeMap<String, JsonValue>;
/// 数据集：命名的数据行集合
pub type DataSet = Vec<DataRow>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpandType {
    /// 纵向（行）展开
    R,
    /// 横向（列）展开
    C,
}

/// 交叉表数值格的聚合方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AggType {
    Sum,
    Count,
    Avg,
    Min,
    Max,
}

/// 数值显示格式（按格 / 按列）。
///
/// 与设计器控件的 `CellFormat` 同形（kind/digits/thousands/code），便于两端对齐；
/// 缺省（None）走全局兜底：整数带千分位、非整数两位小数。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct NumFmt {
    /// 格式种类：`text` | `int` | `decimal` | `currency` | `percent`
    pub kind: String,
    /// 小数位数；`int` 默认 0，`decimal` / `currency` / `percent` 默认 2
    pub digits: Option<usize>,
    /// 是否千分位；`int` / `decimal` / `currency` 默认 true
    pub thousands: Option<bool>,
    /// 货币代码（`kind=currency` 时用），默认 CNY
    pub code: Option<String>,
}

/// 水平对齐
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HAlign {
    Left,
    Center,
    Right,
}

/// 垂直对齐
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VAlign {
    Top,
    Middle,
    Bottom,
}

/// 格子样式 —— **作者定义的**，不是设计器那套语义高亮
///
/// 刻意**不含边框**：Univer 的 `bd` 实测完全不渲染，作者设了在设计器里看不见，
/// 那就成了「设了没反应」的静默失败。宁可不给，也不给一个看不见的开关。
/// （同理也不给下划线：`ul` 会画但永远用字色，写了 `c:0` 也改不了。）
///
/// 颜色统一 `#RRGGBB`。只认这一种写法，不猜 `rgb()` / 颜色名 —— 猜错了是静默的。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct CellStyle {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    /// 字号，单位 pt
    pub font_size: Option<f64>,
    /// 字色，`#RRGGBB`
    pub color: Option<String>,
    /// 底色，`#RRGGBB`
    pub bg: Option<String>,
    pub h_align: Option<HAlign>,
    pub v_align: Option<VAlign>,
}

impl CellStyle {
    /// 全空（等于没设样式）
    pub fn is_empty(&self) -> bool {
        *self == CellStyle::default()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellModel {
    /// 数据集名
    pub ds: Option<String>,
    /// 绑定字段
    pub field: Option<String>,
    /// 聚合方式。交叉表的数值格必须聚合：行分组与列分组的交集里往往有多行数据
    /// （如「华东 × 1月」下有 3 个销售员），只取首行会漏数。缺省行为仍是取首行。
    pub agg: Option<AggType>,
    /// 展开方向
    pub expand_type: Option<ExpandType>,
    /// 行主格（父格）位置名，如 "A3"
    pub row_parent: Option<String>,
    /// 跨数据集关联键：本格的数据集用这个字段去**匹配父格当前行的同名字段值**。
    ///
    /// 父子格在不同数据集时（一个 sheet 可以有多个数据集，每个数据源一条 SQL），
    /// 光靠行下标对不上号，必须有个键。例：订单(ds1) 下挂客户(ds2)，
    /// 本格写 `ds: "ds2"` + `join_on: "customer_id"`，就取 ds2 里
    /// `customer_id == 父行.customer_id` 的行。
    ///
    /// 不写就是没有关联依据 —— 会**告警并出空**，绝不按行号硬凑
    /// （硬凑出来的是看着正常、其实错的数据，比出空危险得多）。
    pub join_on: Option<String>,
    /// 列主格位置名
    pub col_parent: Option<String>,
    /// 列向定位：本单元格排在目标 pos 所占列区间**之后**。
    ///
    /// 用于「行合计」这类列数随数据变化的单元格——它不能写死模板列号，
    /// 否则会被列展开出来的列覆盖。
    pub col_after: Option<String>,
    /// 求值表达式，如 `D3[B3:+0].sum()`
    pub value_expr: Option<String>,
    /// 固定列表展开：展开集由**常量数组字面量**写死，不再由数据分组决定，
    /// 如 `["1月","2月","3月"]`。
    ///
    /// 与「按字段分组」的两处关键差异（就是它存在的理由）：
    /// 1. **顺序按字面量走**，不按数据出现顺序 —— 科目顺序既不是字母序也不是数据序；
    /// 2. 数据里**没有的项照样展开出来**（值格留空），也就是「月份补全」。
    ///
    /// 展开期求值，此时层次坐标尚未建立，所以只接受常量；写坏了进告警，不静默当空。
    /// 写了它则优先于 `field`，且不再要求 `ds` / `field`（见 `validateTemplate`）。
    ///
    /// 注：上游文档里它还支持「数据集名」，我们不支持——一个 sheet 可以挂多个
    /// 数据集（`Engine::new_multi`），但**展开集**只由 `field` / `expand_expr`
    /// 决定，没有「按数据集名再筛一层」这个口径。
    pub expand_expr: Option<String>,
    /// 展开条数下限：不足时补空值（「默认留 N 个空行」）
    pub expand_min_count: Option<usize>,
    /// 展开条数上限：超过的丢弃（「只显示前 N 条」）
    pub expand_max_count: Option<usize>,
    /// 展开集为空时保留该格（值为 null）；缺省会连同子格一起删除
    pub keep_expand_empty: Option<bool>,
    /// 数值显示格式（缺省走全局兜底）；小计 / 合计格应与它所在数值列保持一致
    pub format: Option<NumFmt>,
    /// 展示期表达式（第三值阶段）。可用 `value` 指代本格的值，如
    /// `IF(value >= 1000, "大额", "小额")`；也可引用其他格。
    /// 结果只影响展示文本，不影响 `value` —— 导出 xlsx 时数字格仍写原值。
    pub format_expr: Option<String>,
    /// 字典翻译：原始值文本 → 展示文本，如 `{"1": "是", "0": "否"}`。
    /// 键取**未套数字格式**的原始文本；命中不了就回落到 `format` / 全局兜底。
    pub dict: Option<BTreeMap<String, String>>,
    /// 行测试表达式：返回假则**整行删除**（本格连同子树一起不占位）。
    /// 用于「小计为 0 的分组不显示」这类按结果过滤，WHERE 里做不到的场景。
    pub row_test_expr: Option<String>,
    /// 列测试表达式：返回假则整列删除
    pub col_test_expr: Option<String>,
    /// 导出 xlsx 时把 `value_expr` 翻译成 Excel 公式（而非写死算好的值）。
    ///
    /// 好处是导出后在 Excel 里改明细，小计 / 合计会跟着重算。
    /// 只在该格有 `value_expr`、且表达式能翻译时生效（见 `Engine::excel_formula`），
    /// 翻不出来就回落写值并告警——静态值不会算错，静默丢公式才难查。
    pub export_formula: Option<bool>,
    /// 作者定义的格子样式（粗体 / 斜体 / 字号 / 字色 / 底色 / 对齐）。
    ///
    /// 这是**唯一**能导出到 xlsx 的样式来源。设计器网格里那些颜色是语义高亮
    /// （扩展黄、字段蓝…），标的是「这格什么角色」，不会进这里，也不会导出。
    pub style: Option<CellStyle>,
    /// 把这格画成图片（logo / 产品图 / 二维码 / 客户端栅格化好的图表）。
    pub image: Option<CellImage>,
}

/// 图片格：这格不出文本，出图片。
///
/// ## 为什么只收 data URI
///
/// `src` 只认 `data:image/...;base64,...`（自包含），**故意不做文件路径**。
/// 服务端按模板里的字符串读本地文件 = 模板变成一个任意文件读取原语
/// （`../../.ssh/id_rsa` 这种），而模板是可以被导入 / 分享的。少一条通路少一类洞。
///
/// 真要用本地图片，让设计器把它转成 data URI 再存进模板 —— 画布侧的图片控件
/// 本来就有 `inline` 模式。
///
/// ## 为什么客户端栅格化是对的
///
/// 图表（`chartkit`）是前端画的。与其在 Rust 里再实现一遍折线 / 柱状，
/// 不如让客户端把图表转成 PNG 的 data URI 塞进图片格 —— 服务端只管嵌字节。
/// 这也正是「图表进服务端报表」缺的那一半。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellImage {
    /// 来源：`literal`（缺省，`src` 就是图片本身）/ `value`（取本格算出来的值当 `src`）。
    ///
    /// `value` 是为了「一列产品图」这种场景：`field: photo` + `image.from: value`，
    /// 每行的 data URI 从数据里来。
    pub from: Option<String>,
    /// `data:image/...;base64,...`
    pub src: String,
}

impl CellImage {
    /// 是否「取本格的值当图片源」
    pub fn from_value(&self) -> bool {
        matches!(
            self.from.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref(),
            Some("value")
        )
    }
}

/// 解析 `data:image/<subtype>;base64,<payload>` → `(mime, 字节)`。
///
/// 认不出来一律**报错**（带着原文片段），不静默当空图 —— 空图在小票 / Excel 里
/// 就是一块白，看不出是「没配」还是「配错了」。
///
/// 只认 xlsx 真能嵌的四种（PNG / JPEG / GIF / BMP，见 `rust_xlsxwriter` 的
/// `process_image`）。**webp / svg 明确拒绝**：rust_xlsxwriter 会静默把 webp
/// 转成 PNG 且不支持 svg，让它自己失败不如在这里说清楚。
pub fn parse_image_data_uri(src: &str) -> Result<(&'static str, Vec<u8>), String> {
    let s = src.trim();
    let Some(rest) = s.strip_prefix("data:") else {
        return Err(format!(
            "图片源不是 data URI（要求 `data:image/png;base64,...`），实际开头是「{}」",
            s.chars().take(24).collect::<String>()
        ));
    };
    let Some((meta, payload)) = rest.split_once(',') else {
        return Err("图片源 data URI 里没有逗号，取不到载荷".to_string());
    };
    let meta_lower = meta.to_ascii_lowercase();
    if !meta_lower.ends_with(";base64") {
        return Err(format!(
            "图片源要求 base64 编码（`data:image/png;base64,`），实际元信息是「{meta}」"
        ));
    }
    let mime = meta_lower.trim_end_matches(";base64").trim();
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpeg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        other => {
            return Err(format!(
                "图片类型「{other}」不支持（只支持 png / jpeg / gif / bmp）"
            ))
        }
    };
    let bytes = crate::util::decode_base64_lenient(payload)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("图片载荷解出来是 0 字节".to_string());
    }
    Ok((ext, bytes))
}

impl CellModel {
    pub fn is_row_expand(&self) -> bool {
        matches!(self.expand_type, Some(ExpandType::R))
    }
    pub fn is_col_expand(&self) -> bool {
        matches!(self.expand_type, Some(ExpandType::C))
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellTpl {
    /// 位置名，如 "A3"；缺省时按行列自动推导
    pub pos: Option<String>,
    /// 静态值
    pub value: Option<JsonValue>,
    pub model: Option<CellModel>,
    /// 向右合并列数（merge_across + 1 == colspan）
    pub merge_across: usize,
    /// 向下合并行数（merge_down + 1 == rowspan）。
    ///
    /// 多级列表头的「行字段表头」「合计表头」要纵向跨过所有列头行，否则
    /// 表头块会出现半空的行（NopReport 用 rowspan 表达同一件事）。
    pub merge_down: usize,
    /// 横向合并到本行末尾（colspan = 总列数 - 起始列）。
    ///
    /// 列数随数据变化时标题无法写死合并宽度，只能声明「铺到行尾」。
    pub merge_to_end: bool,
    /// 把这格画成图片。放在 `CellTpl` 上是为了让**静态图片**（logo / 二维码）
    /// 不必为了一个 data URI 去建 `CellModel`。
    pub image: Option<CellImage>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RowTpl {
    pub cells: Vec<CellTpl>,
}

/// 分页配置（页面级：按数据行数切页，表头/表尾每页重复）
///
/// 只解决「打印时按固定行数分页」这一层，不引入润乾那套完整的 9 类带区模型。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PageConfig {
    /// 每页容纳的**数据**行数（不含重复的表头/表尾）
    pub rows_per_page: usize,
    /// 每页顶部重复的模板行数（表头）
    pub repeat_header_rows: usize,
    /// 每页底部重复的模板行数（表尾 / 签字栏等）
    pub repeat_footer_rows: usize,
}

impl PageConfig {
    /// 表头 + 表尾已经吃掉整张表时无法分页
    pub fn is_effective(&self, total_rows: usize) -> bool {
        self.rows_per_page > 0 && total_rows > self.repeat_header_rows + self.repeat_footer_rows
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SheetTpl {
    pub name: String,
    pub rows: Vec<RowTpl>,
    /// 分页配置；缺省不分页
    pub page: Option<PageConfig>,
    /// 循环变量：按该字段的**不同取值**把本 sheet 复制成 N 张，每值一张，
    /// 每张只看到属于该值的那些行 —— 即「一个客户一张表 / 一个部门一张表」。
    ///
    /// 生成的 sheet 名是 `{name} - {取值}`。取值按在数据里**首次出现**的顺序排列。
    /// 字段在数据集中不存在时告警并退回单张表（不静默出空表）。
    pub loop_field: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReportTemplate {
    pub sheets: Vec<SheetTpl>,
    /// 随模板一起提交的数据集；也可由服务端按数据源现查
    pub datasets: BTreeMap<String, DataSet>,
}

impl ReportTemplate {
    /// 表头行数：从第一行起，连续「既没有纵向展开格、也没有主格」的行。
    ///
    /// 与 TS 侧 `headerRowCount`（`openprint/src/report/grid-report.ts`）**同一套判据**，
    /// 逐条对齐了空值语义（`row_parent: ""` 也算没主格、`model` 缺省整格算表头）。
    /// 两边必须一致：预览按它决定前几行画成表头，xlsx 导出按它决定前几行用
    /// 表头样式 + 打印时跨页重复。曾经导出侧写死 1，于是「预览 2 行表头、
    /// 导出只有标题行」，打印时列头不跨页重复。
    ///
    /// 生成器产出的模板第一行是标题（如「city · amount 汇总」，整行合并），
    /// 第二行才是列头 —— 典型值 **2**；双指标交叉表多一层指标子表头，是 **3**。
    pub fn header_row_count(&self) -> usize {
        let Some(sheet) = self.sheets.first() else {
            return 0;
        };
        sheet
            .rows
            .iter()
            .take_while(|r| {
                r.cells.iter().all(|c| {
                    let Some(m) = c.model.as_ref() else {
                        return true;
                    };
                    m.expand_type != Some(ExpandType::R) && m.row_parent.as_deref().unwrap_or("").is_empty()
                })
            })
            .count()
    }
}

/// 展开后的一个单元格实例
#[derive(Debug, Clone)]
pub struct CellInst {
    /// 模板位置名
    pub pos: String,
    pub tpl_row: usize,
    pub tpl_col: usize,
    /// 行主格实例下标
    pub parent: Option<usize>,
    /// 列主格实例下标
    pub col_parent: Option<usize>,
    /// 列向定位目标 pos（见 CellModel::col_after）
    pub col_after: Option<String>,
    /// 子实例下标（按 tpl_row、tpl_col 排序）
    pub children: Vec<usize>,
    /// 列向子实例（以 col_parent 为边的列主格树）
    pub col_children: Vec<usize>,
    /// 该单元格是横向（列）展开格
    pub col_expand: bool,
    /// 本实例读的是哪个数据集（`rows` 是**这个**数据集的行下标）。
    ///
    /// 一个 sheet 可以有多个数据集（每个数据源一条 SQL），所以光有行下标不够，
    /// 必须记住下标属于哪一份。同数据集的父子沿用原来的「视图求交」；
    /// 跨数据集的父子走 `CellModel::join_on`。
    pub ds: String,
    /// 该实例覆盖的数据集行索引（受祖先分组约束），下标属于上面的 `ds`
    pub rows: Vec<usize>,
    /// 绑定字段（聚合求值用）
    pub field: Option<String>,
    /// 聚合方式（交叉表数值格用，见 CellModel::agg）
    pub agg: Option<AggType>,
    /// 展开值
    pub expand_value: JsonValue,
    /// 最终显示值
    pub value: JsonValue,
    /// 求值表达式（层次坐标聚合），如 `D3[B3:+0].sum()`
    pub value_expr: Option<String>,
    /// 本实例的 value 已求值完成（惰性求值 + 依赖传播：被引用的格会先被求值）
    pub evaluated: bool,
    /// 求值进行中。再次进入说明表达式成环，此时放弃求值以避免无限递归
    pub evaluating: bool,
    /// 成环告警已发过。一次展开里同一格可能被反复撞上，只报一次
    pub cycle_warned: bool,
    /// 在本层父格下的序号（从 0 开始）
    pub expand_index: usize,
    /// 后代实例：位置名 -> 实例下标（向祖格链逐级注册，跨层汇总的前提）
    pub descendants: BTreeMap<String, Vec<usize>>,
    /// 布局结果
    pub row_start: usize,
    pub row_span: usize,
    pub col_start: usize,
    pub col_span: usize,
    pub merge_across: usize,
    /// 向下合并行数（见 CellTpl::merge_down）
    pub merge_down: usize,
    /// 横向铺到行尾（见 CellTpl::merge_to_end）
    pub merge_to_end: bool,
    /// 数值显示格式（见 CellModel::format）
    pub format: Option<NumFmt>,
    /// 展示期表达式（见 CellModel::format_expr）
    pub format_expr: Option<String>,
    /// 字典翻译（见 CellModel::dict）
    pub dict: Option<BTreeMap<String, String>>,
    /// 行测试表达式（见 CellModel::row_test_expr）
    pub row_test_expr: Option<String>,
    /// 列测试表达式（见 CellModel::col_test_expr）
    pub col_test_expr: Option<String>,
    /// 作者定义的样式，原样带到输出格（见 CellModel::style）
    pub style: Option<CellStyle>,
    /// 图片格声明，原样带到输出格（见 CellModel::image）
    pub image: Option<CellImage>,
    /// 导出 xlsx 时写公式而不是值（见 CellModel::export_formula）
    pub export_formula: bool,
    /// 自身行测试的结果（`row_test_expr`）
    pub row_test_passed: bool,
    /// 自身列测试的结果（`col_test_expr`）
    pub col_test_passed: bool,
    /// 传递后的「已删除」：自身测试没过，或行 / 列主格里有一个被删。
    ///
    /// 与 `dropped` 的区别：`dropped` 是**布局**结果（没落位就是被删），
    /// 这里记录的是**语义**上的删除，要在求值阶段就用上——否则被 row_test
    /// 藏起来的行仍会被 `C2.sum()` 算进合计，出现「明细 1000、合计 1500」。
    pub hidden: bool,
    /// 已被测试表达式删除（或随被删的父格一起消失），不参与出表。
    ///
    /// 缺省为 true，由 `place()` 落位时置 false —— 这样「从未被布局访问到的实例」
    /// 天然就是被删掉的，不必再单独遍历子树去标记。
    pub dropped: bool,
}

impl CellInst {
    pub fn new(
        pos: String,
        tpl_row: usize,
        tpl_col: usize,
        parent: Option<usize>,
        expand_index: usize,
        ds: String,
    ) -> Self {
        CellInst {
            pos,
            tpl_row,
            tpl_col,
            parent,
            col_parent: None,
            col_after: None,
            children: Vec::new(),
            col_children: Vec::new(),
            col_expand: false,
            ds,
            rows: Vec::new(),
            field: None,
            agg: None,
            expand_value: JsonValue::Null,
            value: JsonValue::Null,
            value_expr: None,
            evaluated: false,
            evaluating: false,
            cycle_warned: false,
            expand_index,
            descendants: BTreeMap::new(),
            row_start: 0,
            row_span: 1,
            col_start: 0,
            col_span: 1,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: false,
            style: None,
            image: None,
            row_test_passed: true,
            col_test_passed: true,
            hidden: false,
            dropped: true,
        }
    }
}

/// 输出用的单元格
#[derive(Debug, Clone, Serialize)]
pub struct GridCell {
    pub text: String,
    pub pos: String,
    pub rowspan: usize,
    pub colspan: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_number: Option<f64>,
    /// Excel 数字格式串（由 NumFmt 推导）；xlsx 导出时套到数值格上
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_format: Option<String>,
    /// Excel 公式（仅 `export_formula` 且表达式可翻译时非空）。
    /// xlsx 导出时用它替代静态值；HTML 预览仍用 `text`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    /// 作者定义的样式；`None` 表示该格没设样式，走导出器的默认外观。
    /// HTML 预览目前不用它（预览的配色是语义高亮，两套东西别混）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<CellStyle>,
    /// 图片格：**已解析**的 data URI。有值时这格出图片不出文本
    /// （`text` 降级成 alt 文本，给 HTML 的 `alt=` 和 CSV 用）。
    ///
    /// 只存 data URI 不存路径：预览（浏览器）、HTML 导出、xlsx 导出三边都能直接用，
    /// 且 HTML 天然自包含。代价是同一张图重复 N 行会在 JSON 里重复 N 份 ——
    /// 作者自己决定要不要每行内联图片。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// 展开结果
#[derive(Debug, Clone, Serialize)]
pub struct RenderedSheet {
    pub name: String,
    pub rows: Vec<Vec<GridCell>>,
}

pub(crate) fn col_name(idx: usize) -> String {
    let mut n = idx;
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    s
}

/// 由行列下标得到位置名，如 (0,2) -> "A3"
pub fn cell_pos(row: usize, col: usize) -> String {
    format!("{}{}", col_name(col), row + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 认出来的四种要和 `rust_xlsxwriter` 真能嵌的四种一致
    /// （它的 `XlsxImageType` 就是 Png/Jpg/Gif/Bmp）。
    #[test]
    fn image_data_uri_accepts_the_four_xlsx_formats() {
        let cases = [
            ("data:image/png;base64,aGVsbG8=", "png"),
            ("data:image/jpeg;base64,aGVsbG8=", "jpeg"),
            ("data:image/jpg;base64,aGVsbG8=", "jpeg"),
            ("data:image/gif;base64,aGVsbG8=", "gif"),
            ("data:image/bmp;base64,aGVsbG8=", "bmp"),
        ];
        for (src, want) in cases {
            let (ext, bytes) = parse_image_data_uri(src).unwrap_or_else(|e| panic!("{src} 应当认：{e}"));
            assert_eq!(ext, want, "{src} 的扩展名");
            assert_eq!(bytes, b"hello");
        }
    }

    /// 元信息大小写 / 前后空格都该认（前端拼 data URI 时大小写不统一）
    #[test]
    fn image_data_uri_meta_is_case_insensitive() {
        let (ext, _) = parse_image_data_uri("  data:IMAGE/PNG;BASE64,aGVsbG8=  ").unwrap();
        assert_eq!(ext, "png");
    }

    /// 不是 data URI 一律报错，且错误里要带**原文片段** ——
    /// 作者贴了个本地路径进来时，得一眼看出是「路径」而不是「图坏了」。
    #[test]
    fn non_data_uri_errors_and_quotes_the_prefix() {
        let err = parse_image_data_uri("/Users/me/logo.png").unwrap_err();
        assert!(err.contains("/Users/me/logo.png"), "错误里要带原文，实际：{err}");
        assert!(err.contains("data URI"), "错误里要说清要求，实际：{err}");
    }

    /// 只收 base64。别的编码（`utf8,` / 裸 `,`）要明确拒绝 ——
    /// 静默当 base64 解会得到一堆乱字节，写进 xlsx 就是「图裂」。
    #[test]
    fn image_data_uri_requires_base64() {
        let err = parse_image_data_uri("data:image/png,rawbytes").unwrap_err();
        assert!(err.contains("base64"), "实际：{err}");
    }

    /// webp / svg 明确拒绝：rust_xlsxwriter 会**静默**把 webp 转成 PNG、
    /// 而且完全不支持 svg。让它自己失败不如在这里说清楚是哪一种不支持。
    #[test]
    fn unsupported_image_types_are_named_in_the_error() {
        for (src, ty) in [("data:image/webp;base64,aGVsbG8=", "webp"), ("data:image/svg+xml;base64,aGVsbG8=", "svg")] {
            let err = parse_image_data_uri(src).unwrap_err();
            assert!(err.contains(ty), "{ty} 的错误里应点名类型，实际：{err}");
        }
    }

    /// 空载荷 / 没有逗号 / 解出来 0 字节都要报错，不能悄悄出一张空图
    #[test]
    fn empty_or_malformed_payload_errors() {
        assert!(parse_image_data_uri("data:image/png;base64").is_err(), "没有逗号");
        assert!(parse_image_data_uri("data:image/png;base64,").is_err(), "0 字节");
        assert!(parse_image_data_uri("data:image/png;base64,!!!!").is_err(), "不是 base64");
    }

    #[test]
    fn image_from_value_is_recognised_case_insensitively() {
        let mk = |from: Option<&str>| CellImage { from: from.map(String::from), src: String::new() };
        assert!(mk(Some("value")).from_value());
        assert!(mk(Some(" VALUE ")).from_value());
        assert!(!mk(None).from_value());
        assert!(!mk(Some("")).from_value());
        assert!(!mk(Some("literal")).from_value(), "其它值都当字面图");
    }
}
