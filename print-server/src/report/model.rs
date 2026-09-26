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

    /// 逐字段覆盖：`over` 里**写了**的字段赢，没写的保持 `self` 原样。
    ///
    /// 为什么是「逐字段」而不是「整个替换」：条件格式通常只想改字色
    /// （`{color: "#FF0000"}`），整格替换会把作者设的粗体 / 对齐一起抹掉。
    ///
    /// 注意 `Some(false)` 是**有效覆盖**（显式取消加粗），不是「没写」——
    /// 导出侧 `with_style` 只在 `bold == Some(true)` 时才 `set_bold()`，
    /// 所以合并结果里留下 `bold: Some(false)` 正好等价于「不加粗」。
    pub fn merged_over(&self, over: &CellStyle) -> CellStyle {
        let mut out = self.clone();
        if over.bold.is_some() {
            out.bold = over.bold;
        }
        if over.italic.is_some() {
            out.italic = over.italic;
        }
        if over.font_size.is_some() {
            out.font_size = over.font_size;
        }
        if over.color.is_some() {
            out.color = over.color.clone();
        }
        if over.bg.is_some() {
            out.bg = over.bg.clone();
        }
        if over.h_align.is_some() {
            out.h_align = over.h_align;
        }
        if over.v_align.is_some() {
            out.v_align = over.v_align;
        }
        out
    }
}

/// 颜色字面量校验：只认 `#RRGGBB`。
///
/// **放在 `CellStyle` 旁边而不是各渲染器里**：xlsx 与 HTML 两边都要判它，
/// 各写一份迟早分叉（`graphic()` 那个优先级判据就是这么出过 bug 的）。
/// 不猜 `rgb()` / 颜色名 / `#RGB` 简写 —— 猜错了是静默的，作者会以为设的颜色生效了。
pub(crate) fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// 条件格式的比较方式。
///
/// 单独抽成 enum（而不是把字符串散在求值里）是为了让「有哪些写法」有一处**唯一的**
/// 白名单：`NAMES` 同时被解析、报错文案和 TS 镜像的 `CONDITION_OPS` 引用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CondOp {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    Ne,
    Between,
    NotBetween,
}

impl CondOp {
    /// 规范写法（错误文案里列的就是这八个）
    pub const NAMES: [&'static str; 8] = [
        "gt",
        "ge",
        "lt",
        "le",
        "eq",
        "ne",
        "between",
        "not_between",
    ];

    /// 解析 `when`。**认不出来报错**，不静默当「永远不命中」——
    /// 那正是最难查的一类：规则看着配了，导出后什么都没变。
    ///
    /// 顺带认符号写法（`>` / `>=` / `<=` / `==` / `!=` / `<>`）：作者手写 JSON 时
    /// 十有八九写符号，报「不认识的比较方式 >」会让人以为不支持。
    /// 大小写与前后空格都容忍（同 `CellImage.from_value` 的口径）。
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let s = raw.unwrap_or("").trim().to_ascii_lowercase();
        Ok(match s.as_str() {
            "gt" | ">" => CondOp::Gt,
            "ge" | ">=" | "gte" => CondOp::Ge,
            "lt" | "<" => CondOp::Lt,
            "le" | "<=" | "lte" => CondOp::Le,
            "eq" | "==" | "=" => CondOp::Eq,
            "ne" | "!=" | "<>" => CondOp::Ne,
            "between" => CondOp::Between,
            "not_between" => CondOp::NotBetween,
            other => {
                return Err(format!(
                    "不认识的比较方式「{other}」（支持 {}）",
                    CondOp::NAMES.join(" / ")
                ))
            }
        })
    }

    /// `between` / `not_between` 才需要第二个值
    pub fn needs_second(self) -> bool {
        matches!(self, CondOp::Between | CondOp::NotBetween)
    }

    /// 规范名（告警文案用；`NAMES` 里的那一个）
    pub fn name(self) -> &'static str {
        match self {
            CondOp::Gt => "gt",
            CondOp::Ge => "ge",
            CondOp::Lt => "lt",
            CondOp::Le => "le",
            CondOp::Eq => "eq",
            CondOp::Ne => "ne",
            CondOp::Between => "between",
            CondOp::NotBetween => "not_between",
        }
    }

    /// 命中判定。`b` 只有 `between` / `not_between` 会用到。
    ///
    /// 约定（**必须写死在注释里**，否则「含不含端点」这种差异没人看得出来）：
    /// - `between`：**闭区间** `a <= x <= b`；`not_between` 是它的取反（开区间）。
    /// - `eq` / `ne` 是**浮点精确相等**，不给容差 —— 悄悄加容差会变成
    ///   「1000 和 1000.0001 都算相等」，那是猜。要范围就用 `between`。
    pub fn test(self, x: f64, a: f64, b: f64) -> bool {
        match self {
            CondOp::Gt => x > a,
            CondOp::Ge => x >= a,
            CondOp::Lt => x < a,
            CondOp::Le => x <= a,
            CondOp::Eq => x == a,
            CondOp::Ne => x != a,
            CondOp::Between => x >= a && x <= b,
            CondOp::NotBetween => !(x >= a && x <= b),
        }
    }
}

