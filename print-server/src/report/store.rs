//! 报表定义文件（*.json）的持久化与执行
//!
//! 目标：**打开报表就能跑出数据**。
//! 之前前端每次都要重新选库、选表、选字段、调选项，模板本身没地方落盘，
//! 「做个报表」和「跑个报表」是两件事。这里把它们合成一个文件：
//!
//! ```text
//! reports/
//!   sales-by-region.json   ← ReportDef：模板 + 数据源 + 渲染选项 + 元信息
//! ```
//!
//! 设计取舍：
//! - **存 JSON 不存二进制**：可 diff、可版本管理、可手改。报表定义本来就是文本。
//! - **数据源只存「声明」不存数据**：`sources` 描述去哪查（库/表/WHERE/参数），
//!   执行时由服务端现查。存快照会让报表过期，且几万行塞进文件没法看。
//! - **`options` 存选项而不是存算好的模板**：导出公式 / 展开控制 / 分页都是
//!   整体开关，存开关才能在打开时改；存算好的模板就回不去了。
//!   代价是服务端要有 TS 侧 `withExportFormula` / `withExpandControl` 的等价实现（见 apply_options）。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};

use super::model::{cell_pos, PageConfig, ReportTemplate, SheetTpl};
use super::ReportSource;

/// 文件头标识。读文件时先校验，避免把别的 JSON 当报表打开后报出莫名其妙的字段错误。
pub const FORMAT: &str = "openprint.report";
pub const VERSION: u32 = 1;

/* ------------------------------ 数据结构 ------------------------------ */

/// 渲染选项。对应设计器里那排开关，**存开关本身**，执行时才套到模板上。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportOptions {
    /// 每页数据行数；>0 才分页
    pub rows_per_page: Option<i64>,
    pub repeat_header_rows: Option<i64>,
    pub repeat_footer_rows: Option<i64>,
    /// 小计/合计落成 Excel 公式而非写死的值
    pub export_formula: Option<bool>,
    /// 展开条数下限（作用于最内层明细）
    pub expand_min_count: Option<i64>,
    /// 展开条数上限（作用于最外层分组）
    pub expand_max_count: Option<i64>,
    /// 展开集为空时是否保留
    pub keep_expand_empty: Option<bool>,
    /// 回传展开中间结果（调试）
    pub dump: Option<bool>,
}

/// 报表参数声明 —— 决定「执行前弹什么查询条件」
///
/// 之前只有 `RunRequest.params`（数据集名 → 位置参数数组）那条底层通道：
/// 调用方得自己知道 SQL 里第几个 `?` 是什么，前端没法据此画表单。
/// 这一层把参数**命名**并描述清楚，UI 才能自动生成查询表单。
///
/// 绑定方式：数据源的 `params` 里写字符串 `"$地区"`（`$` + 参数名），
/// 执行时换成这里解析出来的值。用显式 `$` 前缀而不是「看着像占位符就换」，
/// 是为了让「作者忘了写 $」变成一个能查出来的错误，而不是把字面量静默塞进 SQL。
///
/// 字段都是单词，无需 camelCase / snake_case 之争（与 SheetTpl 一致用 snake）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ReportParam {
    pub name: String,
    /// 表单上的显示名；缺省用 name
    pub label: Option<String>,
    /// `text` | `number` | `date` | `enum`；缺省 text
    pub kind: Option<String>,
    /// 没传值时用它
    pub default: Option<JsonValue>,
    /// 必填：既没传值也没默认值就报错（不能静默按空过）
    pub required: Option<bool>,
    /// `kind=enum` 时的候选项
    pub options: Option<Vec<String>>,
}

