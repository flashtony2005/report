//! 单元格表达式：词法 + 语法分析（纯语法层，不依赖引擎状态）
//!
//! 支持的语法（优先级由低到高）：
//!
//! ```text
//! cmp     := add (('>=' | '<=' | '==' | '!=' | '>' | '<') add)*
//! add     := mul (('+' | '-') mul)*
//! mul     := unary (('*' | '/') unary)*
//! unary   := '-' unary | primary
//! primary := number | string | '(' cmp ')' | call | cellref
//! call    := IDENT '(' [cmp (',' cmp)*] ')'
//! cellref := IDENT [ '[' COORD ']' ] [ '.' ( FUNC '(' ')' | 'expandIndex' ) ]
//! ```
//!
//! 设计上对齐 NopReport：层次坐标 `D3[B2:+0]` 在求值时返回一个**格集**，
//! 由调用方决定是当集合用（SUM 遍历）还是取首格的值（参与四则运算）。
//! 因此 `C4 / C4[B4:-1]` 这类环比写法无需额外的 `{}` 语法。

use std::fmt;

/// 单元格引用上的 `.xxx` 后缀
#[derive(Debug, Clone, PartialEq)]
pub enum Prop {
    /// 聚合后缀，如 `.sum()` / `.count()`；值为 `func_of` 的返回值
    Aggregate(&'static str),
    /// `.expandIndex`：当前格在其主格下的序号（等价润乾的 `&A2`）
    ExpandIndex,
}

/// 层次坐标：`B3` / `B3:1`（绝对）/ `B3:+0` / `B3:-1`（相对）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Coord {
    pub pos: String,
    pub position: Option<i64>,
    pub relative: bool,
    pub reverse: bool,
}

impl Coord {
    /// 解析 `B3` / `B3:1` / `B3:+0` / `B3:-1`
    pub fn parse(s: &str) -> Self {
        let mut parts = s.splitn(2, ':');
        let pos = parts.next().unwrap_or("").trim().to_string();
        let mut c = Coord { pos, position: None, relative: false, reverse: false };
        if let Some(p) = parts.next() {
            let p = p.trim();
            let (rel, body) = if let Some(rest) = p.strip_prefix('+') { (true, rest) } else { (false, p) };
            if let Ok(n) = body.parse::<i64>() {
                c.position = Some(n);
                c.relative = rel || n < 0;
                c.reverse = n < 0;
            }
        }
        c
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CmpOp {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    Ne,
}

/// 表达式语法树
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    /// 单元格引用（可带层次坐标与后缀）
    Cell { target: String, coord: Option<Coord>, prop: Option<Prop> },
    /// 函数调用，`IF` / `SUM` / `PROPORTION` 等
    Call { name: String, args: Vec<Expr> },
    /// `value`：指代本格自身的值，仅 `format_expr` 里有意义
    ///（`value_expr` 里写它会自引用，求值时按 Null 处理）
    SelfValue,
    Binary { op: BinOp, lhs: Box<Expr>, rhs: Box<Expr> },
    Cmp { op: CmpOp, lhs: Box<Expr>, rhs: Box<Expr> },
    Neg(Box<Expr>),
    /// 格集过滤：`POS[COORD]{条件}`。
    ///
    /// 条件以**候选格**为上下文求值（润乾语义）：裸 `B2` 指候选格的 B2 主格。
    /// 这是坐标定位不到时唯一能精确定位的手段，如「月份不连续时找去年同月」。
    Filter { cell: Box<Expr>, cond: Box<Expr> },
    /// `$POS`：条件表达式里取**当前格**的主格（裸 `POS` 取的是候选格的主格）。
    /// 润乾经典写法 `C2 - C2[A2:-1]{$B2==B2}` 就靠它区分两个上下文。
    Dollar(Box<Expr>),
    /// 数组字面量 `["1月","2月"]`，供 `expand_expr` 声明固定展开集。
    ///
    /// 只在**展开期**求值，此时层次坐标尚未建立，所以元素只允许是常量
    /// （`Num` / `Str`）。出现格引用或函数调用一律报错，不静默当空数组。
    Array(Vec<Expr>),
}

#[derive(Debug, Clone)]
pub struct ParseError(pub String);

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "表达式解析失败: {}", self.0)
    }
}

/// 解析整个表达式字符串
pub fn parse(input: &str) -> Result<Expr, ParseError> {
    let mut p = Parser::new(input);
    let e = p.parse_cmp().map_err(ParseError)?;
    p.ws();
    if !p.at_end() {
        return Err(ParseError(format!("尾部有多余内容: {:?}", p.rest())));
    }
    Ok(e)
}