/// 一条条件格式规则：**按本格算出来的数值**改样式（「数值超标标红」）。
///
/// ## 为什么样式是叠加而不是替换
///
/// `style` 是逐字段覆盖在 `CellModel.style` 之上的（见 `CellStyle::merged_over`），
/// 所以「底子有粗体、超标时再加红字」不用把粗体抄一遍。
///
/// ## 为什么没有边框
///
/// 与 `CellStyle` 同一个理由：Univer 的 `bd` 边框**实测完全不渲染**。
/// 条件格式最经典的用法恰恰是「超标加红框」——在这里必须换成底色 / 字色，
/// 否则作者设了框在设计器里什么都看不见（静默失败）。
///
/// ## 为什么 `when` 是 `String` 不是 enum
///
/// 与 `CellChart::kind` / `NumFmt::kind` 同一套约定：写成 enum 的话 serde 会在
/// **解析整份模板**时就失败，作者改错一个词整张表都出不来。用字符串则只坏这一条
/// 规则（进 `warnings`），表照常出。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct CellConditional {
    /// 比较方式：`gt` | `ge` | `lt` | `le` | `eq` | `ne` | `between` | `not_between`
    /// （也接受 `>` `>=` `<` `<=` `==` `!=` `<>`）。
    pub when: Option<String>,
    /// 比较值（`between` / `not_between` 时是下界）
    pub value: Option<f64>,
    /// 上界（含）。**只有 `between` / `not_between` 有意义**；
    /// 其它比较方式写了它会被忽略并告警（静默忽略 = 作者以为在按区间比）。
    pub value2: Option<f64>,
    /// 命中后逐字段覆盖到本格样式上的样式
    pub style: Option<CellStyle>,
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
    /// 把这格画成图片（logo / 产品图 / 二维码）。
    pub image: Option<CellImage>,
    /// 把这格画成图表（柱状 / 折线 / 饼图）。
    ///
    /// 与 `image` 是同一族「非文本格子」：这格不出文本，出图形。
    /// 区别在于图表的数据是**从别的格子算出来的**，所以要带一组模板坐标。
    pub chart: Option<CellChart>,
    /// 把这格画成条码 / 二维码（见 `CellBarcode`）。
    ///
    /// 与 `image` / `chart` 一样**两个槽都认**（`CellTpl` 和这里）：
    /// 挂在展开格上的「一列订单号条码」走的是 `CellModel` 这条路。
    pub barcode: Option<CellBarcode>,
    /// 条件格式：**按本格算出来的数值**改样式（「数值超标标红」）。
    ///
    /// 只放在 `CellModel` 上（不像 `image` / `chart` / `barcode` 那样两个槽都认）：
    /// 它比的是**本格算出来的数值**，而「算出来的值」只可能来自 `model`
    /// （`field` / `value_expr` / `agg`）—— 没有 model 就没有可比的数。
    /// 与同样只挂 `model` 的 `style` / `format` / `format_expr` 一致。
    ///
    /// ## 判定顺序：**自上而下，第一条命中的生效**（后面的不再看）
    ///
    /// 顺序是语义的一部分：`[{when:"gt",value:1000,style:红}, {when:"gt",value:100,style:黄}]`
    /// 与反过来写的结果完全不同。设计器里因此显示序号并支持上下移动。
    ///
    /// ## 只认数值
    ///
    /// 比较的是**格式化之前的原始数值**（`GridCell.raw_number` 那一份，
    /// 不是 `text` —— 后者已经套过 `1,234.50` / `12%` 之类的显示格式，拿它反解会算错）。
    /// 因此**空值 / 文本 / 布尔格一条规则都不会命中**：它们压根没有数值可比。
    /// 这是刻意选的语义，不是漏判 —— 「把文本硬解析成数字」会引入
    /// 「`-` 当 0 用」这类静默错误，而报表里空着和就是 0 是两回事。
    ///
    /// 规则本身写坏了（不认识的 `when` / 缺 `value` / `between` 缺 `value2` /
    /// 没有样式）**进 `warnings`**，绝不静默不生效。
    pub conditional: Option<Vec<CellConditional>>,
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

/// 条码格：这格不出文本，出条码 / 二维码。
///
/// ## 与 `image` / `chart` 的关系
///
/// 三个都是「非文本格子」，区别在**内容从哪来**：
/// - `image`：内容是一段 data URI（图是作者给的，服务端只管嵌）；
/// - `chart`：内容是**从别的格子算出来的**（读整列数据，一个声明画一份）；
/// - `barcode`：内容是**本格自己的文本**编码成的（`from: value` 时就是本格算出来的值）。
///
/// 所以条码在展开行里的行为跟**图片**一样：N 行出 N 个条码。
/// 这正是主场景 ——「一列订单号，每行一个条码」。图表那种「只画一份」的规矩
/// 在这里是**错的**：那会变成「N 行订单只有一个条码」。
///
/// ## 为什么内容默认是字面量而不是取本格值
///
/// 写死一个固定二维码（比如「扫码关注」）是很自然的用法，不必为它建 `CellModel`。
/// 要按数据走就写 `from: value`。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellBarcode {
    /// 来源：`literal`（缺省，`value` 就是内容）/ `value`（取本格算出来的值当内容）。
    ///
    /// `value` 是为了「一列订单号条码」这种场景：`field: order_no` + `barcode.from: value`，
    /// 每行的条码内容从数据里来。
    pub from: Option<String>,
    /// 要编码的原文（`from: value` 时忽略）
    pub value: String,
    /// 码制：`qr`（缺省）| `code128`。认不出来**只坏这一格**并告警，
    /// 所以用 `String` 而不是 enum —— 理由同 `CellChart::kind`。
    pub symbology: Option<String>,
    /// Code128 的 GS1-128 模式（起始符后插一个 FNC1）。非 Code128 时忽略。
    ///
    /// 显式开关而不是靠内容前缀猜：GS1 的载荷里看不出来「我要不要 FNC1」，
    /// 猜错了是**条码能扫但内容不对**，最难查。
    pub gs1: Option<bool>,
}

impl CellBarcode {
    /// 是否「取本格的值当条码内容」
    pub fn from_value(&self) -> bool {
        matches!(
            self.from.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref(),
            Some("value")
        )
    }
}

/// 解析完成的条码：位矩阵已经算好了。
///
/// 与 `CellBarcode` 的区别是「声明 vs 结果」，正如 `ResolvedChart` 之于 `CellChart`。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ResolvedBarcode {
    /// 已归一化的码制：`qr` | `code128`（小写）
    pub symbology: String,
    /// 位矩阵：每行一个字符串，`'1'` = 黑。**静区已含在内**，一维码已拉伸成面。
    ///
    /// 用字符串而不是 `Vec<Vec<bool>>`：后者每格序列化出来是 `true,` 五个字符，
    /// 而报表**每一行**都可能带条码，一张 65×65 的二维码就是 5 倍体积差。
    /// 附带好处是 JSON 里肉眼能看出这是个二维码。
    pub rows: Vec<String>,
    /// 原文（给 HTML 的 `alt` / Excel 的替代文字 / 排查用）
    pub text: String,
}

impl ResolvedBarcode {
    pub fn width(&self) -> usize {
        self.rows.first().map(|r| r.len()).unwrap_or(0)
    }

    pub fn height(&self) -> usize {
        self.rows.len()
    }

    pub fn is_dark(&self, row: usize, col: usize) -> bool {
        self.rows
            .get(row)
            .and_then(|r| r.as_bytes().get(col))
            .is_some_and(|b| *b == b'1')
    }

    /// 由编码器的位矩阵构造
    pub fn from_matrix(m: &crate::report::barcode::BarcodeMatrix, text: String) -> Self {
        ResolvedBarcode {
            symbology: String::new(), // 由调用方补（它才知道归一化后的码制名）
            rows: m.rows_as_strings(),
            text,
        }
    }
}

