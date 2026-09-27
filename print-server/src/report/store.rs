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
use std::fmt;
use std::path::{Path, PathBuf};

use super::model::{cell_pos, PageConfig, ReportTemplate, SheetTpl};
use super::ReportSource;

/// 文件头标识。读文件时先校验，避免把别的 JSON 当报表打开后报出莫名其妙的字段错误。
pub const FORMAT: &str = "openprint.report";
pub const VERSION: u32 = 1;

/// 保存失败的原因。
///
/// **必须能区分三种失败** —— UI 对它们的反应**各不相同**：
///
/// | 变体 | 状态码 | UI 该做什么 |
/// | --- | --- | --- |
/// | [`Invalid`](Self::Invalid) | 400 | 弹错误，别存了 |
/// | [`Conflict`](Self::Conflict) | 409 | 弹「要覆盖吗」，确认了就带 `force` 重发 |
/// | [`Stale`](Self::Stale) | 412 | 弹「别人改过了」，让用户选重新打开还是硬覆盖 |
///
/// 用一个 `String` 把它们混在一起的话，UI 只能靠**匹配文案**来分辨 ——
/// 文案一改（哪怕只是加个标点）就静默退化：覆盖冲突被当成普通错误弹出去，
/// 用户**再也点不到那个确认框**，于是「保存不了」且看不出为什么。
/// 这正是本项目最怕的「声明与实现漂移、症状是看着正常」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveError {
    /// 请求本身有问题（id 非法 / 序列化失败 / 写盘失败）→ 400
    Invalid(String),
    /// 目标已存在，且调用方**没有**声明要覆盖 → 409
    Conflict(String),
    /// 目标当前版本与调用方手上的 `base` 对不上 → 412
    ///
    /// **为什么不是 409**：409 那条路是「你没说可以覆盖，说了就行」——
    /// 客户端**原样重发**即可。这条不是：它意味着**调用方手上的东西过期了**，
    /// 原样重发没有任何意义，必须由人决定「重新打开」还是「用我的版本盖掉」。
    /// 两种失败要求调用方做**不同的事**，所以必须能被程序分辨，
    /// 而不是都塞进一个 409 让 UI 去猜。
    Stale {
        /// 调用方声明的版本（它手上那份）
        expected: String,
        /// 服务端当前版本；`None` 表示文件已经不存在了
        actual: Option<String>,
    },
}

impl SaveError {
    /// 给人看的那句话。**别拿它做分支判据** —— 要分支就 `match` 变体。
    pub fn message(&self) -> String {
        match self {
            Self::Invalid(m) | Self::Conflict(m) => m.clone(),
            Self::Stale { expected, actual } => format!(
                "这份报表在别处被改过了：你手上是 {expected}，服务端现在是 {}。\
                 请重新打开看一遍（或用你的版本覆盖）。",
                actual.as_deref().unwrap_or("（文件已不存在）")
            ),
        }
    }
}

impl fmt::Display for SaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

/// **这次保存建立在什么前提上**。
///
/// 为什么是三个状态而不是「`Option<String>` 有没有 base」：`Option` 只有两个状态，
/// 于是 `force=1` 往一个**全新 id** 保存（完全合法的场景：另存为）就没法表达 ——
/// 会被迫报 409，凭空造出一个**并不存在的冲突**。三态逼每个调用点在编译期
/// 说清自己要哪一个，而不是靠「参数没传大概是这个意思吧」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// 目标必须**不存在**（新建 / 另存为）
    Absent,
    /// 目标必须存在，且版本**恰好**是这个（乐观锁）
    Base(String),
    /// 不管现在是什么，直接覆盖。调用方已经拿到了「可以覆盖」的授权
    /// （用户在确认框上点过「覆盖」，或者它就是在编辑自己刚打开的那一份）
    Anything,
}

/// id 的归一化（去两侧空白）。**只此一处**。
///
/// 校验、存在性判断、落盘文件名**必须用同一个 id**。否则会出现这种静默绕过：
/// 闸拿 `" t9 "` 去查 `" t9 .json"`（不存在 → 放行），
/// 而落盘拿 `"t9"` 去写 `t9.json`（覆盖掉了已有的那份）。
/// 两个函数各写一遍 `.trim()` 时，这类漂移不会报错，只会安静地毁数据。
fn normalise_id(raw: &str) -> String {
    raw.trim().to_string()
}

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

/// 当前 UTC 毫秒时间戳。不引第三方时间库。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 1970-01-01 起的天数（Howard Hinnant 的 `days_from_civil`）。
///
/// 与 [`format_rfc3339_millis`] 里的正向换算**是一对**，改动必须同步 ——
/// 只有「写出来的形状」和「读回来的形状」完全一致，
/// [`parse_rfc3339_millis`] 才不会把自家产出的时间戳判成看不懂。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146_095]
    era * 146_097 + doe - 719_468
}

/// 毫秒时间戳 → `YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC，**定宽**）。
///
/// 定宽不只是好看：它让**字典序等于时间序**，UI 那边的
/// `localeCompare` 倒序排列（`TemplateModal.tsx`）因此天然正确；
/// 同时它也是 [`parse_rfc3339_millis`] 能逆回去的前提。
///
/// **毫秒精度的作用不是「让 token 唯一」** —— 那是 [`next_updated_at`] 的 `+1ms`
/// 修正负责的，有它在，秒级时钟给出的 token 一样严格递增。精度的作用是
/// **保真 + 限制漂移**：那个 `+1ms` 是拿「上一个值」当基准往前推的，
/// 所以时间戳会跑到真实时间前面；秒级时钟下一秒存 1000 次就超前 1 秒，
/// 而这个值是要显示给人看的（列表里那句「更新于 …」）。毫秒精度下要跑赢它
/// 得每秒存 1000 次，而每次保存都要写盘，做不到。
/// 顺带一提，TS 侧 `local-repo.ts` 用的 `new Date().toISOString()` 本来就是毫秒
/// —— 提到毫秒也把两边对齐了。
fn format_rfc3339_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
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
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        millis
    )
}

