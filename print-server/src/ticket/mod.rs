//! 画布 JSON → 票据指令（ESC/POS · TSPL · ZPL）
//!
//! 补的是 `print_job.rs` 里那句「画布 JSON → 票据指令翻译（待实现）」。
//!
//! ## 输入契约
//!
//! 前端 `openprint/src/core/print-client/raw-sanitize.ts` 已经把画布 JSON **净化**过了：
//! 颜色、字体样式、设计器元数据全被裁掉，只剩几何 + 内容。所以这里不碰颜色，
//! 也不该假设 `fill` / `fontWeight` 一定在。
//!
//! ```json
//! {
//!   "version": "1.0",
//!   "document": {
//!     "type": "report",
//!     "page": { "width": 80, "height": 120, "unit": "mm", "orientation": "portrait", "margin": {...} },
//!     "sections": [{ "type": "body", "height": 120, "components": [ ... ] }]
//!   },
//!   "data": { ... }        // 可选，供 {{a.b}} 取值
//! }
//! ```
//!
//! 控件几何单位与 `page.unit` 一致，原点是**所属 Section 的左上角**；
//! 多个 Section 纵向堆叠，所以这里要给每个 Section 累加 y 偏移。
//!
//! ## 这一刀做到哪、哪些是明说的洞
//!
//! | 控件 | 处理 |
//! | --- | --- |
//! | `text` | 翻译（含 `{{a.b}}` 取值、对齐、字号） |
//! | `barcode` | 翻译（code128 / code39 / ean13） |
//! | `qrcode` | 翻译 |
//! | `line` / `rect` | 翻译 |
//! | `table` | **只翻静态 `cells` 网格**；数据行展开没做（见下） |
//! | `image` / `chart` / `math` / `signature` / `richtext` / `zone` / `labelgrid` | **不翻译，但一定报警告** |
//!
//! 「不翻译」的每一处都会进 `Ticket::warnings`，`/print` 会把它回给调用方 ——
//! 静默丢控件是这里最容易犯的错：小票上少了一行字，没人会发现。
//!
//! 表格的数据行展开没做，是因为 `data` 在运行期的形状由调用方决定
//! （`RenderRequest.data` 没有强约束），猜错了比不做好。静态网格是确定的，先翻它。

pub mod esc;
pub mod tspl;
pub mod zpl;

use serde_json::Value;

/// 默认分辨率：票据 / 标签机绝大多数是 203dpi（8 点/mm）
pub const DEFAULT_DPI: u32 = 203;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    fn parse(s: Option<&str>) -> Align {
        match s.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("center") => Align::Center,
            Some("right") => Align::Right,
            _ => Align::Left,
        }
    }
}

/// 一条待打印的图元。坐标单位 **mm**，原点 = 页面左上角，y 向下。
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Text {
        x: f64,
        y: f64,
        w: f64,
        text: String,
        font_pt: f64,
        align: Align,
        /// 旋转角度（度）。ESC/POS 画不出来，只对 TSPL / ZPL 有效
        angle: i32,
    },
    Barcode {
        x: f64,
        y: f64,
        h: f64,
        data: String,
        /// 归一后的小写符号名：code128 / code39 / ean13
        symbology: String,
        show_text: bool,
    },
    Qr {
        x: f64,
        y: f64,
        size: f64,
        data: String,
    },
    /// 水平线（竖线在票据机上按行打印，没有意义，这里统一按水平线处理）
    Rule {
        x: f64,
        y: f64,
        w: f64,
    },
    Box {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
}

impl Item {
    /// 该图元的左上角 y（mm），用于排序 / 定位
    pub fn y_mm(&self) -> f64 {
        match self {
            Item::Text { y, .. }
            | Item::Barcode { y, .. }
            | Item::Qr { y, .. }
            | Item::Rule { y, .. }
            | Item::Box { y, .. } => *y,
        }
    }