/// 一格**最终**该画成什么：三种「非文本格子」的优先级仲裁。
///
/// ## 为什么要有这个东西
///
/// 图片 / 图表 / 条码可以同时声明，而渲染时只能出一个。原先三个渲染端
/// （`to_html`、`decode_images`、`write_charts`）各自写了一遍优先级判断，
/// 于是必然会分叉：
/// - `to_html` 写了「图片 > 图表 > 文本」，条码加进来时得再想一遍；
/// - `decode_images` 只看图片和条码，`write_charts` 只看图表 →
///   **「图片 + 图表」的格子会在 Excel 里同时嵌一张图**和一张图表，
///   两个东西叠在同一格上（这是加条码时才发现的，之前一直存在）；
/// - 告警里说的优先级是第三份。
///
/// 本项目在「预览与导出两套口径」上吃过亏（表头行数那次，静默不一致），
/// 所以这里把它收成**一个判据**：引擎决定，渲染端只画。
#[derive(Debug)]
pub enum Graphic<'a> {
    Image(&'a str),
    Chart(&'a ResolvedChart),
    Barcode(&'a ResolvedBarcode),
    None,
}

impl GridCell {
    /// 这格该画什么。优先级：**图片 > 图表 > 条码 > 文本**。
    ///
    /// 三个渲染端都必须走这里，不许自己判 —— 各判各的就会出现
    /// 「告警说图片优先、导出里画的却是条码」这种查不出来的偏差。
    pub fn graphic(&self) -> Graphic<'_> {
        if let Some(src) = self.image.as_deref() {
            return Graphic::Image(src);
        }
        if let Some(ch) = self.chart.as_ref() {
            return Graphic::Chart(ch);
        }
        if let Some(bc) = self.barcode.as_ref() {
            return Graphic::Barcode(bc);
        }
        Graphic::None
    }
}

/// 图表格：这格不出文本，出一张图表（柱状 / 折线 / 饼图）。
///
/// ## 为什么数据来源写「模板位置名」而不是输出行列
///
/// 图表要画的是**展开之后**的数据（3 个地区 → 3 根柱子），而作者写模板时只知道
/// 模板坐标（`A3` = 地区列）。`GridCell.pos` 保留了模板坐标，所以
/// 「`A3` 展开成了哪几个输出格」是可以反查的 —— 图表因此能在**服务端**解析出
/// 真实数据。这一条是整个特性成立的前提：没有它就只能让前端把图栅格化成
/// PNG 再塞回来（那是 `image` 那条路，但那样导出到 xlsx 的是一张死图，
/// 在 Excel 里既不能改数据也不能换图型）。
///
/// ## 坐标怎么解析
///
/// 每个位置名解析成「所有 `pos` 等于它的输出格」，按 `(行, 列)` 排序：
/// - 纵向分组报表：`A3`（地区）→ 3 行；`B3`（金额）→ 同 3 行；
/// - 横向交叉表：`B2`（月份，横向展开）→ 3 列；`B3`（金额）→ 同 3 列。
/// 两种布局用**同一套机制**，因为排序后的顺序天然就是阅读顺序。
///
/// ## 数量对不上怎么办
///
/// 类目数与任一序列的点数必须**完全相等**，否则整张图不出，该格出
/// `[图表: 原因]` 并进 `warnings`。**不做截断、不做补零** —— 那两种都是
/// 「图看着是对的、数据是错的」，比不出图危险得多。
///
/// 这是最常见的作者错误：把类目指到了表头那种不展开的格子上（1 个 vs N 个）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellChart {
    /// 图表类型：`bar`（柱状）| `line`（折线）| `pie`（饼图）。
    ///
    /// 用 `String` 而不是 enum，是为了让**认不出来时只坏这一格**：写成 enum 的话
    /// serde 会在解析整个模板时就报错，作者改一个错字整张表都出不来。
    /// 与 `NumFmt::kind` 的处理方式一致。
    pub kind: Option<String>,
    /// 类目来源：模板位置名列表，如 `["A3"]`。取值格的 `text`（不是 `value`）。
    ///
    /// 留空则用序号 `1`、`2`… 当类目。
    pub categories: Vec<String>,
    /// 数据序列。`pie` 只用第一条（饼图只有一圈）。
    pub series: Vec<CellChartSeries>,
    /// 图表标题，画在顶部居中
    pub title: Option<String>,
}

/// 一条数据序列的**声明**（数值还没解析出来）
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CellChartSeries {
    /// 序列名（图例 / 饼图扇区名）。留空则回落用 `from` 那个位置名。
    pub name: Option<String>,
    /// 数值来源：模板位置名，如 `"B3"`。
    ///
    /// 取值优先用 `raw_number`（导出 xlsx 时写数字而不是文本），取不到再把
    /// `text` 解析成数字。两者都没有（空串 / `-` / 纯文字）就是**缺测**，
    /// 结果是 `null`（图上是个空档、xlsx 里是空格），**不补 0** ——
    /// 「空着」和「就是 0」在图上长得一样，在报表里是两回事。
    /// 交叉表里「某地区某月没有数据」是常态，所以缺测必须是一等公民而不是报错。
    pub from: String,
}

/// 解析完成的图表：类目与各序列数值都已经是**展开后的真实数据**。
///
/// 与 `CellChart` 的区别是「声明 vs 结果」，正如 `CellImage` 之于
/// `GridCell.image`（一个是模板里的 data URI 声明，一个是校验过的 data URI）。
///
/// **这是一份值快照，不是活引用**：分页把表切开之后，图表仍带着解析时的全量数据。
/// 对预览 / HTML 是想要的行为（图不该因为跨页就少一半柱子）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ResolvedChart {
    /// 已归一化的类型：`bar` | `line` | `pie`（小写）
    pub kind: String,
    pub categories: Vec<String>,
    pub series: Vec<ResolvedChartSeries>,
    pub title: Option<String>,
}