/// 一个报表定义文件的完整内容
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDef {
    pub format: String,
    pub version: u32,
    /// 文件 id，同时是文件名（无扩展名）。只允许 [A-Za-z0-9_-]
    pub id: String,
    /// 展示名
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 最后保存时间（服务端写回）
    #[serde(default)]
    pub updated_at: Option<String>,
    /// 模板本体（sheets + 可选的内嵌 datasets）
    pub template: ReportTemplate,
    /// 数据从哪来；执行时现查
    #[serde(default)]
    pub sources: Vec<ReportSource>,
    /// 执行前要填的参数（UI 据此画查询表单）；缺省空
    #[serde(default)]
    pub params: Vec<ReportParam>,
    #[serde(default)]
    pub options: ReportOptions,
}

/// 列表项：只回元信息，不回整个模板（列表页不需要，模板可能有几千行）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub updated_at: Option<String>,
    /// 模板里的 sheet 名，列表上给用户一点辨识度
    pub sheets: Vec<String>,
    /// 数据源数量；0 表示这个报表没有可执行的查询
    pub source_count: usize,
    pub bytes: u64,
}

/* ------------------------------ 存储 ------------------------------ */

/// 报表目录：配置文件同级目录下的 `reports/`。
/// 与配置放一起便于整体备份/迁移；不含用户目录，避免权限与清理问题。
pub fn reports_dir(config_path: &Path) -> PathBuf {
    let base = config_path.parent().filter(|p| !p.as_os_str().is_empty());
    match base {
        Some(p) => p.join("reports"),
        None => PathBuf::from("reports"),
    }
}

