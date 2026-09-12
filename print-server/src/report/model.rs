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
    /// 列主格位置名
    pub col_parent: Option<String>,
    /// 列向定位：本单元格排在目标 pos 所占列区间**之后**。
    ///
    /// 用于「行合计」这类列数随数据变化的单元格——它不能写死模板列号，
    /// 否则会被列展开出来的列覆盖。
    pub col_after: Option<String>,
    /// 求值表达式，如 `D3[B3:+0].sum()`
    pub value_expr: Option<String>,
    /// 展开表达式（P1 支持：数据集名 / 数组字面量）
    pub expand_expr: Option<String>,
    /// 数值显示格式（缺省走全局兜底）；小计 / 合计格应与它所在数值列保持一致
    pub format: Option<NumFmt>,
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
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RowTpl {
    pub cells: Vec<CellTpl>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SheetTpl {
    pub name: String,
    pub rows: Vec<RowTpl>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReportTemplate {
    pub sheets: Vec<SheetTpl>,
    /// 随模板一起提交的数据集；也可由服务端按数据源现查
    pub datasets: BTreeMap<String, DataSet>,
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
    /// 该实例覆盖的数据集行索引（受祖先分组约束）
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
}

impl CellInst {
    pub fn new(pos: String, tpl_row: usize, tpl_col: usize, parent: Option<usize>, expand_index: usize) -> Self {
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
            rows: Vec::new(),
            field: None,
            agg: None,
            expand_value: JsonValue::Null,
            value: JsonValue::Null,
            value_expr: None,
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