/// 解析完成的一条序列
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ResolvedChartSeries {
    /// 序列名（已回落：作者没写就用 `from`）
    pub name: String,
    /// 与 `ResolvedChart.categories` **等长**；缺测的位置是 `None`（序列化成 `null`）。
    pub data: Vec<Option<f64>>,
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
    /// 把这格画成图表。同样放在 `CellTpl` 上，让「一张固定图表」不必建 `CellModel`。
    pub chart: Option<CellChart>,
    /// 把这格画成条码 / 二维码。同样放在 `CellTpl` 上，让「一个固定二维码」不必建 `CellModel`。
    pub barcode: Option<CellBarcode>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RowTpl {
    pub cells: Vec<CellTpl>,
}

/// 页边距（四边，单位 mm）
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct PageMargins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// 不写 `margin_mm` 时**算页码落点**用的页边距 —— 取 Excel 的默认值（上下 0.75"、左右 0.7"）。
///
/// ⚠️ 它**不是「默认会印上去的页边距」**，只是一份布局假设：
/// 作者没写 `margin_mm` 时，HTML 不吐 `margin`、xlsx 不调 `set_margins`，
/// 两边都留给各自的默认（浏览器默认 / Excel 默认，本来就不一样，但**谁都没冒充作者做了选择**）。
/// 只有一处真的用到这个常量：页码要落在可印区底部，得知道上下边距占掉多少。
pub const DEFAULT_MARGINS: PageMargins = PageMargins {
    top: 19.05,
    right: 17.78,
    bottom: 19.05,
    left: 17.78,
};

/// 1 英寸 = 25.4 mm。xlsx 的 `set_margins` 只收英寸，HTML 侧全用 mm，
/// 换算是**功能的一部分**（差 25 倍，而且不报错）。
pub const MM_PER_INCH: f64 = 25.4;

/// 支持的纸张：`(名字, 宽 mm, 高 mm, Excel 纸张码)`，**一律按纵向记**。
///
/// 这是纸张尺寸的**唯一一份**表：HTML 的 `@page` 读前三项，xlsx 读第四项
/// （`set_paper_size` 收的是 Excel 的数字码，不是名字）。
/// 名字**大小写不敏感**（`a4` / `A4` 都认），但**不认「A4 横向」这种带修饰的写法** ——
/// 方向是单独的字段，猜错是静默的。
///
/// **为什么 B5 是 182×257 而不是 ISO 的 176×250**：B5 有两个互不相同的标准
/// —— ISO B5 = 176×250、JIS B5 = 182×257，而 Excel 的纸张码 13（界面上就写「B5」）
/// 是 **JIS** 那个。若按 ISO 的尺寸去配码 34（Excel 里叫「Envelope B5」），
/// 就会出现「HTML 按 176×250 排版、Excel 按 182×257 出纸」的静默不一致。
/// 所以取 JIS，与 Excel 同口径；ISO B5 本项目**不支持**（要用得先起个不冲突的名字）。
pub const PAPERS: &[(&str, f64, f64, u8)] = &[
    ("A3", 297.0, 420.0, 8),
    ("A4", 210.0, 297.0, 9),
    ("A5", 148.0, 210.0, 11),
    ("B5", 182.0, 257.0, 13),
    ("Letter", 215.9, 279.4, 1),
    ("Legal", 215.9, 355.6, 5),
];

/// 纸张名 → `(宽, 高)`，一律纵向。认不出返回 `None`（调用方负责报错点名）。
pub fn paper_mm(name: &str) -> Option<(f64, f64)> {
    PAPERS
        .iter()
        .find(|(n, _, _, _)| n.eq_ignore_ascii_case(name.trim()))
        .map(|(_, w, h, _)| (*w, *h))
}

/// 纸张名 → Excel 纸张码（`Worksheet::set_paper_size` 收的那个数字）。
///
/// 返回 `None` 只在「表里漏了码」时发生，正常路径上 `resolve_setup` 已经先验过名字，
/// 所以 `to_xlsx` 里那处 `None` 是**内部一致性**问题、不是用户输入问题。
pub fn paper_excel_id(name: &str) -> Option<u8> {
    PAPERS
        .iter()
        .find(|(n, _, _, _)| n.eq_ignore_ascii_case(name.trim()))
        .map(|(_, _, _, id)| *id)
}

/// 所有纸张名，用于错误文案（「认不出就报错」时得告诉作者有哪些）
pub fn paper_names() -> String {
    PAPERS.iter().map(|(n, _, _, _)| *n).collect::<Vec<_>>().join(" / ")
}

/// 分页配置 + 页面设置（页面级）
///
/// 两件事放一个结构体里，因为它们**只在同一个场合出现**（打印这张 sheet），
/// 而且拆成 `page` / `paper` 两个字段名会非常容易混。
///
/// - **分页**（`rows_per_page` / `repeat_*`）：只解决「按固定行数切页」这一层，
///   不引入润乾那套完整的 9 类带区模型。
/// - **页面设置**（`paper` / `orientation` / `margin_mm` / `page_number` /
///   `center_horizontally`）：**不影响网格内容**，只影响「印到纸上长什么样」。
///   `is_effective()` 只看分页那三个字段 —— 配了纸张但没配分页时，
///   分页逻辑照旧不启动（页面设置由 `resolve_setup()` 单独算）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PageConfig {
    // —— 分页 ——
    /// 每页容纳的**数据**行数（不含重复的表头/表尾）
    pub rows_per_page: usize,
    /// 每页顶部重复的模板行数（表头）
    pub repeat_header_rows: usize,
    /// 每页底部重复的模板行数（表尾 / 签字栏等）
    pub repeat_footer_rows: usize,

    // —— 页面设置 ——
    /// 纸张名（`A4` / `A3` / `A5` / `B5` / `Letter` / `Legal`，大小写不敏感）。
    /// 认不出来**报错**，不回落成默认纸张 —— 猜错纸张是静默的，打出来才发现。
    pub paper: Option<String>,
    /// `portrait`（纵向，默认）或 `landscape`（横向）
    pub orientation: Option<String>,
    /// 四边页边距；不写则用 `DEFAULT_MARGINS`（Excel 的默认值）
    pub margin_mm: Option<PageMargins>,
    /// 页码模板，如 `第 {page} / {pages} 页`。只认 `{page}` / `{pages}` 两个占位符，
    /// 认不出来**报错**。不写 = 不印页码。
    ///
    /// ⚠️ HTML 侧只在**报表自带分页**时印得出（那时服务端才知道一共几页）；
    /// xlsx 侧是 Excel 原生页脚，任何情况都能印。详见 `to_html` 的注释。
    pub page_number: Option<String>,
    /// 内容在纸面上水平居中（xlsx 的 `set_print_center_horizontally`；
    /// HTML 侧靠 `@page` 的等宽左右边距近似，见 `to_html`）
    pub center_horizontally: Option<bool>,
}

/// 解析并**校验过**的页面设置
///
/// 与 `ResolvedChart` / `ResolvedBarcode` 同一套做法：声明层全是 `Option`（作者可能只写一半），
/// 渲染前先解析成一份「确定的」值，认不出来的在这里报错。
/// 宽高**已按方向换过** —— 下游（HTML 的 `@page`、xlsx 的纸张码）都不用再想方向。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedPageSetup {
    /// 纸张名，保留作者写的大小写（回显 / 错误文案用）
    pub paper: Option<String>,
    /// 纸张宽（mm），已按方向换算
    pub width_mm: f64,
    /// 纸张高（mm），已按方向换算
    pub height_mm: f64,
    pub landscape: bool,
    /// **作者明写的**页边距。`None` = 没写 → 两个渲染端都不表态，各用各的默认。
    ///
    /// 刻意是 `Option` 而不是「没写就填 `DEFAULT_MARGINS`」：填了的话
    /// 「作者只配了页码」这种模板会连带把纸边距钉成 Excel 的值，
    /// 而作者从没这么要求过 —— 属于**替用户做决定**。
    pub margin_mm: Option<PageMargins>,
    pub page_number: Option<String>,
    pub center_horizontally: bool,
}