/// 从 `.sum()` 这类后缀取出聚合函数名；认不出就返回 None（由调用方报错，
/// 避免把 `.bogus()` 静默降级成「取首格的值」）
pub fn func_of(s: &str) -> Option<&'static str> {
    let name: String = s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    match name.as_str() {
        "sum" => Some("sum"),
        "count" => Some("count"),
        "avg" => Some("avg"),
        "min" => Some("min"),
        "max" => Some("max"),
        _ => None,
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser { s: s.as_bytes(), i: 0 }
    }

    fn at_end(&self) -> bool {
        self.i >= self.s.len()
    }
    fn rest(&self) -> &str {
        std::str::from_utf8(&self.s[self.i..]).unwrap_or("")
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn eat_str(&mut self, tok: &str) -> bool {
        if self.s[self.i..].starts_with(tok.as_bytes()) {
            self.i += tok.len();
            true
        } else {
            false
        }
    }
    fn err(&self, msg: impl Into<String>) -> Result<Expr, String> {
        Err(format!("{} @{}", msg.into(), self.i))
    }

    fn parse_cmp(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_add()?;
        loop {
            self.ws();
            // 注意：单字符分支必须用 eat 消耗掉，否则会停在原地把运算符当成新表达式开头
            let op = if self.eat_str(">=") {
                CmpOp::Ge
            } else if self.eat_str("<=") {
                CmpOp::Le
            } else if self.eat_str("==") {
                CmpOp::Eq
            } else if self.eat_str("!=") {
                CmpOp::Ne
            } else if self.eat(b'>') {
                CmpOp::Gt
            } else if self.eat(b'<') {
                CmpOp::Lt
            } else {
                break;
            };
            let rhs = self.parse_add()?;
            lhs = Expr::Cmp { op, lhs: Box::new(lhs), rhs: Box::new(rhs) };
        }
        Ok(lhs)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_mul()?;
        loop {
            self.ws();
            let op = if self.eat(b'+') {
                BinOp::Add
            } else if self.eat(b'-') {
                BinOp::Sub
            } else {
                break;
            };
            let rhs = self.parse_mul()?;
            lhs = Expr::Binary { op, lhs: Box::new(lhs), rhs: Box::new(rhs) };
        }
        Ok(lhs)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_unary()?;
        loop {
            self.ws();
            let op = if self.eat(b'*') {
                BinOp::Mul
            } else if self.eat(b'/') {
                BinOp::Div
            } else {
                break;
            };
            let rhs = self.parse_unary()?;
            lhs = Expr::Binary { op, lhs: Box::new(lhs), rhs: Box::new(rhs) };
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        self.ws();
        if self.eat(b'-') {
            return Ok(Expr::Neg(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        self.ws();
        if self.at_end() {
            return self.err("表达式意外结束");
        }
        let c = self.peek().unwrap();

        if self.eat(b'(') {
            let e = self.parse_cmp()?;
            self.ws();
            if !self.eat(b')') {
                return self.err("缺少右括号");
            }
            return Ok(e);
        }
        if c.is_ascii_digit() || (c == b'.' && self.s.get(self.i + 1).map_or(false, |n| n.is_ascii_digit())) {
            return self.parse_number();
        }
        if c == b'\'' || c == b'"' {
            return self.parse_string();
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            return self.parse_ident();
        }
        // `[` 在**primary 位置**上只可能是数组字面量：层次坐标的 `[` 永远紧跟
        // 在格名之后（`B2[A2:-1]`），由 `parse_ident` 消费，走不到这里。
        if self.eat(b'[') {
            let mut items = Vec::new();
            loop {
                self.ws();
                if self.eat(b']') {
                    break;
                }
                if self.at_end() {
                    return self.err("数组字面量缺少 ]");
                }
                items.push(self.parse_cmp()?);
                self.ws();
                if self.eat(b',') {
                    continue;
                }
                if self.eat(b']') {
                    break;
                }
                return self.err("数组字面量的元素之间缺少 ,");
            }
            return Ok(Expr::Array(items));
        }
        // `$POS`：只在条件表达式里有意义（取当前格的主格），别处等价于裸 POS
        if self.eat(b'$') {
            self.ws();
            let inner = self.parse_primary()?;
            return Ok(Expr::Dollar(Box::new(inner)));
        }
        self.err(format!("无法识别的字符 {:?}", c as char))
    }

    fn parse_number(&mut self) -> Result<Expr, String> {
        let start = self.i;
        while self.peek().map_or(false, |c| c.is_ascii_digit()) {
            self.i += 1;
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            while self.peek().map_or(false, |c| c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("0");
        text.parse::<f64>().map(Expr::Num).map_err(|e| format!("数字解析失败 {text}: {e}"))
    }

    fn parse_string(&mut self) -> Result<Expr, String> {
        let quote = self.peek().unwrap();
        self.i += 1;
        let start = self.i;
        while !self.at_end() && self.peek() != Some(quote) {
            self.i += 1;
        }
        if self.at_end() {
            return self.err("字符串缺少右引号");
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("").to_string();
        self.i += 1;
        Ok(Expr::Str(text))
    }

    fn parse_ident(&mut self) -> Result<Expr, String> {
        let start = self.i;
        while self.peek().map_or(false, |c| c.is_ascii_alphanumeric() || c == b'_') {
            self.i += 1;
        }
        let name = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("").to_string();

        self.ws();
        // 函数调用：IF(...) / SUM(...) / NVL(...)
        if self.peek() == Some(b'(') {
            self.i += 1;
            let mut args = Vec::new();
            self.ws();
            if self.peek() != Some(b')') {
                loop {
                    args.push(self.parse_cmp()?);
                    self.ws();
                    if self.eat(b',') {
                        continue;
                    }
                    break;
                }
            }
            self.ws();
            if !self.eat(b')') {
                return self.err("函数参数缺少右括号");
            }
            return Ok(Expr::Call { name: name.to_uppercase(), args });
        }

        // `value`：本格自身的值，只有展示期表达式（format_expr）用得上
        if name.eq_ignore_ascii_case("value") {
            return Ok(Expr::SelfValue);
        }

        // 单元格引用
        let mut coord = None;
        let mut prop = None;
        self.ws();
        if self.peek() == Some(b'[') {
            self.i += 1;
            let start = self.i;
            while !self.at_end() && self.peek() != Some(b']') {
                self.i += 1;
            }
            if self.at_end() {
                return self.err("层次坐标缺少 ]");
            }
            let inner = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("").trim().to_string();
            self.i += 1;
            if !inner.is_empty() {
                coord = Some(Coord::parse(&inner));
            }
        }

        // 条件表达式可写在聚合后缀之前或之后：`C2[A2:-1]{...}.sum()` 与
        // `C2[A2:-1].sum(){...}` 都收，免得用户记住顺序。
        self.ws();
        let mut cond = None;
        if self.peek() == Some(b'{') {
            cond = Some(self.parse_filter_cond()?);
        }

        self.ws();
        if self.peek() == Some(b'.') {
            self.i += 1;
            let start = self.i;
            while self.peek().map_or(false, |c| c.is_ascii_alphanumeric() || c == b'_') {
                self.i += 1;
            }
            let suffix = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("").to_string();
            self.ws();
            if self.eat(b'(') {
                self.ws();
                if !self.eat(b')') {
                    return self.err("聚合后缀不支持参数");
                }
                prop = match func_of(&suffix) {
                    Some(f) => Some(Prop::Aggregate(f)),
                    None => return self.err(format!("未知的聚合函数 .{suffix}()")),
                };
            } else {
                match suffix.to_lowercase().as_str() {
                    "expandindex" | "ei" => prop = Some(Prop::ExpandIndex),
                    _ => return self.err(format!("未知的单元格属性 .{suffix}")),
                }
            }
        }
        // 后缀之后再收一次条件表达式
        if cond.is_none() {
            self.ws();
            if self.peek() == Some(b'{') {
                cond = Some(self.parse_filter_cond()?);
            }
        }

        let cell = Expr::Cell { target: name, coord, prop };
        Ok(match cond {
            Some(c) => Expr::Filter { cell: Box::new(cell), cond: Box::new(c) },
            None => cell,
        })
    }

    /// 解析 `{条件}`（含花括号）
    fn parse_filter_cond(&mut self) -> Result<Expr, String> {
        if !self.eat(b'{') {
            return self.err("缺少左花括号 {");
        }
        self.ws();
        let cond = self.parse_cmp()?;
        self.ws();
        if !self.eat(b'}') {
            return self.err("条件表达式缺少右花括号 }");
        }
        Ok(cond)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(target: &str, coord: Option<&str>, prop: Option<Prop>) -> Expr {
        Expr::Cell {
            target: target.into(),
            coord: coord.map(Coord::parse),
            prop,
        }
    }

    #[test]
    fn parses_legacy_postfix_aggregate() {
        assert_eq!(parse("D3[B3:+0].sum()").unwrap(), cell("D3", Some("B3:+0"), Some(Prop::Aggregate("sum"))));
        assert_eq!(parse("D3.sum()").unwrap(), cell("D3", None, Some(Prop::Aggregate("sum"))));
        assert_eq!(parse("D3").unwrap(), cell("D3", None, None));
    }

    #[test]
    fn parses_arithmetic_and_precedence() {
        // C4 / C4[B4:-1] —— 环比
        let e = parse("C4 / C4[B4:-1]").unwrap();
        match e {
            Expr::Binary { op: BinOp::Div, lhs, rhs } => {
                assert_eq!(*lhs, cell("C4", None, None));
                assert_eq!(*rhs, cell("C4", Some("B4:-1"), None));
            }
            other => panic!("{other:?}"),
        }
        // 优先级：1 + 2 * 3 应解析为 1 + (2*3)
        let e = parse("1 + 2 * 3").unwrap();
        match e {
            Expr::Binary { op: BinOp::Add, rhs, .. } => match *rhs {
                Expr::Binary { op: BinOp::Mul, .. } => {}
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_if_with_comparison_and_property() {
        // IF(B4.expandIndex > 0, C4 / C4[B4:-1], '--')
        let e = parse("IF(B4.expandIndex > 0, C4 / C4[B4:-1], '--')").unwrap();
        match e {
            Expr::Call { name, args } => {
                assert_eq!(name, "IF");
                assert_eq!(args.len(), 3);
                match &args[0] {
                    Expr::Cmp { op: CmpOp::Gt, lhs, .. } => {
                        assert_eq!(**lhs, cell("B4", None, Some(Prop::ExpandIndex)));
                    }
                    other => panic!("{other:?}"),
                }
                assert_eq!(args[2], Expr::Str("--".into()));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_parens_and_unary() {
        assert!(parse("(1 + 2) * 3").is_ok());
        assert!(parse("-D3").is_ok());
        assert!(parse("D3 +").is_err());
        assert!(parse("D3 >").is_err());
        assert!(parse("D3.bogus()").is_err());
    }

    /// `value` 是保留字，指代本格的值（format_expr 用），大小写不敏感
    #[test]
    fn parses_value_keyword_as_self_value() {
        assert_eq!(parse("value").unwrap(), Expr::SelfValue);
        assert_eq!(parse("VALUE").unwrap(), Expr::SelfValue);
        assert_eq!(parse(" value ").unwrap(), Expr::SelfValue);

        // 在表达式里参与比较，而不是被当成单元格引用
        let e = parse(r#"IF(value >= 1000, "大额", "小额")"#).unwrap();
        match e {
            Expr::Call { name, args } => {
                assert_eq!(name, "IF");
                match &args[0] {
                    Expr::Cmp { op: CmpOp::Ge, lhs, .. } => assert_eq!(**lhs, Expr::SelfValue),
                    other => panic!("{other:?}"),
                }
            }
            other => panic!("{other:?}"),
        }

        // 后跟括号仍是函数调用（value() 无意义，但别被关键字吞掉）
        assert!(matches!(parse("value(1)").unwrap(), Expr::Call { .. }));
    }

    /// 格集过滤 `POS[COORD]{条件}` + `$` 运算符
    #[test]
    fn parses_cell_set_filter_and_dollar() {
        // C2[A2:-1]{$B2 == B2}：取上一年全部 C2，再筛出「月与当前格相同」的那一格
        let e = parse("C2[A2:-1]{$B2 == B2}").unwrap();
        match e {
            Expr::Filter { cell, cond } => {
                assert_eq!(*cell, cell_ref("C2", Some("A2:-1")));
                match *cond {
                    Expr::Cmp { op: CmpOp::Eq, lhs, rhs } => {
                        assert_eq!(*lhs, Expr::Dollar(Box::new(cell_ref("B2", None))));
                        assert_eq!(*rhs, cell_ref("B2", None));
                    }
                    other => panic!("{other:?}"),
                }
            }
            other => panic!("{other:?}"),
        }

        // 过滤后还能接聚合后缀：后缀归到内层单元格上（对格集求和）
        let e = parse("C2[A2:-1]{$B2 == B2}.sum()").unwrap();
        match e {
            Expr::Filter { cell, .. } => match *cell {
                Expr::Cell { ref target, ref prop, .. } => {
                    assert_eq!(target, "C2");
                    assert_eq!(*prop, Some(Prop::Aggregate("sum")));
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // 后缀在前、条件在后也收
        assert!(matches!(
            parse("C2[A2:-1].sum(){$B2 == B2}").unwrap(),
            Expr::Filter { .. }
        ));

        // 括号不配对要报错，不能静默当普通引用
        assert!(parse("C2{A2 == 1").is_err());
        assert!(parse("C2{A2 == 1}").is_ok());
        // `$` 后面必须跟东西
        assert!(parse("$").is_err());
    }

    fn cell_ref(target: &str, coord: Option<&str>) -> Expr {
        Expr::Cell { target: target.into(), coord: coord.map(Coord::parse), prop: None }
    }
}