/// id 白名单。**这是安全边界**：id 直接参与拼文件名，
/// 必须挡掉 `/`、`..`、空串，否则 GET /api/reports/..%2F..%2Fetc 能读到任意文件。
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 把路径编成 HTTP header 值。
///
/// `HeaderValue` 只接受可见 ASCII，中文路径会被拒。直接 `from_str().ok()` 一丢了之
/// 就又是**静默失败**——而回这个 header 的全部意义就是排「列表怎么是空的」，
/// 恰好在中文路径下失效最讽刺。所以这里只把非可见 ASCII 的字节 percent 编码，
/// `/Users/.../reports` 在 curl 里照样可读；客户端 `decodeURIComponent` 还原。
pub fn header_safe(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        // `%` 自己也编码，否则「原文里就有 %20」会和「编码出来的 %20」混淆
        if (0x20..0x7f).contains(&b) && b != b'%' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn path_of(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn now_rfc3339() -> String {
    // 不引第三方时间库：用 system_time 拼一个够用的 UTC 时间戳
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    // 1970-01-01 起的 civil date 换算（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn read_def(path: &Path) -> Result<ReportDef, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取报表文件失败: {e}"))?;
    let def: ReportDef = serde_json::from_str(&raw)
        .map_err(|e| format!("报表文件不是合法的 ReportDef JSON: {e}"))?;
    if def.format != FORMAT {
        return Err(format!(
            "不是报表文件：format 字段为 {:?}，应为 {:?}",
            def.format, FORMAT
        ));
    }
    if def.version > VERSION {
        return Err(format!(
            "报表文件版本 {} 高于本程序支持的 {}，请升级 print-server",
            def.version, VERSION
        ));
    }
    Ok(def)
}

pub fn list(dir: &Path) -> Result<Vec<ReportSummary>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("读取报表目录失败: {e}"))?;
    for ent in entries {
        let ent = match ent {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let bytes = ent.metadata().map(|m| m.len()).unwrap_or(0);
        // 单个文件坏了不能让整个列表挂掉
        match read_def(&path) {
            Ok(def) => out.push(ReportSummary {
                id: def.id,
                name: def.name,
                description: def.description,
                updated_at: def.updated_at,
                sheets: def.template.sheets.iter().map(|s| s.name.clone()).collect(),
                source_count: def.sources.len(),
                bytes,
            }),
            Err(_) => {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("?")
                    .to_string();
                out.push(ReportSummary {
                    id,
                    name: "（文件损坏，无法解析）".to_string(),
                    description: String::new(),
                    updated_at: None,
                    sheets: Vec::new(),
                    source_count: 0,
                    bytes,
                })
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn load(dir: &Path, id: &str) -> Result<ReportDef, String> {
    if !is_valid_id(id) {
        return Err(format!(
            "报表 id 不合法（只允许字母数字、-、_，最长 80）: {id:?}"
        ));
    }
    let path = path_of(dir, id);
    if !path.exists() {
        return Err(format!("报表不存在: {id}"));
    }
    read_def(&path)
}

/// 保存。**覆盖写**：报表是用户的资产，静默覆盖同名文件会丢东西，
/// 所以调用方（UI）要先经列表确认；这里同时写回 updatedAt 与归一化 id。
pub fn save(dir: &Path, mut def: ReportDef) -> Result<ReportDef, String> {
    let id = def.id.trim().to_string();
    if !is_valid_id(&id) {
        return Err(format!(
            "报表 id 不合法（只允许字母数字、-、_，最长 80）: {id:?}"
        ));
    }
    def.id = id;
    if def.name.trim().is_empty() {
        def.name = def.id.clone();
    }
    def.format = FORMAT.to_string();
    def.version = VERSION;
    def.updated_at = Some(now_rfc3339());

    std::fs::create_dir_all(dir).map_err(|e| format!("创建报表目录失败: {e}"))?;
    let path = path_of(dir, &def.id);
    let text = serde_json::to_string_pretty(&def)
        .map_err(|e| format!("序列化报表失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入报表文件失败: {e}"))?;
    Ok(def)
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err(format!("报表 id 不合法: {id:?}"));
    }
    let path = path_of(dir, id);
    if !path.exists() {
        return Err(format!("报表不存在: {id}"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除报表失败: {e}"))
}

/* ------------------------------ 执行 ------------------------------ */

/// 把保存的 options 套到模板上，得到可以直接渲染的模板。
///
/// 与 TS 侧 `withExportFormula` / `withExpandControl` 一一对应——
/// 文件里存的是开关，这里是「打开报表」时把开关落到模板上的那一步。
/// 两边语义必须一致，否则同一个报表在设计器里和在服务端跑出来不一样。
pub fn apply_options(tpl: ReportTemplate, opts: &ReportOptions) -> ReportTemplate {
    let export_formula = opts.export_formula.unwrap_or(false);
    let min = opts.expand_min_count.filter(|v| *v > 0);
    let max = opts.expand_max_count.filter(|v| *v > 0);
    let keep = opts.keep_expand_empty.unwrap_or(false);

    // 内嵌 datasets 原样保留：离线/演示报表可能不查库，数据就写在模板里
    let datasets = tpl.datasets;
    let mut sheets: Vec<SheetTpl> = tpl.sheets;

    // 分页：写进每个 sheet 的 page
    let page = opts
        .rows_per_page
        .filter(|v| *v > 0)
        .map(|rows_per_page| PageConfig {
            rows_per_page: rows_per_page.max(1) as usize,
            repeat_header_rows: opts.repeat_header_rows.unwrap_or(0).max(0) as usize,
            repeat_footer_rows: opts.repeat_footer_rows.unwrap_or(0).max(0) as usize,
            // 页面设置（纸张 / 方向 / 页边距 / 页码）**不在 options 里** ——
            // 它是模板自己的属性，由下面的 `with_pagination_of` 从原 sheet 继承。
            ..Default::default()
        });
    if let Some(p) = &page {
        for s in sheets.iter_mut() {
            // **合并而不是替换**：options 只决定分页那三项。
            // 整份替换会让模板里存的纸张 / 页码**静默消失**（存盘文件里还在，
            // 但跑出来没有，界面上看不出来）。
            let old = s.page.take().unwrap_or_default();
            s.page = Some(old.with_pagination_of(p));
        }
    }

    // 展开控制：先扫一遍找出最外层 / 最内层行展开格
    if min.is_some() || max.is_some() || keep {
        for s in sheets.iter_mut() {
            let expand_pos: std::collections::BTreeSet<String> = s
                .rows
                .iter()
                .enumerate()
                .flat_map(|(r, row)| {
                    row.cells.iter().enumerate().filter_map(move |(c, cell)| {
                        (cell.model.as_ref().and_then(|m| m.expand_type.as_ref())
                            == Some(&crate::report::model::ExpandType::R))
                        .then(|| cell_pos(r, c))
                    })
                })
                .collect();
            let child_of: std::collections::BTreeSet<String> = s
                .rows
                .iter()
                .flat_map(|row| {
                    row.cells.iter().filter_map(|cell| {
                        let m = cell.model.as_ref()?;
                        if m.expand_type.as_ref() != Some(&crate::report::model::ExpandType::R) {
                            return None;
                        }
                        m.row_parent.clone()
                    })
                })
                .collect();

            for (r, row) in s.rows.iter_mut().enumerate() {
                for (c, cell) in row.cells.iter_mut().enumerate() {
                    let Some(m) = cell.model.as_mut() else { continue };
                    if m.expand_type.as_ref() != Some(&crate::report::model::ExpandType::R) {
                        continue;
                    }
                    let pos = cell_pos(r, c);
                    let is_outermost = m
                        .row_parent
                        .as_ref()
                        .map(|p| !expand_pos.contains(p))
                        .unwrap_or(true);
                    let is_innermost = !child_of.contains(&pos);
                    if is_innermost {
                        m.expand_min_count = min.map(|v| v as usize);
                    }
                    if is_outermost {
                        m.expand_max_count = max.map(|v| v as usize);
                    }
                    if keep {
                        m.keep_expand_empty = Some(true);
                    }
                }
            }
        }
    }

    // 导出公式
    if export_formula {
        for s in sheets.iter_mut() {
            for row in s.rows.iter_mut() {
                for cell in row.cells.iter_mut() {
                    if let Some(m) = cell.model.as_mut() {
                        if m.value_expr.is_some() {
                            m.export_formula = Some(true);
                        }
                    }
                }
            }
        }
    }

    ReportTemplate { sheets, datasets }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn def(id: &str) -> ReportDef {
        ReportDef {
            format: FORMAT.to_string(),
            version: VERSION,
            id: id.to_string(),
            name: format!("报表 {id}"),
            description: String::new(),
            updated_at: None,
            template: ReportTemplate::default(),
            sources: Vec::new(),
            params: Vec::new(),
            options: ReportOptions::default(),
        }
    }

    #[test]
    fn id_白名单挡住路径穿越() {
        assert!(is_valid_id("sales-by-region"));
        assert!(is_valid_id("r_1"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("../etc/passwd"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id("a\\b"));
        assert!(!is_valid_id(".."));
        // 超长
        assert!(!is_valid_id(&"a".repeat(81)));
        assert!(is_valid_id(&"a".repeat(80)));
    }

    #[test]
    fn 存取往返() {
        let dir = tempdir();
        let saved = save(&dir, def("t1")).unwrap();
        assert_eq!(saved.format, FORMAT);
        assert!(saved.updated_at.is_some());

        let loaded = load(&dir, "t1").unwrap();
        assert_eq!(loaded.id, "t1");
        assert_eq!(loaded.name, "报表 t1");
        let _ = delete(&dir, "t1").unwrap();
        assert!(load(&dir, "t1").is_err());
    }

    /// `reports_dir` 的推导规则必须被钉住——它是**静默失败**的来源。
    ///
    /// 默认配置路径是相对路径 `print-server.json`（见 main.rs），于是「从哪个
    /// 目录启动进程」就决定了「看见哪个 reports/」。从仓库根启动时列表是空的，
    /// 但没有任何报错，只有启动横幅里的路径能看出来（横幅现在也打这一行了）。
    #[test]
    fn 报表目录紧挨配置文件() {
        assert_eq!(
            reports_dir(Path::new("/srv/openprint/print-server.json")),
            PathBuf::from("/srv/openprint/reports")
        );
        // 裸文件名（无父目录）→ 退回相对路径，跟着进程工作目录走
        assert_eq!(
            reports_dir(Path::new("print-server.json")),
            PathBuf::from("reports")
        );
        // `.` 也算父目录，不能把它当成「没有父目录」而漏掉一层
        assert_eq!(
            reports_dir(Path::new("./print-server.json")),
            PathBuf::from("./reports")
        );
    }

    /// 端到端：拿「配置路径」推出目录 → 存 → 列出来 → 文件确实躺在配置旁边。
    /// 这是「换个目录启动就丢报表」那条链路上唯一没被测过的一环。
    #[test]
    fn 由配置路径推出的目录能存能列() {
        let cfg_dir = tempdir();
        let cfg_path = cfg_dir.join("print-server.json");
        let dir = reports_dir(&cfg_path);
        save(&dir, def("r1")).unwrap();

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "r1");

        assert!(
            cfg_dir.join("reports").join("r1.json").exists(),
            "报表文件应当落在配置文件同级的 reports/ 下，实际目录：{cfg_dir:?}"
        );
    }

    /// header 值必须是可见 ASCII，但目录名可以是中文 —— 不能因为编不了就丢掉。
    #[test]
    fn header_safe_保住中文路径() {
        // 纯 ASCII 路径原样通过，curl 里可读
        assert_eq!(header_safe("/srv/openprint/reports"), "/srv/openprint/reports");
        // 中文按 UTF-8 字节 percent 编码；客户端 decodeURIComponent 还原
        let enc = header_safe("/srv/报表/reports");
        assert_eq!(enc, "/srv/%E6%8A%A5%E8%A1%A8/reports");
        assert!(!enc.contains('报'), "header 值里不能留非 ASCII");
        // `%` 自己也要编码，否则和编码结果撞车
        assert_eq!(header_safe("/a%b"), "/a%25b");
    }

    #[test]
    fn 列表面与坏文件隔离() {
        let dir = tempdir();
        save(&dir, def("ok1")).unwrap();
        std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
        let all = list(&dir).unwrap();
        // 坏文件也要出现在列表里（让用户知道有个文件坏了），但不能让列表失败
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.id == "ok1"));
        assert!(all.iter().any(|s| s.name.contains("损坏")));
    }

    #[test]
    fn 拒绝非报表文件与过高版本() {
        let dir = tempdir();
        std::fs::write(
            dir.join("x.json"),
            r#"{"format":"something.else","version":1,"id":"x","name":"x","template":{"sheets":[]}}"#,
        )
        .unwrap();
        let e = load(&dir, "x").unwrap_err();
        assert!(e.contains("不是报表文件"), "实际: {e}");

        // 注意：不能走 save()——save 会把 version 归一化成当前版本，
        // 这正是「我们只按自己认识的版本写」的行为。要模拟过高版本必须直接写文件。
        std::fs::write(
            dir.join("v2.json"),
            r#"{"format":"openprint.report","version":99,"id":"v2","name":"v2","template":{"sheets":[]}}"#,
        )
        .unwrap();
        let e = load(&dir, "v2").unwrap_err();
        assert!(e.contains("高于"), "实际: {e}");
    }

    #[test]
    fn 选项落到模板上() {
        use crate::report::model::{CellModel, CellTpl, ExpandType, RowTpl};
        // 行 0：A1 外层展开、B1 内层展开（认 A1 为主格）
        let mk = |expand: bool, parent: Option<&str>| CellTpl {
            value: None,
            model: Some(CellModel {
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: parent.map(|s| s.to_string()),
                ..CellModel::default()
            }),
            ..CellTpl::default()
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "s".into(),
                rows: vec![RowTpl {
                    cells: vec![mk(true, None), mk(true, Some("A1"))],
                }],
                page: None,
                loop_field: None,
            }],
            datasets: Default::default(),
        };
        let opts = ReportOptions {
            expand_min_count: Some(3),
            expand_max_count: Some(10),
            keep_expand_empty: Some(true),
            export_formula: Some(true),
            rows_per_page: Some(20),
            repeat_header_rows: Some(1),
            ..Default::default()
        };
        let out = apply_options(tpl, &opts);
        let cells = &out.sheets[0].rows[0].cells;
        // A1 是最外层 → max；B1 是最内层 → min
        assert_eq!(cells[0].model.as_ref().unwrap().expand_max_count, Some(10));
        assert_eq!(cells[0].model.as_ref().unwrap().expand_min_count, None);
        assert_eq!(cells[1].model.as_ref().unwrap().expand_min_count, Some(3));
        assert_eq!(cells[1].model.as_ref().unwrap().expand_max_count, None);
        assert_eq!(cells[1].model.as_ref().unwrap().keep_expand_empty, Some(true));
        // 分页写进 sheet.page
        let p = out.sheets[0].page.as_ref().unwrap();
        assert_eq!(p.rows_per_page, 20);
        assert_eq!(p.repeat_header_rows, 1);
    }

    /// **`apply_options` 只能改分页三项，不能把模板里的页面设置抹掉。**
    ///
    /// 这是实现页面设置时踩到的真坑：这里原来是 `s.page = Some(p.clone())`（整份替换），
    /// 于是「存盘文件里 `paper: "A3"` 还在、跑出来却是默认纸」—— 静默丢数据。
    /// 之所以难发现：设计器读的是**存盘文件**（纸张还在），跑的是 `apply_options` 之后的模板，
    /// 两边不一致而屏幕上完全看不出来。
    ///
    /// 单测 `with_pagination_of_keeps_the_page_setup` 只守住了那个方法本身；
    /// 这条守的是**调用点**真的用了它。
    #[test]
    fn 选项不会抹掉模板的页面设置() {
        use crate::report::model::{PageConfig, PageMargins, SheetTpl};
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "s".into(),
                rows: vec![],
                page: Some(PageConfig {
                    rows_per_page: 5,
                    repeat_header_rows: 1,
                    repeat_footer_rows: 0,
                    paper: Some("A3".into()),
                    orientation: Some("landscape".into()),
                    margin_mm: Some(PageMargins { top: 3.0, right: 4.0, bottom: 5.0, left: 6.0 }),
                    page_number: Some("第 {page} 页".into()),
                    center_horizontally: Some(true),
                }),
                loop_field: None,
            }],
            datasets: Default::default(),
        };
        // 执行期的 options **只带分页三项**（页面设置不在 ReportOptions 里）
        let opts = ReportOptions {
            rows_per_page: Some(20),
            repeat_header_rows: Some(2),
            ..Default::default()
        };
        let p = apply_options(tpl, &opts).sheets[0].page.clone().unwrap();
        assert_eq!(p.rows_per_page, 20, "分页该按 options 覆盖");
        assert_eq!(p.repeat_header_rows, 2);
        // 页面设置**原样保留**
        assert_eq!(p.paper.as_deref(), Some("A3"), "纸张被 options 抹掉了");
        assert_eq!(p.orientation.as_deref(), Some("landscape"));
        assert_eq!(p.margin_mm.unwrap().left, 6.0);
        assert_eq!(p.page_number.as_deref(), Some("第 {page} 页"));
        assert_eq!(p.center_horizontally, Some(true));
    }

    /// 每个用例一个独立临时目录。
    ///
    /// **不能只用时间戳命名**：`now_rfc3339()` 只到秒，而 cargo test 并行跑，
    /// 同一秒内的多个用例会拿到同一个目录、互相看见对方的文件
    /// （第一版就栽在这：`列表面` 数出 4 个文件而不是 2 个）。
    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "op-reports-{}-{}-{}",
            std::process::id(),
            now_rfc3339().replace(':', "-"),
            n
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