impl ResolvedPageSetup {
    /// 页码模板 → 具体文本。`page` / `pages` 都是 1 基。（HTML 侧用）
    pub fn page_number_text(&self, page: usize, pages: usize) -> Option<String> {
        self.page_number.as_ref().map(|tpl| {
            tpl.replace("{page}", &page.to_string())
                .replace("{pages}", &pages.to_string())
        })
    }

    /// 页码模板 → Excel 页脚码。`{page}` → `&P`，`{pages}` → `&N`。（xlsx 侧用）
    ///
    /// **字面量 `&` 必须先翻倍成 `&&`**（Excel 的约定：`&&` 才印出一个 `&`）。
    /// 顺序不能反 —— 先替换再转义的话，刚写进去的 `&P` 会被翻成 `&&P`，
    /// 于是页脚印出字面量「&P」而不是页码，而且**一点报错都没有**。
    pub fn page_number_excel_footer(&self) -> Option<String> {
        self.page_number.as_ref().map(|tpl| {
            tpl.replace('&', "&&")
                .replace("{page}", "&P")
                .replace("{pages}", "&N")
        })
    }
}

impl PageConfig {
    /// 表头 + 表尾已经吃掉整张表时无法分页
    pub fn is_effective(&self, total_rows: usize) -> bool {
        self.rows_per_page > 0 && total_rows > self.repeat_header_rows + self.repeat_footer_rows
    }

    /// 有没有配**页面设置**（与「分页」无关）。
    ///
    /// 单独一个判据是因为 `is_effective()` 只回答「要不要分页」——
    /// 只配了纸张、没配 `rows_per_page` 时，HTML 依然要吐 `@page`。
    pub fn has_setup(&self) -> bool {
        self.paper.is_some()
            || self.orientation.is_some()
            || self.margin_mm.is_some()
            || self.page_number.is_some()
            || self.center_horizontally.is_some()
    }

    /// 用 `other` 的三个**分页**字段覆盖自己，页面设置保持不动。
    ///
    /// 为什么单独开一个方法、而不是在调用点写结构体字面量：字面量会**静默漏掉**
    /// 将来新增的字段（漏掉 = 「新字段被 options 抹掉」），而 `..self.clone()`
    /// 让「没点名的一律继承自己」成为默认行为 —— 新字段天然走对。
    ///
    /// 真实场景：报表存盘时模板里带了 `paper: "A3"`，执行时 `ReportOptions` 只带了
    /// 分页三项。整份替换会让纸张**静默消失**（存盘文件里还在，跑出来没有）。
    pub fn with_pagination_of(&self, other: &PageConfig) -> PageConfig {
        PageConfig {
            rows_per_page: other.rows_per_page,
            repeat_header_rows: other.repeat_header_rows,
            repeat_footer_rows: other.repeat_footer_rows,
            ..self.clone()
        }
    }

    /// 解析 + 校验页面设置。没配任何一项时返回 `None`（调用方据此**不改变输出**）。
    pub fn resolve_setup(&self, sheet: &str) -> Result<Option<ResolvedPageSetup>, String> {
        if !self.has_setup() {
            return Ok(None);
        }
        let where_ = format!("sheet「{sheet}」的 page");

        let (mut w, mut h) = match self.paper.as_deref() {
            Some(name) => paper_mm(name).ok_or_else(|| {
                format!("{where_} 的 paper「{name}」认不出（支持 {}）", paper_names())
            })?,
            // 没写纸张但配了别的：用 A4 当基准（只为算方向与页边距合法性）
            None => paper_mm("A4").expect("A4 在表里"),
        };

        let landscape = match self.orientation.as_deref().map(str::trim) {
            None | Some("") | Some("portrait") => false,
            Some("landscape") => true,
            Some(other) => {
                return Err(format!(
                    "{where_} 的 orientation「{other}」认不出（只认 portrait / landscape）"
                ))
            }
        };
        if landscape {
            std::mem::swap(&mut w, &mut h);
        }

        // 作者没写页边距就**什么都不校验** —— 没写就没有「配错了」这回事，
        // 而且此时两端的默认值本来就不一样（浏览器 ≈10mm / Excel 19.05·17.78），
        // 拿 Excel 的值去判合法性等于替作者选了一套边距。
        let margin_mm = self.margin_mm;
        if let Some(m) = margin_mm {
            for (side, v) in [
                ("top", m.top),
                ("right", m.right),
                ("bottom", m.bottom),
                ("left", m.left),
            ] {
                if !v.is_finite() || v < 0.0 {
                    return Err(format!(
                        "{where_} 的 margin_mm.{side}「{v}」不合法（须是不小于 0 的数，单位 mm）"
                    ));
                }
            }
            // 页边距吃掉整张纸 → 印出来是一片空白，属于「配了但看不出」，当场报错
            if m.left + m.right >= w {
                return Err(format!(
                    "{where_} 的左右页边距合计 {:.2}mm 已经不小于纸宽 {w:.2}mm，印出来会是空白",
                    m.left + m.right
                ));
            }
            if m.top + m.bottom >= h {
                return Err(format!(
                    "{where_} 的上下页边距合计 {:.2}mm 已经不小于纸高 {h:.2}mm，印出来会是空白",
                    m.top + m.bottom
                ));
            }
        }

        if let Some(tpl) = self.page_number.as_deref() {
            validate_page_number_tpl(tpl, &where_)?;
        }

        Ok(Some(ResolvedPageSetup {
            paper: self.paper.as_deref().map(str::trim).map(str::to_string),
            width_mm: w,
            height_mm: h,
            landscape,
            margin_mm,
            page_number: self.page_number.clone(),
            center_horizontally: self.center_horizontally.unwrap_or(false),
        }))
    }
}