/// [`format_rfc3339_millis`] 的逆运算。只认**两种定宽形状**，其余返回 `None`：
///
/// - 定宽 24：`2026-09-27T12:34:56.789Z` —— 当前形状；
/// - 定宽 20：`2026-09-27T12:34:56Z` —— **旧版**形状。磁盘上已有的报表就是它，
///   必须继续认：不认就等于「升级后第一次保存不做单调修正」，
///   把升级那一刻变成一个锁失效的窗口。它当年就是本函数产出的，不是猜的。
///
/// 为什么不做**宽松**解析：这个值要参与乐观锁的**相等比对**。把「看不懂的时间戳」
/// 猜成一个近似值，等于拿一个凭空造出来的版本去和客户端的版本比 ——
/// 比出来的结论毫无意义，却**不会报错**。返回 `None` 则让调用方明确走
/// 「没有旧值」那条路，代价只是少一次单调修正，不会得出错误结论。
fn parse_rfc3339_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let millis = match b.len() {
        24 => {
            if b[19] != b'.' || b[23] != b'Z' {
                return None;
            }
            s.get(20..23)?.parse::<i64>().ok()?
        }
        20 => {
            if b[19] != b'Z' {
                return None;
            }
            0
        }
        _ => return None,
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    // 用 get 而不是切片：非 ASCII 会在边界上失败 → None，而不是 panic
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    Some((days_from_civil(y, mo as u32, d as u32) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + millis)
}

/// 给某个报表文件算**下一个** `updatedAt`：`max(now, 旧值 + 1ms)`。
///
/// 也就是说，**同一个文件的时间戳严格递增**。
///
/// 为什么非要「严格」不可：这个值就是乐观锁的版本 token。**两次保存只要能拿到
/// 同一个 token，锁就静默失效** —— 客户端拿旧 token 来比，比出「没变过」，
/// 于是覆盖掉别人的改动，全程不报错、不警告。
///
/// 只把精度提到毫秒**不够**：两次保存之间只隔着一次写盘，在快机器上落进
/// 同一毫秒完全可能。而「够不够」取决于机器 —— 也就意味着**我自己的单测会假绿**：
/// 它恰好错开一毫秒就绿了，于是这条锁「测过」但没被守住。
/// 加上「必须比旧值大 1ms」之后，它与时钟精度、与机器快慢都无关，
/// 变成**确定不会撞**。
fn next_updated_at(path: &Path) -> String {
    let now = now_millis();
    // 旧文件读不出来（不存在 / 损坏 / 时间戳形状不认识）就不做修正：
    // 这时本来就没有可比的旧 token，硬凑一个只会造出**假的**单调性。
    let bumped = read_def(path)
        .ok()
        .and_then(|d| d.updated_at)
        .and_then(|s| parse_rfc3339_millis(&s))
        .map(|old| old + 1);
    format_rfc3339_millis(bumped.map_or(now, |b| now.max(b)))
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

/// 原子写：先备份 `.bak`，再写 `.tmp`，最后 `rename` 覆盖。
///
/// **为什么必须原子**：`std::fs::write` 的语义是 `create + truncate + write` ——
/// 旧内容在 **truncate 那一刻就没了**，而 `write` 之后还有一整段时间。
/// 报表是用户的资产，写到一半崩（或磁盘满、或被 `RLIMIT_FSIZE` / SIGXFSZ 打断）
/// 会让文件变成**截断的 JSON**：`load` 解析失败，而旧内容**没有备份**，不可恢复。
/// `rename` 在同一目录内是原子的，所以目标文件**要么是旧的完整内容、
/// 要么是新的完整内容**，不存在「半成品」这一态。
///
/// 与 `config.rs::ServerConfig::save` 是同一套做法（那份就在隔壁文件，
/// 别各写各的 —— 本项目吃过「同一个正确写法在仓库里有两份、其中一份是错的」的亏）。
///
/// 注意 `.bak` / `.tmp` 的名字是「原文件名 + 后缀」，所以它们的**扩展名不是 json**，
/// `list()` 的 `extension() == "json"` 判据天然跳过它们（有单测钉住，别改成
/// `file_name().ends_with(".json")` —— 那会把 `foo.json.bak` 也当报表读进来）。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建报表目录失败: {e}"))?;
    }
    // 备份上一版。覆盖本身是不可逆的；UI 侧虽有确认（那是另一道闸），
    // 但确认只能防「手滑」，防不了「改错了想退回去」——留一份才有手工恢复的路。
    if path.exists() {
        let bak = PathBuf::from(format!("{}.bak", path.display()));
        std::fs::copy(path, &bak).map_err(|e| format!("备份原报表失败: {e}"))?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, text).map_err(|e| format!("写入报表临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换报表文件失败: {e}"))
}