    pub fn x_mm(&self) -> f64 {
        match self {
            Item::Text { x, .. }
            | Item::Barcode { x, .. }
            | Item::Qr { x, .. }
            | Item::Rule { x, .. }
            | Item::Box { x, .. } => *x,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Ticket {
    pub width_mm: f64,
    pub height_mm: f64,
    pub dpi: u32,
    pub items: Vec<Item>,
    /// 没能翻译的东西 —— 每条都要能指名道姓
    pub warnings: Vec<String>,
}

impl Ticket {
    pub fn dots_per_mm(&self) -> f64 {
        self.dpi as f64 / 25.4
    }

    /// mm → 点（打印机的最小单位）
    pub fn dots(&self, mm: f64) -> i32 {
        (mm * self.dots_per_mm()).round() as i32
    }

    /// 页面宽度（点）
    pub fn width_dots(&self) -> i32 {
        self.dots(self.width_mm)
    }
}

/* ------------------------------- 单位换算 ------------------------------- */

/// `page.unit` → mm 的倍率。认不出来的单位**报错**而不是当 mm 用 ——
/// 猜错单位会让整张小票的坐标全错，而且看起来「能打」。
fn unit_to_mm(unit: &str) -> Result<f64, String> {
    match unit.trim().to_ascii_lowercase().as_str() {
        "" | "mm" => Ok(1.0),
        "in" => Ok(25.4),
        "pt" => Ok(25.4 / 72.0),
        other => Err(format!("画布 page.unit「{other}」认不出来（只支持 mm / in / pt）")),
    }
}

fn f64_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/* ------------------------------- 解析入口 ------------------------------- */

/// 把净化后的画布 JSON 翻成中间表示。
///
/// `dpi` 由调用方给（`PrintJobRequest.dpi`），缺省 [`DEFAULT_DPI`]。
pub fn from_canvas(json: &str, dpi: Option<u32>) -> Result<Ticket, String> {
    let root: Value = serde_json::from_str(json)
        .map_err(|e| format!("载荷不是合法 JSON，无法翻译票据指令: {e}"))?;

    let doc = root
        .get("document")
        .ok_or_else(|| "载荷缺少 document 节点（期望净化后的画布 JSON）".to_string())?;
    let page = doc
        .get("page")
        .ok_or_else(|| "载荷缺少 document.page".to_string())?;

    let unit = page.get("unit").and_then(Value::as_str).unwrap_or("mm");
    let k = unit_to_mm(unit)?;
    let width_mm = f64_of(page, "width").ok_or("document.page.width 不是数字")? * k;
    let height_mm = f64_of(page, "height").ok_or("document.page.height 不是数字")? * k;
    if !(width_mm.is_finite() && width_mm > 0.0) || !(height_mm.is_finite() && height_mm > 0.0) {
        return Err(format!("页面尺寸不合法: {width_mm} × {height_mm} mm"));
    }

    let mut t = Ticket {
        width_mm,
        height_mm,
        dpi: dpi.filter(|d| *d > 0).unwrap_or(DEFAULT_DPI),
        items: Vec::new(),
        warnings: Vec::new(),
    };

    let data = root.get("data");
    let sections = doc
        .get("sections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut offset_y = 0.0_f64;
    for (si, section) in sections.iter().enumerate() {
        let components = section
            .get("components")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for c in &components {
            translate_control(c, offset_y, k, data, &mut t);
        }
        // Section 高度缺省时按内容下沿推 —— 推不出来就按页面高度算（单节票据的常见情形）
        let declared = f64_of(section, "height").map(|h| h * k);
        let content_bottom = components
            .iter()
            .map(|c| f64_of(c, "top").unwrap_or(0.0) + f64_of(c, "height").unwrap_or(0.0))
            .fold(0.0_f64, f64::max)
            * k;
        let step = declared.unwrap_or(content_bottom);
        if si + 1 < sections.len() && step <= 0.0 {
            t.warnings.push(format!(
                "第 {} 个 Section 既没有 height、也没有能定位的子控件，后面的控件会叠在一起",
                si + 1
            ));
        }
        offset_y += step;
    }

    // 按「先上后左」排序：票据机是顺序打印的，顺序错了位置就全错
    t.items.sort_by(|a, b| {
        a.y_mm()
            .partial_cmp(&b.y_mm())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x_mm().partial_cmp(&b.x_mm()).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(t)
}

/// 认不出来的控件类型一律**报警告**（不是静默丢）
fn unsupported(t: &mut Ticket, ty: &str, id: &str, x: f64, y: f64) {
    t.warnings.push(format!(
        "控件 {id}（{ty}）在 {x:.1},{y:.1}mm 处未翻译：票据指令画不出这类内容，该处会留白"
    ));
}

fn translate_control(c: &Value, offset_y: f64, k: f64, data: Option<&Value>, t: &mut Ticket) {
    let ty = c.get("type").and_then(Value::as_str).unwrap_or("?");
    let id = c.get("id").and_then(Value::as_str).unwrap_or("?");
    // 不打印开关：`printable:false` 是**设计期标记**，跳过不算「没翻译」
    if c.get("printable").and_then(Value::as_bool) == Some(false) {
        return;
    }
    let x = f64_of(c, "left").unwrap_or(0.0) * k;
    let y = f64_of(c, "top").unwrap_or(0.0) * k + offset_y;
    let w = f64_of(c, "width").unwrap_or(0.0) * k;
    let h = f64_of(c, "height").unwrap_or(0.0) * k;
    let angle = f64_of(c, "angle").unwrap_or(0.0).round() as i32;

    match ty {
        "text" => {
            let style = c.get("style");
            let font_pt = style.and_then(|s| f64_of(s, "fontSize")).unwrap_or(10.0);
            let align = Align::parse(style.and_then(|s| s.get("textAlign")).and_then(Value::as_str));
            let Some(text) = resolve_text(c, data, t, id) else {
                return;
            };
            if text.trim().is_empty() {
                return;
            }
            t.items.push(Item::Text { x, y, w, text, font_pt, align, angle });
        }
        "barcode" => {
            let Some(text) = resolve_text(c, data, t, id) else {
                return;
            };
            if text.trim().is_empty() {
                return;
            }
            let raw = c.get("format").and_then(Value::as_str).unwrap_or("code128");
            let sym = normalize_symbology(raw);
            if sym.is_none() {
                t.warnings.push(format!(
                    "条码 {id} 的格式「{raw}」没实现（支持 code128 / code39 / ean13），该处留白"
                ));
                return;
            }
            t.items.push(Item::Barcode {
                x,
                y,
                h: if h > 0.0 { h } else { 10.0 },
                data: text,
                symbology: sym.unwrap().to_string(),
                show_text: c.get("showText").and_then(Value::as_bool).unwrap_or(true),
            });
        }
        "qrcode" => {
            let Some(text) = resolve_text(c, data, t, id) else {
                return;
            };
            if text.trim().is_empty() {
                return;
            }
            let size = if w > 0.0 { w } else { 15.0 };
            t.items.push(Item::Qr { x, y, size, data: text });
        }
        "line" => t.items.push(Item::Rule { x, y, w: if w > 0.0 { w } else { t.width_mm - x } }),
        "rect" => t.items.push(Item::Box { x, y, w, h }),
        "table" => translate_table(c, offset_y, k, data, t, id),
        other => unsupported(t, other, id, x, y),
    }
}

fn normalize_symbology(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
        "" | "code128" | "128" => Some("code128"),
        "code39" | "39" => Some("code39"),
        "ean13" | "ean" => Some("ean13"),
        _ => None,
    }
}

/// 取控件的文本。
///
/// 判别顺序照前端 `resolveTextValue`：有 `contentType` 就照它办，
/// 老模板按 **expression > binding > value** 回退。
///
/// 顺序不能拍脑袋：`binding` 是**数据路径**（`customer.name`），`value` 是**字面量**。
/// 搞反了就会把「customer.name」这几个字原样印在小票上 —— 而且那看起来是"有内容"的，
/// 不会有人报错。
fn resolve_text(c: &Value, data: Option<&Value>, t: &mut Ticket, id: &str) -> Option<String> {
    let s = |k: &str| c.get(k).and_then(Value::as_str);
    match c.get("contentType").and_then(Value::as_str) {
        Some("variable") => s("binding")
            .map(|p| resolve_path(p, data, t, id))
            .or_else(|| s("value").map(|v| substitute(v, data, t, id))),
        Some("expression") => s("expression").map(|e| substitute(e, data, t, id)),
        Some("fixed") => s("value").map(|v| substitute(v, data, t, id)),
        _ => {
            if let Some(e) = s("expression") {
                Some(substitute(e, data, t, id))
            } else if let Some(b) = s("binding") {
                Some(resolve_path(b, data, t, id))
            } else if let Some(v) = s("value") {
                Some(substitute(v, data, t, id))
            } else {
                // 表格单元格把静态文本放在 `text` 上
                c.get("text").and_then(Value::as_str).map(str::to_string)
            }
        }
    }
}

/// 数据路径取值（`binding` 模式）。取不到就**留路径原文 + 报警告**，
/// 不能悄悄变空串 —— 小票上少一个字段比多一行错误文本更难发现。
fn resolve_path(path: &str, data: Option<&Value>, t: &mut Ticket, id: &str) -> String {
    match lookup(data, path) {
        Some(v) => scalar_to_text(&v),
        None => {
            t.warnings
                .push(format!("控件 {id} 的绑定「{path}」在 data 里找不到，已按原样打印"));
            path.to_string()
        }
    }
}

/// 把 `{{a.b.c}}` 从 `data` 里取出来。取不到就原样留着 + 报警告。
///
/// 故意**不**支持表达式（`{{row.amount * 2}}` 这种）—— 票据指令没有求值能力，
/// 硬算会算错；留原样 + 警告至少让人看见。
fn substitute(raw: &str, data: Option<&Value>, t: &mut Ticket, id: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let path = after[..end].trim();
        match lookup(data, path) {
            Some(v) => out.push_str(&scalar_to_text(&v)),
            None => {
                t.warnings.push(format!(
                    "控件 {id} 的取值「{{{{{path}}}}}」在 data 里找不到，已按原样打印"
                ));
                out.push_str("{{");
                out.push_str(path);
                out.push_str("}}");
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn lookup(data: Option<&Value>, path: &str) -> Option<Value> {
    let mut cur = data?;
    for seg in path.split('.') {
        let seg = seg.trim();
        if seg.is_empty() {
            return None;
        }
        cur = match cur {
            Value::Object(m) => m.get(seg)?,
            Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur.clone())
}

fn scalar_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 表格：只翻**静态 `cells` 网格**（设计期就定下来的那些格子）。
///
/// 数据行（`dataSource` 指向的数组）没做 —— 见模块头注释。
fn translate_table(
    c: &Value,
    offset_y: f64,
    k: f64,
    data: Option<&Value>,
    t: &mut Ticket,
    id: &str,
) {
    let x0 = f64_of(c, "left").unwrap_or(0.0) * k;
    let y0 = f64_of(c, "top").unwrap_or(0.0) * k + offset_y;
    let rows = c.get("cells").and_then(Value::as_array).cloned().unwrap_or_default();

    if rows.is_empty() {
        t.warnings.push(format!(
            "表格 {id} 只有数据行、没有静态 cells，票据指令下未翻译（该处留白）"
        ));
        return;
    }

    let widths = column_widths_mm(c, k);
    let row_h = f64_of(c, "height").unwrap_or(0.0) * k / rows.len().max(1) as f64;
    let row_h = if row_h > 0.0 { row_h } else { 5.0 };

    for (ri, row) in rows.iter().enumerate() {
        let Some(cells) = row.as_array() else { continue };
        let mut x = x0;
        for (ci, cell) in cells.iter().enumerate() {
            let cw = widths.get(ci).copied().unwrap_or(0.0);
            let style = cell.get("style");
            let font_pt = style.and_then(|s| f64_of(s, "fontSize")).unwrap_or(9.0);
            let align = Align::parse(style.and_then(|s| s.get("align")).and_then(Value::as_str));
            let text = resolve_text(cell, data, t, id);
            if let Some(text) = text.filter(|s| !s.trim().is_empty()) {
                t.items.push(Item::Text {
                    x,
                    y: y0 + ri as f64 * row_h,
                    w: cw,
                    text,
                    font_pt,
                    align,
                    angle: 0,
                });
            }
            // colSpan：跨列的格子要吃掉后面几列的宽度，不然内容会跟邻格叠在一起
            let span = cell.get("colSpan").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            let eaten: f64 = widths.iter().skip(ci).take(span).sum();
            x += if span > 1 { eaten } else { cw };
        }
    }
}

/// 表格列宽（mm）：优先 `columns[].width`，缺省按页宽均分。
fn column_widths_mm(c: &Value, k: f64) -> Vec<f64> {
    let total = f64_of(c, "width").unwrap_or(0.0) * k;
    let cols = c.get("columns").and_then(Value::as_array).cloned().unwrap_or_default();
    if cols.is_empty() {
        return Vec::new();
    }
    let declared: Vec<Option<f64>> = cols.iter().map(|col| f64_of(col, "width").map(|w| w * k)).collect();
    let known: f64 = declared.iter().flatten().sum();
    let unknown = declared.iter().filter(|d| d.is_none()).count();
    let fallback = if unknown > 0 { ((total - known).max(0.0)) / unknown as f64 } else { 0.0 };
    declared.into_iter().map(|d| d.unwrap_or(fallback)).collect()
}

/// 按格式出字节：`esc` 是二进制流，`tsc` / `zpl` 是纯文本指令（仍是字节）。
///
/// 取 `&mut Ticket` 是因为翻译过程中还会**追加**告警（旋转不支持、字符编码不出来、
/// 条码位数不对……）。这些洞必须在翻译期就暴露出来 —— 事后看字节流是看不出来的。
pub fn render(t: &mut Ticket, format: &str) -> Result<Vec<u8>, String> {
    match format {
        "esc" => Ok(esc::render(t)),
        "tsc" => Ok(tspl::render(t)),
        "zpl" => Ok(zpl::render(t)),
        other => Err(format!("未知票据指令格式: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canvas(page: Value, sections: Value) -> String {
        json!({
            "version": "1.0",
            "document": { "type": "report", "page": page, "sections": sections }
        })
        .to_string()
    }

    fn page_mm(w: f64, h: f64) -> Value {
        json!({ "width": w, "height": h, "unit": "mm", "orientation": "portrait" })
    }

    #[test]
    fn unit_inch_and_pt_are_converted() {
        let j = canvas(json!({ "width": 3.0, "height": 2.0, "unit": "in" }), json!([]));
        let t = from_canvas(&j, None).unwrap();
        assert!((t.width_mm - 76.2).abs() < 1e-6, "3in 应是 76.2mm，实际 {}", t.width_mm);

        let j = canvas(json!({ "width": 72.0, "height": 72.0, "unit": "pt" }), json!([]));
        let t = from_canvas(&j, None).unwrap();
        assert!((t.width_mm - 25.4).abs() < 1e-6, "72pt 应是 25.4mm，实际 {}", t.width_mm);
    }

    /// 单位认不出来必须**报错**：当 mm 用会让整张小票坐标全错，而且看起来能打
    /// 页面尺寸不合法要**报错**：0 宽/0 高的页面算出来的点数全是 0，
    /// 发出去是一张空纸，而且没有任何报错
    #[test]
    fn degenerate_page_size_errors() {
        for (w, h) in [(0.0, 100.0), (80.0, 0.0), (-1.0, 100.0)] {
            let j = canvas(
                json!({ "width": w, "height": h, "unit": "mm" }),
                json!([]),
            );
            let err = from_canvas(&j, None).unwrap_err();
            assert!(err.contains("页面尺寸"), "{w}×{h} 的错误: {err}");
        }
    }

    #[test]
    fn unknown_unit_errors_instead_of_being_treated_as_mm() {
        let j = canvas(json!({ "width": 80, "height": 100, "unit": "cm" }), json!([]));
        let err = from_canvas(&j, None).unwrap_err();
        assert!(err.contains("cm"), "错误里要指出是哪个单位: {err}");
    }

    #[test]
    fn sections_stack_vertically() {
        let j = canvas(
            page_mm(80.0, 200.0),
            json!([
                { "type": "header", "height": 30, "components": [
                    { "id": "h1", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                      "value": "抬头" } ] },
                { "type": "body", "height": 50, "components": [
                    { "id": "b1", "type": "text", "left": 0, "top": 2, "width": 80, "height": 5,
                      "value": "正文" } ] }
            ]),
        );
        let t = from_canvas(&j, None).unwrap();
        let ys: Vec<f64> = t.items.iter().map(Item::y_mm).collect();
        assert_eq!(ys, vec![0.0, 32.0], "第二个 Section 的 top 要加上第一个的 height");
    }

    #[test]
    fn text_value_binding_and_expression_all_resolve() {
        let j = json!({
            "version": "1.0",
            "document": { "type": "report", "page": page_mm(80.0, 100.0),
              "sections": [{ "type": "body", "height": 100, "components": [
                { "id": "t1", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                  "value": "值" },
                { "id": "t2", "type": "text", "left": 0, "top": 6, "width": 80, "height": 5,
                  "binding": "shop" },
                { "id": "t3", "type": "text", "left": 0, "top": 12, "width": 80, "height": 5,
                  "expression": "共 {{order.count}} 件" }
              ] }] },
            "data": { "shop": "望京店", "order": { "count": 3 } }
        })
        .to_string();
        let t = from_canvas(&j, None).unwrap();
        let texts: Vec<String> = t
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["值", "望京店", "共 3 件"]);
        assert!(t.warnings.is_empty(), "不该有告警: {:?}", t.warnings);
    }

    /// 取不到值要**留原样 + 报警告**，不能悄悄变空串
    #[test]
    fn missing_binding_keeps_placeholder_and_warns() {
        let j = json!({
            "version": "1.0",
            "document": { "type": "report", "page": page_mm(80.0, 100.0),
              "sections": [{ "type": "body", "height": 100, "components": [
                { "id": "t1", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                  "value": "店名：{{shop}}" } ] }] },
            "data": { "other": 1 }
        })
        .to_string();
        let t = from_canvas(&j, None).unwrap();
        match &t.items[0] {
            Item::Text { text, .. } => assert_eq!(text, "店名：{{shop}}"),
            other => panic!("期望 Text，实际 {other:?}"),
        }
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("shop"), "告警要指名是哪个占位符: {}", t.warnings[0]);
    }

    /// 老模板没有 `contentType` 时按 **expression > binding > value** 回退。
    ///
    /// 这一条是钉住一个真踩过的坑：`binding` 是**数据路径**、`value` 是**字面量**，
    /// 顺序搞反就会把「customer.name」这几个字原样印在小票上 —— 而且看着"有内容"，
    /// 不会有人报错。
    #[test]
    fn legacy_fallback_order_is_expression_then_binding_then_value() {
        let mk = |c: serde_json::Value| {
            let root = json!({
                "version": "1.0",
                "document": { "type": "report", "page": page_mm(80.0, 100.0),
                  "sections": [{ "type": "body", "height": 100, "components": [c] }] },
                "data": { "customer": { "name": "张三" } }
            });
            let t = from_canvas(&root.to_string(), None).unwrap();
            match t.items.first() {
                Some(Item::Text { text, .. }) => text.clone(),
                other => panic!("期望 Text，实际 {other:?}"),
            }
        };

        // 三个都在 → expression 赢
        assert_eq!(
            mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                "value": "字面量", "binding": "customer.name", "expression": "{{customer.name}} 先生" })),
            "张三 先生"
        );
        // 没有 expression → binding 按**路径**取值（不是把路径当字面量印出来）
        assert_eq!(
            mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                "value": "字面量", "binding": "customer.name" })),
            "张三"
        );
        // 只有 value → 字面量（里面手敲的 {{}} 仍会取值）
        assert_eq!(
            mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                "value": "字面量" })),
            "字面量"
        );
    }