/// 页码模板只认 `{page}` / `{pages}`。
///
/// **认不出来的占位符报错、不原样留着**：留着的话印出来是 `第 {pge} / 3 页`，
/// 看着像「模板写对了但没替换」，比报错难查得多。
fn validate_page_number_tpl(tpl: &str, where_: &str) -> Result<(), String> {
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        let Some(close_rel) = rest[open..].find('}') else {
            return Err(format!("{where_} 的 page_number「{tpl}」里有一个 `{{` 没有闭合"));
        };
        let close = open + close_rel;
        let name = &rest[open + 1..close];
        if name != "page" && name != "pages" {
            return Err(format!(
                "{where_} 的 page_number「{tpl}」里有认不出的占位符「{{{name}}}」（只认 {{page}} 与 {{pages}}）"
            ));
        }
        rest = &rest[close + 1..];
    }

    // Excel 页脚上限按**字符**数（不是字节），且要算上 `&C` 这两个控制字符。
    // 用「已转义、未替换占位符」的长度当上界：`{page}`(6) → `&P`(2) 只会变短，
    // 而字面量 `&` → `&&` 只会变长，所以先转义再量是安全的保守估计。
    let escaped_len = tpl.chars().count() + tpl.matches('&').count();
    if escaped_len + 2 > 255 {
        return Err(format!(
            "{where_} 的 page_number 太长（{escaped_len} 字符）：Excel 页脚上限 255 字符，\
             超了会被静默丢掉（导出成功但页脚不见）"
        ));
    }
    Ok(())
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
    /// 图表格声明，原样带到输出格（见 CellModel::chart）。
    ///
    /// 注意与 `image` 的差别：`image` 在这一步就解析完了（校验 data URI），
    /// 而图表的**数值要等整个网格填完**才能解析（它读的是别的格子），
    /// 所以这里只是把声明带过去，真正的解析在 `expand_sheet` 末尾做。
    pub chart: Option<CellChart>,
    /// 条码格声明，原样带到输出格（见 `CellModel::barcode`）。
    ///
    /// 与 `chart` 不同、与 `image` 相同：条码的内容来自**本格自己**的文本，
    /// 不需要等整个网格填完，所以可以在这里就地解析。
    pub barcode: Option<CellBarcode>,
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
            chart: None,
            barcode: None,
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
    /// 图表格：**已解析**的图表（类目 + 各序列数值，数值已是展开后的真实数据）。
    ///
    /// 有值时这格出图表不出文本（`text` 降级成 alt / 失败原因）。
    /// 与 `image` 不同，这里存的是**算好的数**而不是一个引用：预览、HTML、
    /// xlsx 三边拿到的是同一份数据，不会各自再解析一遍坐标（那样迟早对不上）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart: Option<ResolvedChart>,
    /// 条码格：**已编码**的位矩阵（`'1'` = 黑，静区已含）。
    ///
    /// 有值时这格出条码不出文本（`text` 降级成 alt / 失败原因）。
    /// 与 `chart` 一样存**算好的结果**而不是声明：预览、HTML、xlsx
    /// 三边拿到的是同一份位矩阵，不会各自再编一遍（那样迟早对不上）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub barcode: Option<ResolvedBarcode>,
}

/// 展开结果
#[derive(Debug, Clone, Serialize)]
pub struct RenderedSheet {
    pub name: String,
    pub rows: Vec<Vec<GridCell>>,
    /// 这张 sheet 的页面设置（纸张 / 方向 / 页边距 / 页码），**已解析校验过**。
    ///
    /// 挂在 `RenderedSheet` 上而不是让渲染器回头读模板：分页时 `pages` 是 `paginate()`
    /// 切出来的**新** sheet，它们得跟着同一份设置走；渲染器（HTML / xlsx）只拿到
    /// `&[RenderedSheet]`，回头读模板就得把模板再传一遍，容易漏掉某条调用路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_setup: Option<ResolvedPageSetup>,
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

    // ---- 条件格式：比较方式 ----

    /// 八个规范名 + 符号写法都要认；大小写与空格容忍。
    /// **白名单只有这一处** —— 报错文案里的名单也来自 `CondOp::NAMES`。
    #[test]
    fn cond_op_parse_accepts_names_and_symbols() {
        let cases = [
            ("gt", CondOp::Gt),
            (">", CondOp::Gt),
            ("GE", CondOp::Ge),
            (">=", CondOp::Ge),
            ("<", CondOp::Lt),
            ("le", CondOp::Le),
            ("<=", CondOp::Le),
            ("eq", CondOp::Eq),
            ("==", CondOp::Eq),
            ("ne", CondOp::Ne),
            ("!=", CondOp::Ne),
            ("<>", CondOp::Ne),
            ("  between  ", CondOp::Between),
            ("not_between", CondOp::NotBetween),
        ];
        for (raw, want) in cases {
            assert_eq!(CondOp::parse(Some(raw)), Ok(want), "「{raw}」应当解析成 {want:?}");
        }
        assert_eq!(CondOp::NAMES.len(), 8, "规范名只有 8 个，加了要同步 TS 的 CONDITION_OPS");
    }

    /// 认不出来必须**报错**（而不是当成「永远不命中」）——
    /// 后者是「规则配了、导出后什么都没变」，最难查。报错文案要点名原值 + 支持列表。
    #[test]
    fn cond_op_parse_rejects_unknown_and_names_the_value() {
        for bad in ["bigger", "like", "", "gt2"] {
            let err = CondOp::parse(Some(bad)).unwrap_err();
            assert!(err.contains("between"), "报错要列出支持的方式：{err}");
            if !bad.is_empty() {
                assert!(err.contains(bad), "报错要点名原值 {bad:?}：{err}");
            }
        }
        assert!(CondOp::parse(None).is_err(), "没写 when 也算认不出来");
    }

    /// `between` 闭区间（含端点）；`not_between` 是取反。端点含不含在表上完全看不出来。
    #[test]
    fn cond_op_between_is_inclusive() {
        assert!(CondOp::Between.test(100.0, 100.0, 200.0), "下界含");
        assert!(CondOp::Between.test(200.0, 100.0, 200.0), "上界含");
        assert!(!CondOp::Between.test(99.9, 100.0, 200.0));
        assert!(!CondOp::NotBetween.test(100.0, 100.0, 200.0), "取反：端点在区间内 → 不命中");
        assert!(CondOp::NotBetween.test(250.0, 100.0, 200.0));
    }

    /// `eq` / `ne` 是**浮点精确相等**，不给容差。
    /// 悄悄加容差会变成「1000 和 1000.0001 都算相等」—— 那是猜，不是配。
    #[test]
    fn cond_op_eq_is_exact_without_tolerance() {
        assert!(CondOp::Eq.test(1000.0, 1000.0, 0.0));
        assert!(!CondOp::Eq.test(1000.0001, 1000.0, 0.0), "不给容差");
        assert!(CondOp::Ne.test(1000.0001, 1000.0, 0.0));
    }

    /// `needs_second` 决定要不要 value2 —— 编译期靠它判「between 缺上界」
    #[test]
    fn cond_op_needs_second_only_for_range_ops() {
        assert!(CondOp::Between.needs_second());
        assert!(CondOp::NotBetween.needs_second());
        for op in [CondOp::Gt, CondOp::Ge, CondOp::Lt, CondOp::Le, CondOp::Eq, CondOp::Ne] {
            assert!(!op.needs_second(), "{op:?} 不该要第二个值");
        }
    }

    // ---- 条件格式：样式叠加 ----

