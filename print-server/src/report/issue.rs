//! 渲染诊断的**分级通道**。
//!
//! ## 为什么需要分级
//!
//! 原来只有一条通道：`Engine.warnings: Vec<String>`。它的问题不是「信息不够」，
//! 而是**分不出严重程度** —— 下面两类消息混在同一个 `Vec<String>` 里：
//!
//! | 类别 | 例子 | 调用方该做什么 |
//! | --- | --- | --- |
//! | **提示** | `export_formula` 翻不成 Excel 公式，已回落写值 | 展示即可，结果是对的 |
//! | **结果不可信** | 落位冲突（整格数据被丢掉）、非收敛（汇总与明细口径不一致） | **拦住导出**，别让作者当成品发出去 |
//!
//! 混在一起时前端只有两个选择：全弹（提示把真问题淹掉）或全不弹（真问题看不见）。
//! 评审那句「让错误结果不能被当成成功结果」，落到代码上就是这条分级。
//!
//! ## 与 TS 侧既有约定的关系
//!
//! 画布/排版层（`openprint/src/core/layout-engine/types.ts`）早就有
//! `RenderWarning { code, message, controlId? }` —— 即「带稳定 code 的结构化告警」。
//! 这里的 `Issue` 是同一套思路在**服务端报表引擎**这一侧的落地，
//! 多出来的 `level` 就是本文开头那张表的差别。
//!
//! ## 向后兼容
//!
//! `RenderResponse.warnings` **保留**（`Engine::warnings()` 现在返回
//! 「`level >= Warning` 的 message 视图」），所以：
//!
//! - 既有调用方（含设计器里读 `data.warnings` 的那段）**零改动**；
//! - `Error` 一定也在 `warnings` 里 —— 升级级别**不会**让任何消息消失；
//! - `Info` 只进 `issues`，不进 `warnings`（它按定义就不该打扰人）。

use serde::{Deserialize, Serialize};

/// 诊断级别。`Ord` 是有意的：`level >= IssueLevel::Warning` 就是
/// 「这条要进 `warnings`」的判据，加级别时不用改过滤逻辑。
///
/// ⚠️ **对外的级别字符串只有一处真相源**：下面那个 `serde(rename_all = "lowercase")`。
/// 不要另外写一个 `as_str()` 之类的函数去拼同样的字符串 ——
/// 那种「同一份事实声明两遍」正是本项目反复踩过的漂移来源。
/// 需要字符串时用 `serde_json::to_value`，或者直接匹配这个枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueLevel {
    /// 诊断信息。**不影响结果正确性**，不进 `warnings`。
    Info,
    /// 某处降级了，但结果按预期出（回落写值、某格按空值输出……）。
    Warning,
    /// **这张表的结果不可信**。调用方应当拦住导出 / 显著提示。
    Error,
}

/// 一条诊断。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    pub level: IssueLevel,
    /// **稳定标识**，前端据此分类 / 定位 / 决定弹什么。
    ///
    /// 刻意与 `message` 分开：文案会改（改得更清楚、加标点、换措辞），
    /// 而前端**不该**靠 `message.contains(..)` 判断严重程度 ——
    /// 那种判据在文案一改就静默失效，正是本项目最怕的失败形态。
    ///
    /// 取值见本模块末尾的 `CODE_*` 常量（有钉子测试盯着，加了要同步 TS 的 `IssueCode`）。
    pub code: String,
    /// 出问题的 sheet 名。多 sheet 模板、或 `loop_field` 展开成多张表时用得上
    /// （`RenderResponse.issues` 是**整份响应**级别的，不带这个字段就无法归属）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    /// 出问题的格子**模板坐标**（如 `"B3"`）。能定位到格就填，定位不到（整表级）就不填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
    pub message: String,
}

impl Issue {
    pub fn new(level: IssueLevel, code: &str, message: impl Into<String>) -> Self {
        Issue { level, code: code.to_string(), sheet: None, pos: None, message: message.into() }
    }

    pub fn with_pos(mut self, pos: impl Into<String>) -> Self {
        self.pos = Some(pos.into());
        self
    }

    pub fn with_sheet(mut self, sheet: impl Into<String>) -> Self {
        self.sheet = Some(sheet.into());
        self
    }

    /// 这条要不要进 `warnings`（向后兼容视图）
    pub fn is_warning_or_worse(&self) -> bool {
        self.level >= IssueLevel::Warning
    }
}

/// 往诊断列表里记一条 —— **字段级**借用的薄包装。
///
/// ## 为什么不能只用 `Engine::warn(&mut self, ..)`
///
/// `expand_sheet` 里有好几处形如 `for inst in self.insts.iter() { … }` 的循环，
/// 循环体里又要记诊断。`Engine::warn(&mut self, ..)` 借的是**整个 `*self`**，
/// 与 `self.insts` 那个仍然活着的不可变借用冲突 —— 实测 **6 处 E0502**。
/// 而 `&mut self.issues` 只借**一个字段**（字段间借用是分离的），合法。
///
/// 所以这个包装的存在理由是**借用粒度**，不是抽象：它让字段级借用也有可读的调用点。
/// 用法是**临时值**（`IssueSink(&mut self.issues).warn(..)`），
/// 这样借用只活在那一条语句里，不会挡住同一作用域内对 `&self` 方法的调用。
pub struct IssueSink<'a>(pub &'a mut Vec<Issue>);