/// 保存。**这是唯一的落盘入口** —— `save_new` 已经并进来了（它就是
/// [`Expect::Absent`]），因为「该不该拦」这件事必须由调用方**在编译期**声明，
/// 而不是由「你调了哪个函数」隐式决定。
///
/// 落盘前先过闸（[`Expect`]），闸不过**一个字节都不碰** ——
/// 特别是不能留下 `.bak`：`write_atomic` 一旦被调用就会备份，
/// 所以「有没有 .bak」等价于「它到底有没有动过盘」。
///
/// 这里同时写回 updatedAt 与归一化 id（归一化走 [`normalise_id`]，只此一处）。
/// updatedAt 走 [`next_updated_at`] —— **同一文件严格递增**，这是它能当乐观锁
/// 版本 token 的前提。落盘走 [`write_atomic`]：**目标文件不会出现「写了一半」的中间态**。
pub fn save(dir: &Path, mut def: ReportDef, expect: Expect) -> Result<ReportDef, SaveError> {
    let id = normalise_id(&def.id);
    // ⚠️ **先校验再碰路径，顺序不能反**。反了有两处坏：
    // 1. `path_of` 会拿**未校验**的 id 拼路径 —— `../` 能穿出报表目录；
    // 2. 非法 id 会被报成 409 / 412（「已存在」/「被改过」），
    //    把用户指向完全错误的方向。
    if !is_valid_id(&id) {
        return Err(SaveError::Invalid(format!(
            "报表 id 不合法（只允许字母数字、-、_，最长 80）: {id:?}"
        )));
    }
    def.id = id.clone();

    let path = path_of(dir, &id);

    // ── 闸：**必须在 next_updated_at / write_atomic 之前** ──────────────
    match &expect {
        Expect::Absent => {
            if path.exists() {
                return Err(SaveError::Conflict(format!(
                    "报表 {id} 已存在；覆盖会换掉原内容。确认要覆盖请带 ?force=1 重发。"
                )));
            }
        }
        Expect::Base(base) => {
            // ⚠️ **目标不在时也要报 Stale，不能当成「没冲突」放过去。**
            // 这两个分支是一对：`base` 的语义是「我手上这份是建立在某个版本上的」，
            // 而目标不存在意味着那个基础**已经没了**（别人删了 / 从没存在过）。
            // 放过去就等于「拿一份可能过期的内容凭空新建」，与乐观锁的意图相反。
            let actual = read_def(&path).ok().and_then(|d| d.updated_at);
            if actual.as_deref() != Some(base.as_str()) {
                return Err(SaveError::Stale {
                    expected: base.clone(),
                    actual,
                });
            }
        }
        // 调用方已经拿到授权（用户点过「覆盖」）。这里**刻意不再看 force** ——
        // 那面旗子属于 HTTP 层，到了这一层它已经变成「这次要覆盖」这个事实了。
        Expect::Anything => {}
    }

    if def.name.trim().is_empty() {
        def.name = def.id.clone();
    }
    def.format = FORMAT.to_string();
    def.version = VERSION;
    // ⚠️ 这一句读的是**旧文件**（要拿它的 updatedAt 做单调修正），
    // 所以只能在 `write_atomic` 之前算 —— 挪到写盘之后就会读到刚写进去的自己。
    def.updated_at = Some(next_updated_at(&path));

    let text = serde_json::to_string_pretty(&def)
        .map_err(|e| SaveError::Invalid(format!("序列化报表失败: {e}")))?;
    write_atomic(&path, &text).map_err(SaveError::Invalid)?;
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
        let saved = save(&dir, def("t1"), Expect::Anything).unwrap();
        assert_eq!(saved.format, FORMAT);
        assert!(saved.updated_at.is_some());

        let loaded = load(&dir, "t1").unwrap();
        assert_eq!(loaded.id, "t1");
        assert_eq!(loaded.name, "报表 t1");
        let _ = delete(&dir, "t1").unwrap();
        assert!(load(&dir, "t1").is_err());
    }

    /// 时间戳的格式化与解析必须**互为逆运算**。
    ///
    /// 期望值是用 Python 的 `datetime` **独立算出来的**，不是我自己推的算术 ——
    /// 这条链路（civil date ↔ 天数）最容易在闰年上悄悄错一天，
    /// 而错一天的后果是排序错乱、单调性判断错乱，都不会报错。
    /// 所以特意挑了 2000-02-29（百年里的闰年例外）和 2100-03-01（不是闰年的百年）
    /// 这两个最能照出 bug 的日子。
    #[test]
    fn 时间戳格式化与解析互为逆运算() {
        let cases: &[(i64, &str)] = &[
            (0, "1970-01-01T00:00:00.000Z"),
            (1_700_000_000_000, "2023-11-14T22:13:20.000Z"),
            (1_709_208_000_500, "2024-02-29T12:00:00.500Z"), // 闰日
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),   // 2000 是闰年
            (4_107_542_400_000, "2100-03-01T00:00:00.000Z"), // 2100 不是闰年
            (1_790_553_599_999, "2026-09-27T23:59:59.999Z"),
        ];
        for (ms, s) in cases {
            assert_eq!(&format_rfc3339_millis(*ms), s, "格式化 {ms} 不对");
            assert_eq!(parse_rfc3339_millis(s), Some(*ms), "解析 {s} 不对");
            // 定宽 24 —— UI 的 `localeCompare` 排序靠的就是它
            assert_eq!(s.len(), 24);
        }
    }

    /// **定宽格式下，字典序必须等于时间序。**
    ///
    /// UI 侧对 `updatedAt` 是**字符串排序**（`TemplateModal.tsx` 的
    /// `localeCompare`、`designer.ts` 的同一个写法），它没有解析这个值。
    /// 所以「格式是不是定宽、位数是不是对齐」直接决定了列表的「最近更新在前」
    /// 是不是真的。这条把这个前提钉住，而不是靠格式字符串看起来对。
    #[test]
    fn 时间戳的字典序等于时间序() {
        let mut pairs: Vec<(i64, String)> =
            [0i64, 999, 1000, 1_700_000_000_000, 1_790_553_599_999, 4_107_542_400_000]
                .iter()
                .map(|v| (*v, format_rfc3339_millis(*v)))
                .collect();
        // 先把输入打乱，否则这条断言只是在复述输入顺序
        pairs.reverse();
        pairs.sort_by(|a, b| a.1.cmp(&b.1));
        let by_str: Vec<i64> = pairs.iter().map(|p| p.0).collect();
        let mut by_num = by_str.clone();
        by_num.sort();
        assert_eq!(by_str, by_num, "字符串排序结果与时间顺序不一致");
    }

    /// 看不懂的时间戳一律 `None`，**绝不许猜一个值**。
    ///
    /// 宽松解析在这里是危险的：这个值要参与乐观锁的相等比对，
    /// 猜出来的值会让比对得出一个**没有意义的结论而且不报错**。
    #[test]
    fn 时间戳解析只认两种定宽形状() {
        // 旧版形状（磁盘上已有的文件）必须继续认，否则升级瞬间锁失效
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
        for bad in [
            "",
            "1970-01-01T00:00:00.000",       // 没有 Z
            "2026-09-27 12:34:56.789Z",      // 空格分隔
            "2026-09-27T12:34:56.789+08:00", // 带偏移
            "2026-09-27T12:34:56.78Z",       // 毫秒位数不对
            "2026-13-01T00:00:00.000Z",      // 月份越界
            "2026-09-27T24:00:00.000Z",      // 小时越界
            "2026-09-27T12:34:56.789Z ",     // 尾随空格
            "2026-09-27T12:34:56.789ZZ",     // 多一个字符
        ] {
            assert_eq!(parse_rfc3339_millis(bad), None, "应当看不懂: {bad:?}");
        }
        // 24 字节但含多字节字符：结构检查过得去，必须靠 `get` 的边界检查
        // 返回 None，而不是在切片上 panic
        let multibyte = format!("20\u{00e9}-09-27T12:34:56.789Z");
        assert_eq!(multibyte.len(), 24);
        assert_eq!(parse_rfc3339_millis(&multibyte), None);
    }

    /// `now_millis` 必须是**毫秒**精度。
    ///
    /// 单靠「单调递增」是抓不住这条的：有 `next_updated_at` 的 `+1ms` 修正，
    /// **秒级时钟也能给出严格递增的 token**，锁照样能用。所以精度是**另一件事**，
    /// 需要单独一条钉子。它的危害在别处：秒级时钟下时间戳会**跑到真实时间前面** ——
    /// 一秒内每存一次就 +1ms，存满 1000 次就超前整整 1 秒，而这个值是要显示给
    /// 人看的（列表里那句「更新于 …」）。毫秒精度下要跑赢它得每秒存 1000 次，
    /// 而每次保存都要写盘，做不到。
    #[test]
    fn 时间戳是毫秒精度() {
        let t0 = now_millis();
        let mut t1 = t0;
        // 等到时钟真的动一下：毫秒精度下通常一两次循环就够
        for _ in 0..20_000_000 {
            t1 = now_millis();
            if t1 != t0 {
                break;
            }
        }
        assert!(t1 > t0, "等了很久时钟都没动，这个测试环境不对劲");
        assert!(
            t1 - t0 < 1000,
            "两次相邻读数差了 {}ms —— 这看着像**秒级**时钟（毫秒被丢掉了）",
            t1 - t0
        );
    }

    /// **同一文件的时间戳严格递增** —— 这是它能当乐观锁版本 token 的前提。
    ///
    /// 这条用例是 #126 的钉子，也是**唯一能区分两种实现**的那条。
    ///
    /// ⚠️ 写法上有个坑：如果只是「连存 8 次、断言各不相同」，那么去掉单调修正
    /// 之后它**可能照样绿** —— 只要这台机器每次保存都超过 1ms，
    /// 8 个「当前时刻」本来就互不相同。那样用例就是**在为空转**：
    /// 绿着，但没测任何东西。所以这里先把旧文件的时间戳塞到**未来 60 秒**，
    /// 于是「新值 = 当前时刻」和「新值 = 旧值 + 1ms」的结果必然不同，
    /// 断言与机器快慢、与时钟精度都无关。
    ///
    /// 后半段才是用户真正会遇到的那个场景（对一份普通文件连存两次），
    /// 它是一道冒烟检查，**不承担举证责任**。
    #[test]
    fn 同一文件连续保存的时间戳严格递增() {
        let dir = tempdir();
        let base = now_millis() + 60_000;
        let mut seed = def("mono");
        seed.updated_at = Some(format_rfc3339_millis(base));
        std::fs::write(
            dir.join("mono.json"),
            serde_json::to_string_pretty(&seed).unwrap(),
        )
        .unwrap();

        let mut stamps: Vec<String> = Vec::new();
        for i in 0..8 {
            let mut d = def("mono");
            d.description = format!("v{i}");
            stamps.push(save(&dir, d, Expect::Anything).unwrap().updated_at.unwrap());
        }
        let got: Vec<i64> = stamps
            .iter()
            .map(|s| parse_rfc3339_millis(s).unwrap())
            .collect();
        let expect: Vec<i64> = (1..=8).map(|i| base + i).collect();
        assert_eq!(
            got, expect,
            "每次保存都必须比上一次大 1ms。基准在未来，所以这里与机器速度无关 —— \
             不满足就说明「取 max(now, 旧值+1ms)」这条修正没了"
        );
        // 落盘的那一份必须是最后一个 —— 否则「严格递增」可能只是内存里的假象
        assert_eq!(
            load(&dir, "mono").unwrap().updated_at.as_deref(),
            Some(stamps.last().unwrap().as_str())
        );

        // 冒烟：对一份普通（时间戳是当下）的文件连存两次，token 必须不同
        let mut d1 = def("fresh");
        d1.description = "a".into();
        let s1 = save(&dir, d1, Expect::Anything).unwrap().updated_at.unwrap();
        let mut d2 = def("fresh");
        d2.description = "b".into();
        let s2 = save(&dir, d2, Expect::Anything).unwrap().updated_at.unwrap();
        assert_ne!(s1, s2, "连存两次拿到同一个 token = 乐观锁静默失效");
    }

    /// 旧文件不存在 / 损坏时不做单调修正：时间戳就是当前时刻。
    ///
    /// 后半段还顺带钉住「坏文件可以被保存覆盖修好」这条恢复路径 ——
    /// 单调修正**不能**把它变成「坏文件存不进去」。
    #[test]
    fn 没有旧文件或旧文件坏了时不做单调修正() {
        let dir = tempdir();
        let before = now_millis();
        let s = save(&dir, def("n1"), Expect::Anything).unwrap().updated_at.unwrap();
        let after = now_millis();
        let t = parse_rfc3339_millis(&s).expect("自家写出来的时间戳必须能被自己解析回来");
        assert!(
            (before..=after).contains(&t),
            "新文件的时间戳应当就是当前时刻，实际 {s}"
        );

        std::fs::write(dir.join("n2.json"), "{ 半个 json").unwrap();
        let s2 = save(&dir, def("n2"), Expect::Anything).unwrap().updated_at.unwrap();
        assert!(parse_rfc3339_millis(&s2).is_some());
        assert_eq!(load(&dir, "n2").unwrap().id, "n2");
    }

    /// **升级路径**：磁盘上已有的文件是**旧版秒级**形状，且时钟可能回拨。
    ///
    /// 这条把两个易漏点一起钉住：
    /// 1. 旧版形状必须被 [`parse_rfc3339_millis`] 认出来，否则升级后第一次保存
    ///    不做单调修正 —— 恰好是一个锁失效的窗口；
    /// 2. 时间戳**比当前时刻晚**（时钟回拨 / 机器时间本来就在未来）时，
    ///    新值必须取「旧值 + 1ms」而不是「当前时刻」—— 否则新 token **倒退**，
    ///    拿到旧 token 的客户端反而比出「一样」或「更新」，直接覆盖别人的改动。
    #[test]
    fn 旧版秒级时间戳的文件升级后仍单调() {
        let dir = tempdir();
        // 造一份「旧版写的」文件：秒级形状 + 时间戳在未来 60 秒
        let future = format_rfc3339_millis(now_millis() + 60_000);
        let legacy = format!("{}Z", &future[..19]);
        assert_eq!(legacy.len(), 20, "这必须是旧版的秒级形状");
        let mut d = def("up1");
        d.updated_at = Some(legacy.clone());
        std::fs::write(
            dir.join("up1.json"),
            serde_json::to_string_pretty(&d).unwrap(),
        )
        .unwrap();

        let saved = save(&dir, def("up1"), Expect::Anything).unwrap();
        let got = parse_rfc3339_millis(saved.updated_at.as_deref().unwrap()).unwrap();
        let old = parse_rfc3339_millis(&legacy).unwrap();
        assert_eq!(
            got,
            old + 1,
            "旧版秒级时间戳没被认出来（或时钟回拨时退回了当前时刻）→ token 会撞车/倒退"
        );
        // 文件确实被覆盖了，不是「为了保时间戳而没写」
        assert_eq!(load(&dir, "up1").unwrap().name, "报表 up1");
    }

    /// **原子性的可判定面**：写盘中途失败时，目标文件必须仍是**旧的完整内容**。
    ///
    /// 「进程写到一半被杀」单测造不出来（要能杀进程 —— 那条由真机探针
    /// `scripts/verify-atomic-save.py` 用 `RLIMIT_FSIZE` + SIGXFSZ 覆盖），
    /// 但「写入失败」能造：把 `.tmp` 的路径预先占成一个**目录**，
    /// `fs::write` 就会 `EISDIR` 失败。
    ///
    /// 这条用例的真正价值是**它能区分两种实现** —— 非原子版
    /// （`fs::write` 直接写目标文件）根本不碰 `.tmp`，于是这次 save 会**成功**
    /// 并把旧内容换成新内容，`save(...).is_err()` 当场红。
    /// 「旧内容有没有被保住」这件事因此被钉住了，而不是靠读代码相信。
    #[test]
    fn 写入失败时目标文件仍是旧的完整内容() {
        let dir = tempdir();
        let mut v1 = def("t2");
        v1.description = "v1".to_string();
        let saved_v1 = save(&dir, v1, Expect::Anything).unwrap();

        // 占住 `.tmp` 这个名字，逼 write_atomic 的写盘失败
        std::fs::create_dir_all(dir.join("t2.json.tmp")).unwrap();

        let mut v2 = def("t2");
        v2.description = "v2".to_string();
        /*
         * ⚠️ **断言到变体，不只是 `is_err()`。**
         *
         * 这条用例要的是「写盘失败」。如果只断言 `is_err()`，那么**把这次调用
         * 改成 `Expect::Absent` 之后它照样绿** —— 但那时报的是 `Conflict`（目标已存在），
         * 跟写盘失败毫无关系：`.tmp` 那个目录占位**根本没被碰到**，
         * 「旧内容被保住了」于是变成一个空头结论。用例绿着，测的东西没了。
         * 所以这里把「必须是 Invalid」写死 —— 它同时钉住了
         * 「`.tmp` 占位确实生效」和「这道闸没有把写盘错误误报成覆盖冲突」。
         */
        match save(&dir, v2, Expect::Anything) {
            Err(SaveError::Invalid(_)) => {}
            Err(SaveError::Conflict(m)) => panic!(
                "报成了「目标已存在」（{m}）—— 那就测不到写盘失败了，\
                 这条用例在为错的理由变绿"
            ),
            Err(SaveError::Stale { .. }) => panic!(
                "报成了「版本对不上」—— 但这次调用带的是 Expect::Anything，\
                 根本没有 base 可比。说明闸判错了前提"
            ),
            Ok(_) => panic!("写不进去时必须报错，不能假装成功"),
        }

        let after = load(&dir, "t2")
            .expect("目标文件必须还能解析 —— 这正是原子写要保的东西");
        assert_eq!(after.description, "v1", "旧内容被写坏了");
        /*
         * 时间戳也必须还是旧的那个。
         *
         * 这一条是**为了钉住一个被写错的结论**：`save` 里那句
         * `def.updated_at = Some(…)` 是在写盘**之前**执行的，
         * 曾经据此断言过「崩了以后文件带着旧时间戳 → 从列表看不出这次保存失败过」。
         * 前半句对，**后半句的推论是错的** —— 那个赋值改的是个局部变量，
         * 写失败时 `def` 直接被丢弃；而失败本身会以 `Err` 的形式返回给调用方
         * （HTTP 400 / 前端弹错误）。所以它是「可见的数据丢失」，不是静默失败。
         *
         * 断言在这里的价值：把「失败时不可能出现『新时间戳 + 旧内容』这种半更新状态」
         * **写明白**。它其实是上面「逐字节没变」的**推论**，不是独立证据 ——
         * 但那条更正值得有一行代码替它站台，而不是只活在文档里。
         */
        assert_eq!(
            after.updated_at, saved_v1.updated_at,
            "写失败却动了时间戳 = 出现「半更新」的文件"
        );
    }

    /// 覆盖时留一份上一版 —— 这是「改错了想退回去」的唯一退路。
    #[test]
    fn 覆盖时留下上一版备份() {
        let dir = tempdir();
        let mut v1 = def("t3");
        v1.description = "v1".to_string();
        save(&dir, v1, Expect::Anything).unwrap();
        // 首次保存没有「上一版」，不该凭空造一个
        assert!(!dir.join("t3.json.bak").exists(), "首存不该有 .bak");

        let mut v2 = def("t3");
        v2.description = "v2".to_string();
        save(&dir, v2, Expect::Anything).unwrap();

        assert_eq!(load(&dir, "t3").unwrap().description, "v2");
        let bak = dir.join("t3.json.bak");
        assert!(bak.exists(), "覆盖后必须留下上一版");
        let old: ReportDef =
            serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(old.description, "v1", ".bak 里应是上一版，不是刚写的这份");
    }

    /// 保存成功后不能留下 `.tmp`。
    #[test]
    fn 保存成功后不残留临时文件() {
        let dir = tempdir();
        save(&dir, def("t4"), Expect::Anything).unwrap();
        assert!(!dir.join("t4.json.tmp").exists(), ".tmp 必须被 rename 吃掉");
        assert!(!dir.join("t4.json.bak").exists(), "首存不该有 .bak");
    }

    /// `.bak` / `.tmp` **不能出现在报表列表里**。
    ///
    /// 这是引入原子写时**新长出来**的风险：`list()` 的判据是
    /// `path.extension() == Some("json")`，而 `foo.json.bak` 的扩展名是 `bak`，
    /// 所以天然被跳过 —— 但**改成 `file_name().ends_with(".json")` 就会漏**，
    /// 那时用户会在列表里看到一份「id 对、内容是上一版」的幽灵报表。
    #[test]
    fn 备份与临时文件不进报表列表() {
        let dir = tempdir();
        save(&dir, def("t5"), Expect::Anything).unwrap();
        let mut v2 = def("t5");
        v2.description = "v2".to_string();
        save(&dir, v2, Expect::Anything).unwrap(); // 这一步会生成 t5.json.bak

        // 再手工塞一个残留的 .tmp（模拟上次崩在写盘中途）
        std::fs::write(dir.join("t5.json.tmp"), "{ 半个 json").unwrap();

        let items = list(&dir).unwrap();
        assert_eq!(
            items.len(),
            1,
            "列表里多出了条目：{:?}",
            items.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
        );
        assert_eq!(items[0].id, "t5");
    }

    /// **服务端那道闸**：`Expect::Absent` 而目标已存在时必须拒绝，且**什么都不许动**。
    ///
    /// 这条用例真正钉的是「拒绝 = 零副作用」：不只要求返回 `Conflict`，
    /// 还要求旧内容**逐字节没变**、且没留下 `.bak`（`write_atomic` 一旦被调用
    /// 就会备份，所以「没有 .bak」等价于「根本没走到写盘那一步」）。
    #[test]
    fn 目标已存在时_要求不存在则拒绝且不碰文件() {
        let dir = tempdir();
        let mut v1 = def("t6");
        v1.description = "v1".to_string();
        let saved_v1 = save(&dir, v1, Expect::Anything).unwrap();

        let mut v2 = def("t6");
        v2.description = "v2".to_string();
        match save(&dir, v2, Expect::Absent) {
            Err(SaveError::Conflict(_)) => {}
            other => panic!("应当报 Conflict，实际 {other:?}"),
        }

        let after = load(&dir, "t6").unwrap();
        assert_eq!(after.description, "v1", "被拒绝了却还是把内容换掉了");
        assert_eq!(after.updated_at, saved_v1.updated_at, "被拒绝了却动了时间戳");
        assert!(
            !dir.join("t6.json.bak").exists(),
            "被拒绝的保存不该留下备份 —— 有 .bak 说明它其实已经动过盘了"
        );
    }

    /// 目标不存在时 `Expect::Absent` 就是正常新建（别把闸做成「什么都存不了」）。
    #[test]
    fn 目标不存在时_要求不存在就正常落盘() {
        let dir = tempdir();
        let saved = save(&dir, def("t7"), Expect::Absent).unwrap();
        assert_eq!(saved.id, "t7");
        assert_eq!(load(&dir, "t7").unwrap().id, "t7");
    }

    /// **反静默绕过**：判据和落盘必须用**同一个** id。
    ///
    /// `save` 会把 id 去空白，所以 `" t8 "` 落盘成 `t8.json`。
    /// 如果闸拿**没去空白**的 id 去查存在性（`" t8 .json"`），
    /// 它会判定「不存在」→ 放行 → 覆盖掉已有的 `t8.json`。
    /// **不报错、不警告，安静地毁数据。**
    /// 这条用例是那个场景的钉子：把 trim 只留在一处（[`normalise_id`]）才绿。
    #[test]
    fn 要求不存在时_判据与落盘同口径() {
        let dir = tempdir();
        save(&dir, def("t8"), Expect::Anything).unwrap();

        let mut v2 = def("t8");
        v2.id = "  t8  ".to_string(); // 带空白，归一化后仍是 t8
        v2.description = "v2".to_string();
        match save(&dir, v2, Expect::Absent) {
            Err(SaveError::Conflict(_)) => {}
            other => panic!("带空白的 id 没被认成同一个目标，实际 {other:?}"),
        }
        assert_eq!(load(&dir, "t8").unwrap().description, "");
    }

    /* ---------------------- 乐观锁（Expect::Base） ---------------------- */

    /// **版本相符 → 保存成功，并且换出一个新版本。**
    ///
    /// 后半句才是重点：如果保存之后 `updatedAt` 没变，客户端把响应里的
    /// 新版本回填成下一次的 `base` 之后，**下一次保存会拿一个和当前相同的版本
    /// 去比，然后被自己的上一次覆盖动作判成「没变过」** —— 看着能用，
    /// 直到有人真的并发改了一次。所以「保存后 token 必须变」是这条链的前提。
    #[test]
    fn 版本相符时保存成功且换出新版本() {
        let dir = tempdir();
        let v1 = save(&dir, def("cas1"), Expect::Anything).unwrap();
        let base = v1.updated_at.clone().unwrap();

        let mut v2 = def("cas1");
        v2.description = "v2".into();
        let saved = save(&dir, v2, Expect::Base(base.clone())).unwrap();

        assert_eq!(saved.description, "v2");
        assert_eq!(load(&dir, "cas1").unwrap().description, "v2", "版本对上了却没写盘");
        assert_ne!(
            saved.updated_at.as_deref(),
            Some(base.as_str()),
            "保存后版本号没变 —— 客户端回填 base 之后会永远撞自己"
        );
    }

    /// **版本不符 → `Stale`，且一个字节都不许碰。**
    ///
    /// 同时钉住 412 响应体的两个字段：`expected` 必须是**调用方声明的**版本
    /// （不然 UI 没法说「你手上是 X」），`actual` 必须是**服务端当前的**版本
    /// （不然 UI 只能说「对不上」，用户不知道对不上什么）。
    #[test]
    fn 版本不符时报过期_且一个字节都不碰() {
        let dir = tempdir();
        let v1 = save(&dir, def("cas2"), Expect::Anything).unwrap();
        let stale_base = v1.updated_at.clone().unwrap();
        // 模拟「别人又存了一次」：服务端版本往前走
        let v2 = save(&dir, def("cas2"), Expect::Anything).unwrap();
        let current = v2.updated_at.clone().unwrap();
        assert_ne!(stale_base, current, "两次保存必须给出不同版本，否则这条用例没意义");

        let before = std::fs::read(dir.join("cas2.json")).unwrap();
        // ⚠️ 上面 `v2` 那次覆盖**自己会留下一个 `.bak`**。不清掉它的话，
        // 「有没有 .bak」就再也回答不了「这次被拒绝的保存动没动过盘」——
        // 那条断言会变成在测**前面那次保存**，跟这次毫无关系。
        // （第一版就是这么写的，一跑就红：`.bak` 一直在。）
        // 判据必须只由被测机制决定，所以这里先把它清掉，再断言它不重新出现。
        let bak = dir.join("cas2.json.bak");
        assert!(bak.exists(), "前提没搭对：v2 那次覆盖本该留下 .bak");
        std::fs::remove_file(&bak).unwrap();

        let mut mine = def("cas2");
        mine.description = "我的改动".into();
        match save(&dir, mine, Expect::Base(stale_base.clone())) {
            Err(SaveError::Stale { expected, actual }) => {
                assert_eq!(expected, stale_base, "412 没回传「调用方声明的版本」");
                assert_eq!(
                    actual.as_deref(),
                    Some(current.as_str()),
                    "412 没回传「服务端当前版本」—— UI 就没法告诉用户对不上什么"
                );
            }
            other => panic!("应当报 Stale，实际 {other:?}"),
        }

        assert_eq!(
            std::fs::read(dir.join("cas2.json")).unwrap(),
            before,
            "被拒绝的保存把文件改了"
        );
        assert!(
            !bak.exists(),
            "被拒绝的保存留下了 .bak —— 说明它其实已经动过盘了"
        );
    }

    /// **`base` 指向的文件不存在 → `Stale`，不是「当成新建放过去」。**
    ///
    /// 这两个分支是一对，很容易只写一半：只判「文件在且版本不符」，
    /// 那么「文件不在」会掉进 else 直接落盘 —— 等于拿一份**基础已经不存在**的
    /// 内容凭空新建，与乐观锁的意图正好相反（用户以为在更新，其实在造副本）。
    #[test]
    fn 基准指向的文件不存在时报过期_而不是当成新建() {
        let dir = tempdir();
        match save(
            &dir,
            def("cas3"),
            Expect::Base("2026-09-27T12:00:00.000Z".into()),
        ) {
            Err(SaveError::Stale { actual, .. }) => {
                assert_eq!(actual, None, "文件不存在时 actual 必须是 None，不能瞎编一个版本")
            }
            other => panic!("应当报 Stale（基础已没了），实际 {other:?}"),
        }
        assert!(
            !dir.join("cas3.json").exists(),
            "被拒绝的保存不该凭空造出文件"
        );
    }

    /// **`Expect::Anything` 永远不报版本冲突** —— 它是「用户已经点了覆盖」那条路，
    /// 报 412 会把用户堵在一个**点了也没用**的框里。
    #[test]
    fn 要求覆盖时_永不报版本冲突() {
        let dir = tempdir();
        save(&dir, def("any1"), Expect::Anything).unwrap();
        let mut d = def("any1");
        d.description = "覆盖".into();
        save(&dir, d, Expect::Anything).unwrap();
        assert_eq!(load(&dir, "any1").unwrap().description, "覆盖");

        // ⚠️ 请求体里那个 `updatedAt` **不是版本声明** —— 它是要落盘的字段，
        // 任何人都能自己填。真正的版本声明只有查询串里的 `base`（handler 层）。
        // 这条钉住「body 里的 updatedAt 不参与比对」，否则客户端随手填一个旧值
        // 就能把自己锁在 412 上，或者更糟：填个对的值绕过版本检查。
        let mut d2 = def("any1");
        d2.updated_at = Some("1970-01-01T00:00:00.000Z".into());
        save(&dir, d2, Expect::Anything)
            .expect("body 里的 updatedAt 不是版本声明，不该参与比对");
    }

    /// **客户端回填新版本当 base，可以接着存** —— 这是 UI 的真实流程。
    ///
    /// 少了「保存成功后把响应里的 `updatedAt` 回填成新的 `base`」这一步，
    /// **第二次保存会拿旧的 base 去比，然后 412 自己**。这条用例在服务端这一侧
    /// 把那个流程走通（UI 侧那条在 `grid-report-save-confirm.spec.tsx` 里）。
    #[test]
    fn 用响应里的新版本当_base_可以接着存() {
        let dir = tempdir();
        let s1 = save(&dir, def("cas4"), Expect::Anything).unwrap();
        let s2 = save(
            &dir,
            def("cas4"),
            Expect::Base(s1.updated_at.clone().unwrap()),
        )
        .unwrap();

        // 回填：客户端拿响应里的 updatedAt 当下一次的 base
        let mut d = def("cas4");
        d.description = "第三次".into();
        let s3 = save(&dir, d, Expect::Base(s2.updated_at.clone().unwrap())).unwrap();

        assert_eq!(s3.description, "第三次");
        assert_eq!(load(&dir, "cas4").unwrap().description, "第三次");
    }

    /// **三种失败必须是三个不同的变体** —— UI 靠变体决定弹哪个框。
    ///
    /// 这条看着像废话，但它钉的是一个**很容易发生的退化**：把 `SaveError`
    /// 改回「一个 `String` 消息」，那时三种失败的文案可能不同、类型却只有一个，
    /// UI 就只能靠匹配文案分支 —— 文案一改（哪怕加个标点）就静默退化。
    /// 下面故意让三种的**文案完全相同**，此时仍然必须互不相等。
    #[test]
    fn 三种失败互不相等_界面才能按变体分支() {
        let same = "同样的文案".to_string();
        let invalid = SaveError::Invalid(same.clone());
        let conflict = SaveError::Conflict(same.clone());
        let stale = SaveError::Stale {
            expected: same.clone(),
            actual: Some(same.clone()),
        };
        assert_ne!(invalid, conflict, "「请求不合法」和「目标已存在」被判成了同一种");
        assert_ne!(conflict, stale, "「目标已存在」和「版本对不上」被判成了同一种");
        assert_ne!(invalid, stale);
        // 给人看的那句话也要说得清是哪种 —— 用户看到的只有它
        assert_ne!(conflict.message(), stale.message());
        assert!(stale.message().contains(&same), "Stale 的话里要带上调用方手上的版本");
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
        save(&dir, def("r1"), Expect::Anything).unwrap();

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
        save(&dir, def("ok1"), Expect::Anything).unwrap();
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
    /// **真正的唯一性来自那个原子计数器 `n`**，不是时间戳 —— 时间戳现在虽然到
    /// 毫秒了，但「同一毫秒内起两个用例」依然可能（cargo test 是并行的）。
    /// 这里曾经栽过：第一版只用时间戳（当年还只到秒）命名，`列表面` 于是
    /// 数出 4 个文件而不是 2 个 —— 用例互相看见对方的文件。
    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "op-reports-{}-{}-{}",
            std::process::id(),
            format_rfc3339_millis(now_millis()).replace(':', "-"),
            n
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