    /// 逐字段覆盖：`over` 写了字段的赢，没写的保持原样。
    /// 整格替换的现象是「超标标红了，作者设的粗体没了」—— 只看颜色看不出来。
    #[test]
    fn style_merged_over_overrides_only_the_fields_it_sets() {
        let base = CellStyle {
            bold: Some(true),
            italic: Some(true),
            font_size: Some(14.0),
            color: Some("#000000".into()),
            bg: Some("#EEEEEE".into()),
            h_align: Some(HAlign::Left),
            v_align: Some(VAlign::Top),
        };
        let over = CellStyle { color: Some("#FF0000".into()), ..Default::default() };
        let got = base.merged_over(&over);
        assert_eq!(got.color, Some("#FF0000".into()), "写了字色 → 覆盖");
        assert_eq!(got.bold, Some(true), "没写粗体 → 保持");
        assert_eq!(got.italic, Some(true));
        assert_eq!(got.font_size, Some(14.0));
        assert_eq!(got.bg, Some("#EEEEEE".into()));
        assert_eq!(got.h_align, Some(HAlign::Left));
        assert_eq!(got.v_align, Some(VAlign::Top));
    }

    /// `Some(false)` 是**有效覆盖**（显式取消），不是「没写」。
    ///
    /// 导出侧 `with_style` 只在 `bold == Some(true)` 时才 `set_bold()`，
    /// 所以留下 `bold: Some(false)` 正好等价于「不加粗」——
    /// 这条不成立的话「条件格式取消加粗」会变成静默无效。
    #[test]
    fn style_merged_over_treats_explicit_false_as_an_override() {
        let base = CellStyle { bold: Some(true), italic: Some(true), ..Default::default() };
        let over = CellStyle { bold: Some(false), ..Default::default() };
        let got = base.merged_over(&over);
        assert_eq!(got.bold, Some(false), "显式 false 要覆盖 true");
        assert_eq!(got.italic, Some(true), "没写的字段保持原样");
    }

    /* ------------------------------ 页面设置 ------------------------------ */

    /// 纸张表是「HTML 尺寸」与「Excel 纸张码」的**唯一对账点**，所以整张表钉死。
    ///
    /// 尤其是 B5：ISO B5 = 176×250、JIS B5 = 182×257，而 Excel 的纸张码 13
    ///（界面上就写「B5」）是 **JIS** 那个。有人「顺手改成 ISO 的尺寸」就会红 ——
    /// 那不是笔误而是口径变更，必须同时决定 xlsx 侧要不要换码
    ///（换 34 的话 Excel 打印对话框里会显示「Envelope B5」）。
    #[test]
    fn paper_table_is_pinned() {
        let expect: Vec<(&str, f64, f64, u8)> = vec![
            ("A3", 297.0, 420.0, 8),
            ("A4", 210.0, 297.0, 9),
            ("A5", 148.0, 210.0, 11),
            ("B5", 182.0, 257.0, 13),
            ("Letter", 215.9, 279.4, 1),
            ("Legal", 215.9, 355.6, 5),
        ];
        // 这条已经钉了**内容**（不只是数量）。原先的消息只点了两件事，漏了第三件：
        // TS 的 `PAPER_NAMES`（`openprint/src/report/grid-report.ts`，设计器下拉用它）。
        // 三处必须同步；`scripts/mirror-check.py` 会对账 Rust↔TS 那两份。
        assert_eq!(
            PAPERS.to_vec(),
            expect,
            "纸张表变了：① HTML 尺寸 ② Excel 纸张码 ③ TS 的 PAPER_NAMES（mirror-check.py 会红）三处都要同步"
        );
    }

    #[test]
    fn paper_lookup_is_case_insensitive_and_trims() {
        assert_eq!(paper_mm(" a4 "), Some((210.0, 297.0)));
        assert_eq!(paper_excel_id("A4"), Some(9));
        assert_eq!(paper_excel_id("a4"), Some(9));
        assert_eq!(paper_excel_id("A6"), None);
    }

    /// 没配任何页面设置 → `None`。**这是「不改变输出」的开关**：
    /// `render()` / `to_html` / `to_xlsx` 全靠它保持老行为（老模板逐字节不变）。
    #[test]
    fn resolve_setup_is_none_when_nothing_is_set() {
        assert!(PageConfig::default().resolve_setup("s").unwrap().is_none());
    }

    /// 只配分页、不配页面设置 → 也是 `None`（分页与页面设置是两件事）
    #[test]
    fn pagination_alone_does_not_produce_a_page_setup() {
        let cfg = PageConfig { rows_per_page: 10, repeat_header_rows: 2, ..Default::default() };
        assert!(cfg.is_effective(100));
        assert!(cfg.resolve_setup("s").unwrap().is_none());
    }

    /// **没写页边距时 `margin_mm` 必须是 `None`**，不能被填成 `DEFAULT_MARGINS`。
    ///
    /// 填了的话「作者只配了页码」会连带把纸边距钉成 Excel 的值 —— 作者从没要求过，
    /// 而 HTML 与 xlsx 会**一起**变成那个值，看起来还挺一致，没人会发现
    /// 这是替用户做的决定。
    #[test]
    fn resolve_setup_does_not_invent_margins() {
        let cfg = PageConfig { page_number: Some("第 {page} 页".into()), ..Default::default() };
        let got = cfg.resolve_setup("s").unwrap().unwrap();
        assert_eq!(got.margin_mm, None, "没写就是没写，不许拿默认值冒充作者的选择");

        let cfg2 = PageConfig {
            margin_mm: Some(PageMargins { top: 1.0, right: 2.0, bottom: 3.0, left: 4.0 }),
            ..Default::default()
        };
        let got2 = cfg2.resolve_setup("s").unwrap().unwrap();
        assert_eq!(got2.margin_mm.unwrap().left, 4.0, "写了就要原样带出来");
    }

    #[test]
    fn resolve_setup_swaps_dimensions_for_landscape() {
        let cfg = PageConfig {
            paper: Some("A4".into()),
            orientation: Some("landscape".into()),
            ..Default::default()
        };
        let got = cfg.resolve_setup("s").unwrap().unwrap();
        assert!(got.landscape);
        assert_eq!((got.width_mm, got.height_mm), (297.0, 210.0), "横向要换宽高");

        let p = PageConfig { paper: Some("A4".into()), ..Default::default() };
        let g = p.resolve_setup("s").unwrap().unwrap();
        assert!(!g.landscape, "不写方向 = 纵向");
        assert_eq!((g.width_mm, g.height_mm), (210.0, 297.0));
    }

    /// 纸张名写错**必须报错**，不许回落成默认纸张 —— 猜错纸张是静默的，打出来才发现。
    #[test]
    fn resolve_setup_rejects_unknown_paper() {
        let cfg = PageConfig { paper: Some("A6".into()), ..Default::default() };
        let e = cfg.resolve_setup("销售表").unwrap_err();
        assert!(e.contains("A6"), "要点名写错的纸张：{e}");
        assert!(e.contains("销售表"), "要点名是哪张 sheet：{e}");
        assert!(e.contains("A4"), "要列出支持哪些：{e}");
    }