impl IssueSink<'_> {
    /// 通用告警（还没细分的旧站点）
    pub fn warn(&mut self, message: impl Into<String>) {
        self.0.push(Issue::new(IssueLevel::Warning, CODE_GENERIC, message));
    }

    pub fn warn_at(&mut self, code: &str, pos: impl Into<String>, message: impl Into<String>) {
        self.0.push(Issue::new(IssueLevel::Warning, code, message).with_pos(pos));
    }

    /// **结果不可信**（见 `IssueLevel::Error`）
    pub fn fail_at(&mut self, code: &str, pos: Option<String>, message: impl Into<String>) {
        let mut it = Issue::new(IssueLevel::Error, code, message);
        it.pos = pos;
        self.0.push(it);
    }

    /// 纯诊断（不进 `warnings`）
    pub fn info(&mut self, code: &str, message: impl Into<String>) {
        self.0.push(Issue::new(IssueLevel::Info, code, message));
    }
}

// ───────────────────────── code 词表 ─────────────────────────
//
// **每个 code 都要有生产者**，否则就是死字符串。
// `codes_table_is_pinned_and_names_the_ts_mirror` 盯着这张表，
// 改了要同步 `openprint/src/report/grid-report.ts` 的 `IssueCode`。

/// 落位冲突：两个实例落在同一格，后到的被丢弃（见 `expand_sheet` 的占用检查）
pub const CODE_LAYOUT_COLLISION: &str = "layout_collision";
/// 非收敛：`row_test` / `col_test` 在 MAX_ROUNDS 内没稳定下来
pub const CODE_NONCONVERGENT: &str = "nonconvergent";
/// 不动点需要 >= 3 轮才稳定 —— 条件之间互相依赖，改模板时要小心（**Info 级**）
pub const CODE_FIXPOINT_ROUNDS: &str = "fixpoint_rounds";
/// 列主格跨数据集：列主格的展开行号只在它自己那份数据集里有意义，按行号求交会静默丢数
pub const CODE_CROSS_DS_COL_PARENT: &str = "cross_ds_col_parent";
/// 组内多键：`join_on` 的字段 ≠ 父格的分组字段，组内有多个键值，已按**并集**关联
pub const CODE_JOIN_KEY_NOT_GROUPED: &str = "join_key_not_grouped";
/// 通用告警：还没细分的旧告警站点都走这个（逐个升级，别一次全动）
pub const CODE_GENERIC: &str = "generic";

#[cfg(test)]
mod tests {
    use super::*;

    /// 级别顺序即「要不要进 warnings」的判据，别改反。
    #[test]
    fn level_order_matches_severity() {
        assert!(IssueLevel::Info < IssueLevel::Warning);
        assert!(IssueLevel::Warning < IssueLevel::Error);
        assert!(!Issue::new(IssueLevel::Info, "x", "m").is_warning_or_worse());
        assert!(Issue::new(IssueLevel::Warning, "x", "m").is_warning_or_worse());
        assert!(Issue::new(IssueLevel::Error, "x", "m").is_warning_or_worse());
    }

    /// code 词表钉子：改名 / 增删都要在这里显形，
    /// 并提醒同步 TS（`mirror-check.py` 不覆盖这个常量，只能靠这条测试）。
    ///
    /// 刻意**不**另设一个 `CODES` 常量再钉它 —— 那会多一份「同一份事实的第二个声明」。
    /// 直接钉这些常量**本身的值**：改了值这里就红。
    #[test]
    fn codes_table_is_pinned_and_names_the_ts_mirror() {
        assert_eq!(
            vec![
                CODE_LAYOUT_COLLISION,
                CODE_NONCONVERGENT,
                CODE_FIXPOINT_ROUNDS,
                CODE_CROSS_DS_COL_PARENT,
                CODE_JOIN_KEY_NOT_GROUPED,
                CODE_GENERIC,
            ],
            vec![
                "layout_collision",
                "nonconvergent",
                "fixpoint_rounds",
                "cross_ds_col_parent",
                "join_key_not_grouped",
                "generic",
            ],
            "Issue code 词表变了：要同步 TS 的 IssueCode（openprint/src/report/grid-report.ts）"
        );
    }

    /// 序列化形状就是**对外契约**：level 是小写字符串，可选字段缺省时**不出现在 JSON 里**
    /// （前端 `'pos' in issue` 之类的判据才不会看到 null）。
    #[test]
    fn serializes_level_as_lowercase_and_omits_absent_optionals() {
        let i = Issue::new(IssueLevel::Error, CODE_LAYOUT_COLLISION, "撞了")
            .with_pos("B3")
            .with_sheet("主表");
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["level"], "error");
        assert_eq!(v["code"], "layout_collision");
        assert_eq!(v["pos"], "B3");
        assert_eq!(v["sheet"], "主表");
        assert_eq!(v["message"], "撞了");

        let bare = Issue::new(IssueLevel::Info, CODE_GENERIC, "m");
        let v = serde_json::to_value(&bare).unwrap();
        assert!(v.get("pos").is_none(), "没 pos 时不该出现 pos 键：{v}");
        assert!(v.get("sheet").is_none(), "没 sheet 时不该出现 sheet 键：{v}");
        assert_eq!(v["level"], "info");
    }
}