    /// `contentType` 在场时以它为准 —— 不能"看到 value 就用 value"
    #[test]
    fn explicit_content_type_wins() {
        let mk = |c: serde_json::Value| {
            let root = json!({
                "version": "1.0",
                "document": { "type": "report", "page": page_mm(80.0, 100.0),
                  "sections": [{ "type": "body", "height": 100, "components": [c] }] },
                "data": { "customer": { "name": "张三" } }
            });
            from_canvas(&root.to_string(), None).unwrap()
        };
        // variable：value 只是残留，要按 binding 取
        let t = mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
            "contentType": "variable", "value": "旧值", "binding": "customer.name" }));
        match &t.items[0] {
            Item::Text { text, .. } => assert_eq!(text, "张三"),
            other => panic!("{other:?}"),
        }
        // fixed：binding 只是残留，要原样印 value（含手敲的 {{}} 也要取值）
        let t = mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
            "contentType": "fixed", "value": "客户：{{customer.name}}", "binding": "customer.name" }));
        match &t.items[0] {
            Item::Text { text, .. } => assert_eq!(text, "客户：张三"),
            other => panic!("{other:?}"),
        }
        // expression：只认 expression 字段
        let t = mk(json!({ "id": "c", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
            "contentType": "expression", "value": "旧值", "expression": "{{customer.name}}" }));
        match &t.items[0] {
            Item::Text { text, .. } => assert_eq!(text, "张三"),
            other => panic!("{other:?}"),
        }
    }

    /// 绑定的路径取不到 → 留路径原文 + 告警（不是悄悄变空串）
    #[test]
    fn unresolvable_binding_keeps_path_and_warns() {
        let root = json!({
            "version": "1.0",
            "document": { "type": "report", "page": page_mm(80.0, 100.0),
              "sections": [{ "type": "body", "height": 100, "components": [
                { "id": "c1", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
                  "contentType": "variable", "binding": "customer.phone" } ] }] },
            "data": { "customer": { "name": "张三" } }
        });
        let t = from_canvas(&root.to_string(), None).unwrap();
        match &t.items[0] {
            Item::Text { text, .. } => assert_eq!(text, "customer.phone"),
            other => panic!("{other:?}"),
        }
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("customer.phone"), "{}", t.warnings[0]);
    }

    /// 画不出来的控件必须留痕 —— 静默丢控件是小票最容易犯的错
    #[test]
    fn unsupported_controls_warn_instead_of_vanishing() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "img1", "type": "image", "left": 1, "top": 2, "width": 20, "height": 10 },
                { "id": "ch1", "type": "chart", "left": 1, "top": 20, "width": 60, "height": 30 },
                { "id": "ok1", "type": "text", "left": 0, "top": 60, "width": 80, "height": 5,
                  "value": "还是得有字" }
            ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        assert_eq!(t.warnings.len(), 2, "两个画不出来的控件要各有一条: {:?}", t.warnings);
        assert!(t.warnings.iter().any(|w| w.contains("img1") && w.contains("image")));
        assert!(t.warnings.iter().any(|w| w.contains("ch1") && w.contains("chart")));
        assert_eq!(t.items.len(), 1, "能翻的还是要翻");
    }

    /// `printable:false` 是设计期标记，跳过它**不算**「没翻译」，不该报警告
    #[test]
    fn printable_false_is_skipped_without_warning() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "x1", "type": "image", "left": 0, "top": 0, "width": 10, "height": 10,
                  "printable": false } ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        assert!(t.warnings.is_empty(), "不该有告警: {:?}", t.warnings);
        assert!(t.items.is_empty());
    }

    /// 没实现的条码格式要留痕，不能画成个空框
    #[test]
    fn unimplemented_barcode_format_warns() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "bc1", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 10,
                  "value": "6901234567892", "format": "itf14" } ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        assert!(t.items.is_empty());
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("itf14"), "要说清是哪个格式: {}", t.warnings[0]);
    }

    /// 表格只有数据行、没有静态 cells → 留痕，别画成一片空白
    #[test]
    fn table_without_static_cells_warns() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "tb1", "type": "table", "left": 0, "top": 0, "width": 80, "height": 40,
                  "dataSource": "items" } ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("tb1"));
    }

    #[test]
    fn items_are_sorted_top_then_left() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "b", "type": "text", "left": 40, "top": 20, "width": 30, "height": 5, "value": "右下" },
                { "id": "a", "type": "text", "left": 0, "top": 20, "width": 30, "height": 5, "value": "左下" },
                { "id": "c", "type": "text", "left": 0, "top": 5, "width": 30, "height": 5, "value": "最上" }
            ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        let texts: Vec<&str> = t
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["最上", "左下", "右下"]);
    }

    #[test]
    fn dpi_defaults_to_203_and_is_overridable() {
        let j = canvas(page_mm(80.0, 100.0), json!([]));
        assert_eq!(from_canvas(&j, None).unwrap().dpi, DEFAULT_DPI);
        assert_eq!(from_canvas(&j, Some(300)).unwrap().dpi, 300);
        // 0 / 负数当没给，别算出个 0 点/mm 的页面
        assert_eq!(from_canvas(&j, Some(0)).unwrap().dpi, DEFAULT_DPI);
    }

    #[test]
    fn dots_conversion_matches_203dpi() {
        let j = canvas(page_mm(80.0, 100.0), json!([]));
        let t = from_canvas(&j, None).unwrap();
        // 203dpi **不是**整 8 点/mm（203/25.4 = 7.9921…）：80mm 是 639 点而不是 640。
        // 这里刻意钉死 639 —— 当成 8 点/mm 会让每 127mm 差 1 点，长标签上会看出来。
        assert_eq!(t.dots(25.4), 203);
        assert_eq!(t.width_dots(), 639);
        assert_eq!(t.dots(100.0), 799);
    }

    #[test]
    fn table_static_grid_becomes_text_items() {
        let j = canvas(
            page_mm(80.0, 100.0),
            json!([{ "type": "body", "height": 100, "components": [
                { "id": "tb1", "type": "table", "left": 0, "top": 10, "width": 80, "height": 10,
                  "columns": [ { "title": "品名", "width": 50 }, { "title": "数量", "width": 30 } ],
                  "cells": [
                    [ { "contentType": "text", "text": "苹果" }, { "contentType": "text", "text": "2" } ],
                    [ { "contentType": "text", "text": "香蕉" }, { "contentType": "text", "text": "5" } ]
                  ] } ] }]),
        );
        let t = from_canvas(&j, None).unwrap();
        let cells: Vec<(f64, f64, String)> = t
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Text { x, y, text, .. } => Some((*x, *y, text.clone())),
                _ => None,
            })
            .collect();
        // 两行两列，第一行 y=10、第二行 y=15；列宽 50 / 30
        assert_eq!(
            cells,
            vec![
                (0.0, 10.0, "苹果".into()),
                (50.0, 10.0, "2".into()),
                (0.0, 15.0, "香蕉".into()),
                (50.0, 15.0, "5".into()),
            ]
        );
    }
}