    #[test]
    fn resolve_setup_rejects_unknown_orientation() {
        let cfg = PageConfig { orientation: Some("sideways".into()), ..Default::default() };
        let e = cfg.resolve_setup("s").unwrap_err();
        assert!(e.contains("sideways"), "{e}");
    }

    /// 页边距吃掉整张纸 → 印出来一片空白，属于「配了但看不出」，当场报错
    #[test]
    fn resolve_setup_rejects_margins_that_eat_the_paper() {
        let cfg = PageConfig {
            paper: Some("A4".into()),
            margin_mm: Some(PageMargins { left: 120.0, right: 120.0, ..Default::default() }),
            ..Default::default()
        };
        let e = cfg.resolve_setup("s").unwrap_err();
        assert!(e.contains("空白"), "{e}");

        let neg = PageConfig {
            margin_mm: Some(PageMargins { top: -1.0, ..Default::default() }),
            ..Default::default()
        };
        assert!(neg.resolve_setup("s").is_err(), "负边距不合法");
    }

    /// 页码模板：认不出的占位符报错，**不原样留着**
    ///（留着的话印出来是 `第 {pge} / 3 页`，看着像「替换没生效」，比报错难查得多）
    #[test]
    fn page_number_tpl_rejects_unknown_placeholder() {
        let cfg = PageConfig { page_number: Some("第 {pge} 页".into()), ..Default::default() };
        let e = cfg.resolve_setup("s").unwrap_err();
        assert!(e.contains("pge"), "{e}");
    }

    #[test]
    fn page_number_tpl_rejects_unclosed_brace() {
        let cfg = PageConfig { page_number: Some("第 {page 页".into()), ..Default::default() };
        assert!(cfg.resolve_setup("s").is_err());
    }

    /// 超长页码模板：`set_footer` 对 >255 字符是 **`eprintln!` 之后直接丢弃**，
    /// 导出照常成功、页脚却没有 —— 必须在这里拦下来。
    #[test]
    fn page_number_tpl_rejects_over_excel_footer_limit() {
        let long = "第 {page} 页".to_string() + &"啊".repeat(250);
        let cfg = PageConfig { page_number: Some(long), ..Default::default() };
        let e = cfg.resolve_setup("s").unwrap_err();
        assert!(e.contains("255"), "要说明是 Excel 的长度上限：{e}");

        // 边界：正好 255（253 + `&C` 两个控制字符）应当放行
        let ok = PageConfig { page_number: Some("x".repeat(253)), ..Default::default() };
        assert!(ok.resolve_setup("s").is_ok(), "253+2=255 是上限内");
    }

    /// `{page}` / `{pages}` → Excel 页脚码，**字面量 `&` 要先翻倍**。
    ///
    /// 顺序反了就会把刚写进去的 `&P` 再翻成 `&&P`，页脚印出字面量「&P」——
    /// 没有报错、导出成功，只是页码变成了乱码。
    #[test]
    fn excel_footer_escapes_literal_ampersand_before_substituting() {
        let cfg = PageConfig {
            page_number: Some("A&B 第 {page}/{pages} 页".into()),
            ..Default::default()
        };
        let got = cfg.resolve_setup("s").unwrap().unwrap();
        assert_eq!(got.page_number_excel_footer().unwrap(), "A&&B 第 &P/&N 页");
    }

    #[test]
    fn excel_footer_substitutes_both_placeholders() {
        let cfg = PageConfig { page_number: Some("{page} / {pages}".into()), ..Default::default() };
        let got = cfg.resolve_setup("s").unwrap().unwrap();
        assert_eq!(got.page_number_excel_footer().unwrap(), "&P / &N");
        // HTML 侧换的是真实数字（1 基）
        assert_eq!(got.page_number_text(2, 7).unwrap(), "2 / 7");
    }

    /// **`options` 只该覆盖分页三项，不能把模板里的页面设置抹掉。**
    ///
    /// 这是实现时踩到的真坑：`apply_options` 原来整份替换 `PageConfig`，
    /// 于是「存盘文件里 `paper: "A3"` 还在、跑出来却是默认纸」—— 静默丢数据。
    #[test]
    fn with_pagination_of_keeps_the_page_setup() {
        let saved = PageConfig {
            rows_per_page: 10,
            repeat_header_rows: 2,
            repeat_footer_rows: 1,
            paper: Some("A3".into()),
            orientation: Some("landscape".into()),
            margin_mm: Some(PageMargins { top: 5.0, right: 5.0, bottom: 5.0, left: 5.0 }),
            page_number: Some("第 {page} 页".into()),
            center_horizontally: Some(true),
        };
        // 执行期只带了分页三项（页面设置**不在** `ReportOptions` 里）
        let opts = PageConfig {
            rows_per_page: 20,
            repeat_header_rows: 3,
            repeat_footer_rows: 0,
            ..Default::default()
        };
        let merged = saved.with_pagination_of(&opts);

        assert_eq!(merged.rows_per_page, 20, "分页三项要按 options 覆盖");
        assert_eq!(merged.repeat_header_rows, 3);
        assert_eq!(merged.repeat_footer_rows, 0);
        // 页面设置**原样保留**
        assert_eq!(merged.paper.as_deref(), Some("A3"), "纸张被 options 抹掉了");
        assert_eq!(merged.orientation.as_deref(), Some("landscape"));
        assert_eq!(merged.margin_mm.unwrap().left, 5.0);
        assert_eq!(merged.page_number.as_deref(), Some("第 {page} 页"));
        assert_eq!(merged.center_horizontally, Some(true));
    }

    /// 老模板（JSON 里没有这些新字段）必须照样解析得动 —— 全靠 `#[serde(default)]`
    #[test]
    fn old_template_json_without_page_setup_still_parses() {
        let json = r#"{"rows_per_page":10,"repeat_header_rows":2,"repeat_footer_rows":1}"#;
        let cfg: PageConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.rows_per_page, 10);
        assert!(cfg.paper.is_none() && cfg.margin_mm.is_none() && cfg.page_number.is_none());
        assert!(!cfg.has_setup(), "老模板不该被判成「配了页面设置」");
    }

    /// `has_setup` 只回答「有没有配页面设置」，与分页无关
    #[test]
    fn has_setup_ignores_pagination_fields() {
        assert!(!PageConfig { rows_per_page: 10, ..Default::default() }.has_setup());
        assert!(PageConfig { paper: Some("A4".into()), ..Default::default() }.has_setup());
        assert!(PageConfig { page_number: Some("x".into()), ..Default::default() }.has_setup());
        assert!(PageConfig { center_horizontally: Some(false), ..Default::default() }.has_setup());
    }
}
