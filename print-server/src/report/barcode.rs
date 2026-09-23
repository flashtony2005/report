//! 条码 / 二维码编码器（自研，零依赖）。
//!
//! ## 为什么自己写
//!
//! 服务端一个编码器都没有：画布侧的二维码来自 `qrcode`（npm）、条形码来自
//! `@bwip-js/generic`，两个都是「画进 canvas / 出 PNG」的路子，拿不到位矩阵，
//! 服务端也用不了。而「标签 / 单据上按数据印二维码」只能走服务端 ——
//! 前端画完塞回模板就变成一张死图，数据一变就不对了。
//!
//! 引第三方 crate 也行。**但「为了 MSRV」这个理由不成立**（本节原文这么写过，
//! 已改）：本项目 `Cargo.toml` **没有** `rust-version`，实际下界由依赖决定，
//! `cargo metadata` 量出来**已经是 1.88**（`calamine` / `encoding_rs` / `zip` /
//! `rust_xlsxwriter`）→ 引 `image` / `png` **不会**抬高最低编译器版本。
//!
//! 仍然自研的理由是**取舍，不是硬约束**：这个服务要跑在客户机上，拖进
//! `image` 那棵树（`moxcms` / `pxfm` …）不值当。这里延续 `chartkit` 自研的路子：
//! 算法是死的、规范是公开的，**正确性有解码 oracle 兜底**（`scripts/verify-barcode.py`
//! 用 zxing-cpp 把产物解回来对原文），不是靠自信。
//!
//! ## 支持范围（刻意限定，写清楚比「尽量支持」有用）
//!
//! | 码制 | 范围 | 超出时 |
//! | --- | --- | --- |
//! | `qr` | 字节模式 + 纠错 M + 版本 1~10（≤ 213 字节） | 明确报错，点名实际字节数与上限 |
//! | `code128` | 全表 107 个符号，码集 B / C，需要时用 A；GS1-128 显式开关 | 超 48 字节报错 |
//!
//! **不做**的（想清楚才不做，不是漏了）：
//! - QR 数字 / 字母数字模式：省不了几个字节，却要多两套编码 + 两套计数位宽。
//! - QR 纠错 L / Q / H：M 是标签场景的通用解（能纠 15%）。
//! - QR 版本 11+：213 字节已经远超单据 / 标签的实际载荷；版本一多，
//!   分块表、定位图案表、版本信息表都要跟着长，而这三张表是纯手工数据。
//! - Code128 码集自动切换：切换要算「切过去省几个模块」，是启发式；
//!   启发式出错时是**条码扫不出来**，比多占几毫米严重。宁可整条用一个码集。
//! - 条码下方的人眼可读文本：SVG 里画得出、xlsx 位图里画不出，
//!   两边不一致比不画更糟（作者会以为导出坏了）。要印数字就旁边放个文本格。

use std::fmt;

/// 认得的码制（与前端 `CellBarcodeSymbology` 一一对应）
pub const SYMBOLOGIES: [&str; 2] = ["qr", "code128"];

/// 作者没写 `symbology` 时的缺省码制。
///
/// 选 `qr` 是因为它**什么内容都能装**（UTF-8 中文、URL、任意二进制），
/// 而 Code128 只收 ASCII。缺省值出错时要能自证，这里选不会「内容装不下」的那个。
const DEFAULT_SYMBOLOGY: &str = "qr";

/// QR 字节模式 + 纠错 M 下能装的最大字节数。
///
/// 版本 10 / M 的数据码字是 216 个 → 216×8 = 1728 位；
/// 减去 4 位模式指示符、16 位字符计数（版本 10 起是 16 位）剩 1708 位 → 213 字节。
const MAX_QR_BYTES: usize = 213;

/// Code128 的载荷上限。
///
/// 不是编码器装不下（Code128 理论上没有长度上限），是**排版装不下**：
/// 48 字节在码集 B 下约 500 个模块，按每模块 3 像素算将近 1500 像素宽，
/// 一列报表放不下。到这一步作者多半是把整行文本配到了条码格上，报错比画出来有用。
const MAX_CODE128_BYTES: usize = 48;

/// 渲染时每个模块占几个像素。
///
/// 3 是「够扫」与「别太宽」之间的取舍：2 像素是屏幕识别的下限，打印会掉点；
/// 再大就把报表列撑爆了。导出后 Excel 还会按格子大小二次缩放。
///
/// **两个渲染端共用这一个数**：HTML 侧的内联 SVG 用它定内联尺寸，
/// xlsx 侧的 PNG 用它定位图尺寸。各写各的话，同一条码在预览和 Excel 里
/// 大小会不一样（而这个项目在「预览与导出两套口径」上吃过亏）。
pub const PX_PER_MODULE: usize = 3;

/// 一维码纵向拉多少个模块高。
///
/// 一维码的逻辑矩阵只有 1 行（图案本身是一维的），必须拉伸成面才有得扫。
/// 25 模块 ≈ 符号宽度的 20%（121 模块宽时），高于规范要求的 15% ——
/// 扫码枪要有足够的「瞄准面积」，太扁的条码是**偶发扫不出**，最难查。
const BAR_ROWS: usize = 25;

/// QR 静区宽度（模块）
const QR_QUIET: usize = 4;
/// 一维码静区宽度（模块）
const BAR_QUIET: usize = 10;

// ---------------------------------------------------------------- 位矩阵

/// 条码位图：`true` = 黑（深色模块），行优先。
///
/// ## 静区已经含在内
///
/// 静区是符号的一部分（QR 四模块、一维码十模块），少了它扫码枪找不到边界，
/// 而**「扫不出来」在屏幕上一点异常都看不出来** —— 图还是那张图。
/// 所以不留「让调用方自己留白」的选项，`encode()` 出来就是能扫的完整符号。
///
/// ## 一维码已经拉伸过
///
/// `encode()` 返回的矩阵是**渲染就绪**的：一维码已经纵向拉到 [`BAR_ROWS`] 行。
/// 这样两个渲染端（HTML 的 SVG、xlsx 的 PNG）拿到的尺寸天然一致，
/// 不会一个拉一个不拉 —— 那样同一条码在预览里是条、在 Excel 里是一根线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarcodeMatrix {
    pub width: usize,
    pub height: usize,
    bits: Vec<bool>,
}

impl BarcodeMatrix {
    fn new(width: usize, height: usize) -> Self {
        BarcodeMatrix { width, height, bits: vec![false; width * height] }
    }

    pub fn get(&self, row: usize, col: usize) -> bool {
        self.bits[row * self.width + col]
    }

    fn set(&mut self, row: usize, col: usize, dark: bool) {
        self.bits[row * self.width + col] = dark;
    }

    /// 每行一个字符串，`'1'` = 黑。
    ///
    /// 给 `GridCell` 序列化用：`Vec<Vec<bool>>` 每格要 5 个字符（`true,`），
    /// 字符串 1 个 —— 一张 65×65 的二维码差 5 倍，而报表每行都可能带条码。
    /// 附带好处是 JSON 里能直接看出是个二维码。
    pub fn rows_as_strings(&self) -> Vec<String> {
        (0..self.height)
            .map(|r| {
                (0..self.width)
                    .map(|c| if self.get(r, c) { '1' } else { '0' })
                    .collect()
            })
            .collect()
    }

    /// 补静区。
    ///
    /// 横竖分开传是有原因的：**一维码的静区只在左右**，上下不需要（条已经够高了）。
    /// 早期版本上下也补，于是 1 行的逻辑矩阵变成 21 行，`stretched()` 看到
    /// 「已经不是 1 行了」就不再拉伸 —— 出来是一条 21 像素高的细线。
    /// 这类错误在屏幕上看不出来（还是一条条码的样子），只能靠单测钉住。
    fn with_quiet(&self, h_quiet: usize, v_quiet: usize) -> BarcodeMatrix {
        let w = self.width + h_quiet * 2;
        let h = self.height + v_quiet * 2;
        let mut out = BarcodeMatrix::new(w, h);
        for r in 0..self.height {
            for c in 0..self.width {
                if self.get(r, c) {
                    out.set(r + v_quiet, c + h_quiet, true);
                }
            }
        }
        out
    }

    /// 一维码：每行复制成 [`BAR_ROWS`] 行。二维码（本来就 > 1 行）原样返回。
    fn stretched(&self) -> BarcodeMatrix {
        if self.height != 1 {
            return self.clone();
        }
        let mut out = BarcodeMatrix::new(self.width, BAR_ROWS);
        for r in 0..BAR_ROWS {
            for c in 0..self.width {
                out.set(r, c, self.get(0, c));
            }
        }
        out
    }
}

impl fmt::Display for BarcodeMatrix {
    /// 终端里能直接看出来的位图（`##` = 黑）。单测失败时肉眼对图案用。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for r in 0..self.height {
            for c in 0..self.width {
                f.write_str(if self.get(r, c) { "##" } else { "  " })?;
            }
            writeln!(f)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- 入口

/// 归一化码制名。认不出来**报错并列出支持的**，不静默落到缺省 ——
/// 静默落缺省时作者写的 `code39` 会变成一张二维码，而二维码也能扫，
/// 于是「我明明写的是条码」变成一个查不出来的问题。
pub fn normalise_symbology(opt: Option<&str>) -> Result<&'static str, String> {
    let raw = opt.unwrap_or(DEFAULT_SYMBOLOGY).trim().to_ascii_lowercase();
    let raw = if raw.is_empty() { DEFAULT_SYMBOLOGY.to_string() } else { raw };
    // 常见别名：作者写 `qrcode` / `code-128` 时不该报错
    let canon = match raw.as_str() {
        "qr" | "qrcode" | "qr_code" | "qr-code" => "qr",
        "code128" | "code-128" | "code_128" => "code128",
        _ => {
            return Err(format!(
                "不认识的码制「{raw}」，支持：{}",
                SYMBOLOGIES.join(" / ")
            ))
        }
    };
    Ok(canon)
}

/// 编码：原文 → 渲染就绪的位矩阵（静区已含，一维码已拉伸）。
///
/// `gs1` 只对 `code128` 有意义（首字符插 FNC1），对 `qr` 忽略。
pub fn encode(value: &str, symbology: Option<&str>, gs1: bool) -> Result<BarcodeMatrix, String> {
    let sym = normalise_symbology(symbology)?;
    if value.is_empty() {
        return Err("条码内容为空".to_string());
    }
    match sym {
        "qr" => qr_encode(value.as_bytes()),
        _ => code128_encode(value.as_bytes(), gs1),
    }
}

// ================================================================ QR
//
// 实现照 ISO/IEC 18004。下面几张表都是**规范里的手工数据**（没有公式可推），
// 所以每条都配了一个自检单测：表抄错时单测先红，而不是等到扫不出来。

/// 纠错等级 M 下的分块方式：`(每块纠错码字, [(块数, 每块数据码字), ...])`。
/// 摘自规范表 13~22 的 M 列。
const QR_M_BLOCKS: [(usize, &[(usize, usize)]); 10] = [
    (10, &[(1, 16)]),
    (16, &[(1, 28)]),
    (26, &[(1, 44)]),
    (18, &[(2, 32)]),
    (24, &[(2, 43)]),
    (16, &[(4, 27)]),
    (18, &[(4, 31)]),
    (22, &[(2, 38), (2, 39)]),
    (22, &[(3, 36), (2, 37)]),
    (26, &[(4, 43), (1, 44)]),
];

/// 各版本的**总码字数**（数据 + 纠错）。用来交叉验算 [`QR_M_BLOCKS`]：
/// 两者对不上说明表抄错了。见 `qr_block_table_matches_total_codewords`。
const QR_TOTAL_CODEWORDS: [usize; 10] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/// 各版本数据区填完码字后剩下的**剩余位**（补 0，不参与纠错）。
///
/// 算法本身不读它（剩余位是「`draw_codewords` 没写到的地方」，天然为浅），
/// 这张表的作用是**交叉验算**：见 `qr_data_area_matches_the_spec_codeword_count`。
#[cfg(test)]
const QR_REMAINDER_BITS: [usize; 10] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/// 各版本定位图案的**中心坐标**（行列共用同一张表）。版本 1 没有定位图案。
const QR_ALIGN_POS: [&[usize]; 10] = [
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
];

/// 版本信息（版本 7 起才有）的已知值，用来验算 BCH。见 `qr_version_info_matches_spec`。
#[cfg(test)]
const QR_VERSION_INFO: [u32; 4] = [0x07C94, 0x085BC, 0x09A99, 0x0A4D3];

/// 纠错等级 M 的格式信息（掩码 0~7 的已知值），用来验算格式信息的 BCH。
/// 见 `qr_format_info_matches_spec`。
#[cfg(test)]
const QR_FORMAT_M: [u32; 8] = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
];

fn qr_data_codewords(vi: usize) -> usize {
    QR_M_BLOCKS[vi].1.iter().map(|(n, len)| n * len).sum()
}

/// 能装下 `len` 字节的最小版本（返回 0 起的下标）
fn qr_pick_version(len: usize) -> Result<usize, String> {
    for vi in 0..10 {
        let cap = qr_byte_capacity(vi);
        if len <= cap {
            return Ok(vi);
        }
    }
    Err(format!(
        "二维码内容 {len} 字节，超出本实现的上限 {MAX_QR_BYTES} 字节（版本 10 / 纠错 M）。\
         请缩短内容（单据号 / URL 一般几十字节），或改用更短的字段"
    ))
}

/// 某版本在字节模式下能装多少字节
fn qr_byte_capacity(vi: usize) -> usize {
    let version = vi + 1;
    let cci = if version <= 9 { 8 } else { 16 };
    let bits = qr_data_codewords(vi) * 8;
    bits.saturating_sub(4 + cci) / 8
}

fn qr_encode(bytes: &[u8]) -> Result<BarcodeMatrix, String> {
    let vi = qr_pick_version(bytes.len())?;
    let version = vi + 1;
    let data_cw = qr_data_codewords(vi);

    // ---- 比特流：模式指示符 + 字符计数 + 数据 + 终止符 + 补位 ----
    let mut bits: Vec<bool> = Vec::new();
    push_bits(&mut bits, 0b0100, 4); // 字节模式
    push_bits(&mut bits, bytes.len() as u32, if version <= 9 { 8 } else { 16 });
    for b in bytes {
        push_bits(&mut bits, u32::from(*b), 8);
    }
    let cap_bits = data_cw * 8;
    let terminator = cap_bits.saturating_sub(bits.len()).min(4);
    push_bits(&mut bits, 0, terminator);
    while bits.len() % 8 != 0 {
        bits.push(false);
    }

    let mut cw: Vec<u8> = bits
        .chunks(8)
        .map(|c| c.iter().fold(0u8, |acc, b| (acc << 1) | u8::from(*b)))
        .collect();
    // 填充码字 0xEC / 0x11 交替，直到填满数据区
    let mut pad = [0xECu8, 0x11].iter().cycle();
    while cw.len() < data_cw {
        cw.push(*pad.next().unwrap());
    }
    debug_assert_eq!(cw.len(), data_cw, "填完数据区必须正好 {data_cw} 个码字");

    // ---- 分块 + Reed-Solomon ----
    let (ec_len, spec) = QR_M_BLOCKS[vi];
    let mut blocks: Vec<&[u8]> = Vec::new();
    let mut off = 0usize;
    for (count, len) in spec {
        for _ in 0..*count {
            blocks.push(&cw[off..off + len]);
            off += len;
        }
    }
    debug_assert_eq!(off, data_cw);
    let gen = rs_generator(ec_len);
    let ecs: Vec<Vec<u8>> = blocks.iter().map(|b| rs_remainder(b, &gen)).collect();

    // ---- 交织：先按列交织数据码字，再按列交织纠错码字 ----
    let mut stream: Vec<u8> = Vec::with_capacity(QR_TOTAL_CODEWORDS[vi]);
    let max_data = blocks.iter().map(|b| b.len()).max().unwrap_or(0);
    for i in 0..max_data {
        for b in &blocks {
            if i < b.len() {
                stream.push(b[i]);
            }
        }
    }
    for i in 0..ec_len {
        for e in &ecs {
            stream.push(e[i]);
        }
    }
    debug_assert_eq!(stream.len(), QR_TOTAL_CODEWORDS[vi]);

    // ---- 画模块 ----
    let size = 17 + 4 * version;
    let mut base = QrGrid::new(size, version);
    base.draw_function_patterns();
    base.draw_codewords(&stream);

    // ---- 掩码：8 种各试一遍，取罚分最低的（规范要求，不是可选项） ----
    let mut best: Option<(usize, QrGrid)> = None;
    for mask in 0..8usize {
        let mut cand = base.clone();
        cand.apply_mask(mask);
        cand.draw_format_info(mask);
        let p = cand.penalty();
        let better = match &best {
            None => true,
            Some((bp, _)) => p < *bp,
        };
        if better {
            best = Some((p, cand));
        }
    }
    let (_, grid) = best.expect("8 个掩码里必然有一个能被选上");

    // 剩余位（0~7 位）保持浅色，规范就是这么要求的：`draw_codewords` 不碰它们，
    // 它们由 `QrGrid::new` 初始化为浅色。
    Ok(grid.to_matrix().with_quiet(QR_QUIET, QR_QUIET))
}

/// 规则 1 的单段罚分：连续 5 个同色才开始罚，每多一个加 1 分
fn run_penalty(len: usize) -> usize {
    if len >= 5 {
        3 + (len - 5)
    } else {
        0
    }
}

fn push_bits(out: &mut Vec<bool>, value: u32, len: usize) {
    for i in (0..len).rev() {
        out.push((value >> i) & 1 == 1);
    }
}

// ---------------------------------------------------------------- GF(256) / RS

/// GF(2^8) 乘法，本原多项式 0x11D（二维码规范指定）。
///
/// 用「移位 + 条件异或」而不是查表：纠错码字最多 26 个，性能无关紧要，
/// 少两张表就少两处抄错的机会。
fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    for _ in 0..8 {
        if b & 1 != 0 {
            p ^= a;
        }
        let hi = a & 0x80 != 0;
        a <<= 1;
        if hi {
            a ^= 0x1D;
        }
        b >>= 1;
    }
    p
}

/// 生成多项式 g(x) = (x - a^0)(x - a^1)…(x - a^(n-1))，系数**从高次到低次**。
/// 返回值首项恒为 1，长度 = degree + 1。
fn rs_generator(degree: usize) -> Vec<u8> {
    let mut g = vec![1u8];
    let mut root = 1u8; // a^0
    for _ in 0..degree {
        let mut next = vec![0u8; g.len() + 1];
        for (i, c) in g.iter().enumerate() {
            next[i] ^= c; // g · x
            next[i + 1] ^= gf_mul(*c, root); // g · a^k
        }
        g = next;
        root = gf_mul(root, 2);
    }
    g
}

/// 多项式除法的余数：`data · x^n mod g`。
///
/// `gen` 必须是 [`rs_generator`] 的输出（首项为 1）—— 首项是 1 才能省掉
/// 一次除法，这是综合除法成立的前提。
fn rs_remainder(data: &[u8], gen: &[u8]) -> Vec<u8> {
    let n = gen.len() - 1;
    let mut rem = vec![0u8; n];
    for &b in data {
        let factor = b ^ rem[0];
        rem.rotate_left(1);
        if n > 0 {
            rem[n - 1] = 0;
        }
        for i in 0..n {
            rem[i] ^= gf_mul(gen[i + 1], factor);
        }
    }
    rem
}

// ---------------------------------------------------------------- QR 画布

/// 二维码模块画布。
///
/// `func` 标记「功能图案 / 保留位」——这些格子**不参与掩码、不参与数据填充**。
/// 把它单独记一份而不是靠坐标现算，是因为「算错了」和「忘了算」症状一样：
/// 数据填到定位图案上，图看着还是个方块，只是扫不出来。
#[derive(Clone)]
struct QrGrid {
    size: usize,
    version: usize,
    dark: Vec<bool>,
    func: Vec<bool>,
}

impl QrGrid {
    fn new(size: usize, version: usize) -> Self {
        QrGrid { size, version, dark: vec![false; size * size], func: vec![false; size * size] }
    }

    fn idx(&self, row: usize, col: usize) -> usize {
        row * self.size + col
    }

    fn get(&self, row: usize, col: usize) -> bool {
        self.dark[self.idx(row, col)]
    }

    fn is_func(&self, row: usize, col: usize) -> bool {
        self.func[self.idx(row, col)]
    }

    /// 写一个功能图案格：值 + 保留标记一起打上
    fn set_func(&mut self, row: usize, col: usize, dark: bool) {
        let i = self.idx(row, col);
        self.dark[i] = dark;
        self.func[i] = true;
    }

    /// 三个定位图案（含分隔符）。
    ///
    /// 一次画 8×8（图案 7×7 + 一条分隔符边），分隔符是**浅色但保留**，
    /// 所以必须走 `set_func`：漏了它数据会填进分隔符，边界就糊了。
    fn place_finder(&mut self, row0: isize, col0: isize) {
        for dr in -1..=7isize {
            for dc in -1..=7isize {
                let (r, c) = (row0 + dr, col0 + dc);
                if r < 0 || c < 0 || r as usize >= self.size || c as usize >= self.size {
                    continue;
                }
                let inside = (0..=6).contains(&dr) && (0..=6).contains(&dc);
                let dark = inside
                    && (dr == 0
                        || dr == 6
                        || dc == 0
                        || dc == 6
                        || ((2..=4).contains(&dr) && (2..=4).contains(&dc)));
                self.set_func(r as usize, c as usize, dark);
            }
        }
    }

    fn draw_function_patterns(&mut self) {
        let size = self.size;
        // 定位图案：左上 / 右上 / 左下
        self.place_finder(0, 0);
        self.place_finder(0, size as isize - 7);
        self.place_finder(size as isize - 7, 0);

        // 定时图案：第 6 行 / 第 6 列，黑白相间，从 (6,8) 到 (6,size-9)
        for i in 8..size - 8 {
            let dark = i % 2 == 0;
            self.set_func(6, i, dark);
            self.set_func(i, 6, dark);
        }

        // 定位（校正）图案：5×5，中心在 QR_ALIGN_POS 的笛卡尔积上，
        // 但跳过与三个定位图案重叠的三个角
        let pos = QR_ALIGN_POS[self.version - 1];
        let last = size - 7;
        for &cr in pos {
            for &cc in pos {
                let corner = (cr == 6 && cc == 6)
                    || (cr == 6 && cc == last)
                    || (cr == last && cc == 6);
                if corner {
                    continue;
                }
                for dr in -2..=2isize {
                    for dc in -2..=2isize {
                        let dark = dr.abs().max(dc.abs()) != 1;
                        self.set_func((cr as isize + dr) as usize, (cc as isize + dc) as usize, dark);
                    }
                }
            }
        }

        // 版本信息（版本 7 起）：18 位，两处各 3×6
        if self.version >= 7 {
            let bits = qr_version_info_bits(self.version);
            for i in 0..18usize {
                let bit = (bits >> i) & 1 == 1;
                let a = size - 11 + i % 3;
                let b = i / 3;
                self.set_func(b, a, bit);
                self.set_func(a, b, bit);
            }
        }

        // 格式信息区：**先占位**（值留到选好掩码再写）。
        // 占位这一步不能省 —— 少了它，数据填充会把这些位置吃掉，
        // 最后写格式信息时覆盖上去，图看着完整，扫出来是错的。
        for i in 0..=5 {
            self.set_func(i, 8, false);
        }
        self.set_func(7, 8, false);
        self.set_func(8, 8, false);
        self.set_func(8, 7, false);
        for i in 9..15 {
            self.set_func(8, 14 - i, false);
        }
        for i in 0..8 {
            self.set_func(8, size - 1 - i, false);
        }
        for i in 8..15 {
            self.set_func(size - 15 + i, 8, false);
        }
        // 固定深色模块（规范 8.9：永远为深色，用来校正符号方向）
        self.set_func(size - 8, 8, true);
    }

    /// 按规范 8.7.3 的之字形把码字填进非功能区
    fn draw_codewords(&mut self, cw: &[u8]) {
        let size = self.size as isize;
        let total = cw.len() * 8;
        let mut i = 0usize;
        let mut right = size - 1;
        while right >= 1 {
            if right == 6 {
                right = 5; // 跳过第 6 列（定时图案）
            }
            for vert in 0..size {
                for j in 0..2 {
                    let x = right - j;
                    // 第 6 列被跳过后，两列的扫描方向要跟着翻
                    let upward = ((right + 1) & 2) == 0;
                    let y = if upward { size - 1 - vert } else { vert };
                    let (ru, cu) = (y as usize, x as usize);
                    if !self.is_func(ru, cu) && i < total {
                        let bit = (cw[i >> 3] >> (7 - (i & 7))) & 1 == 1;
                        let idx = self.idx(ru, cu);
                        self.dark[idx] = bit;
                        i += 1;
                    }
                }
            }
            right -= 2;
        }
    }

    fn apply_mask(&mut self, mask: usize) {
        for row in 0..self.size {
            for col in 0..self.size {
                if self.is_func(row, col) {
                    continue;
                }
                if qr_mask_bit(mask, col, row) {
                    let i = self.idx(row, col);
                    self.dark[i] = !self.dark[i];
                }
            }
        }
    }

    fn draw_format_info(&mut self, mask: usize) {
        let bits = qr_format_bits(mask);
        let size = self.size;
        let bit = |i: usize| (bits >> i) & 1 == 1;
        // 第一份：左上角，绕定位图案一圈
        for i in 0..=5 {
            self.set_func(i, 8, bit(i));
        }
        self.set_func(7, 8, bit(6));
        self.set_func(8, 8, bit(7));
        self.set_func(8, 7, bit(8));
        for i in 9..15 {
            self.set_func(8, 14 - i, bit(i));
        }
        // 第二份：右上 + 左下
        for i in 0..8 {
            self.set_func(8, size - 1 - i, bit(i));
        }
        for i in 8..15 {
            self.set_func(size - 15 + i, 8, bit(i));
        }
    }

    /// 掩码罚分（规范 8.8.2 的四条规则），越小越好。
    ///
    /// ## 这是「挑得好不好」，不是「对不对」
    ///
    /// 掩码编号写进格式信息，解码器照着反掩码 —— 所以**八个掩码出来的图都能扫**，
    /// 罚分只决定「用哪一个最不容易误识」。罚分算错不会让码变坏，只会让我们
    /// 挑不到规范推荐的那个。
    ///
    /// 说清楚这一点很重要：这样改罚分时就不会有人以为「改错了会扫不出来」，
    /// 也不会有人拿它当正确性证据。正确性由 zxing 解码 oracle 兜底。
    ///
    /// 但它仍然必须**不 panic** —— 早期版本照抄了一个会算出 -1 的公式，
    /// `usize` 下溢直接 panic（release 下变成一个天文数字的罚分，
    /// 于是永远挑同一个掩码）。四条规则现在都用非负写法。
    fn penalty(&self) -> usize {
        self.penalty_runs() + self.penalty_blocks() + self.penalty_finder_like() + self.penalty_balance()
    }

    /// 规则 1：同行 / 同列连续同色 ≥ 5 → `3 + (n - 5)`
    fn penalty_runs(&self) -> usize {
        let size = self.size;
        let mut score = 0usize;
        for row in 0..size {
            let mut color = false;
            let mut len = 0usize;
            for col in 0..size {
                let c = self.get(row, col);
                if col == 0 || c == color {
                    color = c;
                    len += 1;
                } else {
                    score += run_penalty(len);
                    color = c;
                    len = 1;
                }
            }
            score += run_penalty(len);
        }
        for col in 0..size {
            let mut color = false;
            let mut len = 0usize;
            for row in 0..size {
                let c = self.get(row, col);
                if row == 0 || c == color {
                    color = c;
                    len += 1;
                } else {
                    score += run_penalty(len);
                    color = c;
                    len = 1;
                }
            }
            score += run_penalty(len);
        }
        score
    }

    /// 规则 2：2×2 同色块 → 每块 3 分
    fn penalty_blocks(&self) -> usize {
        let size = self.size;
        let mut score = 0usize;
        for row in 0..size.saturating_sub(1) {
            for col in 0..size.saturating_sub(1) {
                let c = self.get(row, col);
                if c == self.get(row, col + 1)
                    && c == self.get(row + 1, col)
                    && c == self.get(row + 1, col + 1)
                {
                    score += 3;
                }
            }
        }
        score
    }

    /// 规则 3：出现「1:1:3:1:1 加四浅」这种像定位图案的序列 → 每个 40 分
    fn penalty_finder_like(&self) -> usize {
        let size = self.size;
        let mut score = 0usize;
        for row in 0..size {
            for col in 0..size {
                if col + 11 <= size {
                    let mut bits = 0u32;
                    for i in 0..11 {
                        bits = (bits << 1) | u32::from(self.get(row, col + i));
                    }
                    if bits == 0b00001011101 || bits == 0b10111010000 {
                        score += 40;
                    }
                }
                if row + 11 <= size {
                    let mut bits = 0u32;
                    for i in 0..11 {
                        bits = (bits << 1) | u32::from(self.get(row + i, col));
                    }
                    if bits == 0b00001011101 || bits == 0b10111010000 {
                        score += 40;
                    }
                }
            }
        }
        score
    }

    /// 规则 4：黑格占比每偏离 50% 达 5% 就罚 10 分
    fn penalty_balance(&self) -> usize {
        let dark = self.dark.iter().filter(|b| **b).count();
        let total = self.size * self.size;
        let deviation = (dark * 100 / total).abs_diff(50);
        (deviation / 5) * 10
    }

    fn to_matrix(&self) -> BarcodeMatrix {
        let mut m = BarcodeMatrix::new(self.size, self.size);
        for row in 0..self.size {
            for col in 0..self.size {
                if self.get(row, col) {
                    m.set(row, col, true);
                }
            }
        }
        m
    }
}

/// 掩码条件（规范表 10）。**返回 true 表示该格要取反** ——
/// 方向反了也能出图、也能扫，只是白白多一层罚分，所以这条靠单测钉住。
fn qr_mask_bit(mask: usize, x: usize, y: usize) -> bool {
    match mask {
        0 => (x + y) % 2 == 0,
        1 => y % 2 == 0,
        2 => x % 3 == 0,
        3 => (x + y) % 3 == 0,
        4 => (x / 3 + y / 2) % 2 == 0,
        5 => (x * y) % 2 + (x * y) % 3 == 0,
        6 => ((x * y) % 2 + (x * y) % 3) % 2 == 0,
        7 => ((x + y) % 2 + (x * y) % 3) % 2 == 0,
        _ => false,
    }
}

/// 格式信息：5 位数据（纠错等级 2 位 + 掩码 3 位）→ BCH(15,5) → 异或 0x5412。
///
/// 纠错等级 M 的两位是 `00`（L=01 / M=00 / Q=11 / H=10）。
/// 最后那个异或不是可选的：规范 8.9 用它避免「全 0」的格式信息。
fn qr_format_bits(mask: usize) -> u32 {
    const ECC_M: u32 = 0b00;
    let data = (ECC_M << 3) | (mask as u32 & 0b111);
    let mut rem = data;
    for _ in 0..10 {
        rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    }
    ((data << 10) | (rem & 0x3FF)) ^ 0x5412
}

/// 版本信息：6 位版本号 → BCH(18,6)，生成多项式 0x1F25
fn qr_version_info_bits(version: usize) -> u32 {
    let data = version as u32;
    let mut rem = data;
    for _ in 0..12 {
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
    }
    (data << 12) | (rem & 0xFFF)
}

// ================================================================ Code128

/// 107 个符号的宽度序列（每个数字是一位「条」或「空」的模块数，条空交替）。
/// 索引 0~102 是数据符号，103~105 是起始符 A/B/C，106 是终止符。
/// 每个数据符号 11 模块（数字之和为 11），终止符 13 模块。
const CODE128_PATTERNS: [&str; 107] = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212",
    "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221",
    "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221",
    "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321",
    "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131",
    "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131",
    "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111",
    "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242",
    "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311",
    "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

/// 起始符 / 终止符 / FNC1 的码值
const C128_START_A: usize = 103;
const C128_START_B: usize = 104;
const C128_START_C: usize = 105;
const C128_STOP: usize = 106;
/// FNC1 在三个码集里都是 102，GS1-128 就是「起始符后面紧跟一个 FNC1」
const C128_FNC1: usize = 102;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodeSet {
    A,
    B,
    C,
}

/// 选码集。**整条用一个码集**（不做中途切换，理由见模块头注释）。
///
/// 规则按优先级：
/// 1. 有控制字符（< 0x20）→ 只有码集 A 能表示；若同时还有 > 0x5F 的字符则报错。
/// 2. 全是数字、长度为偶数且 ≥ 4 → 码集 C（两个数字一个符号，宽度近乎减半）。
/// 3. 其余 → 码集 B（ASCII 可见字符全集）。
fn code128_pick_set(bytes: &[u8]) -> Result<CodeSet, String> {
    if let Some((i, b)) = bytes.iter().enumerate().find(|(_, b)| **b > 127) {
        return Err(format!(
            "Code128 只收 ASCII（0~127），第 {} 个字节是 0x{b:02X}；\
             中文 / 全角 / 二进制请改用二维码（`symbology: \"qr\"`）",
            i + 1
        ));
    }
    let has_control = bytes.iter().any(|b| *b < 0x20);
    if has_control {
        if let Some(b) = bytes.iter().find(|b| **b > 0x5F) {
            return Err(format!(
                "内容里既有控制字符（只有码集 A 能表示）又有 0x{b:02X}（只有码集 B 能表示），\
                 一个码集装不下；本实现刻意不做码集切换（切换是启发式，错了就是扫不出来），\
                 请拆成两条条码或改用二维码"
            ));
        }
        return Ok(CodeSet::A);
    }
    if let Some(i) = bytes.iter().position(|b| *b == 0x7F) {
        return Err(format!(
            "Code128 表示不了 DEL(0x7F)，出现在第 {} 个字节",
            i + 1
        ));
    }
    if bytes.len() >= 4 && bytes.len() % 2 == 0 && bytes.iter().all(u8::is_ascii_digit) {
        return Ok(CodeSet::C);
    }
    Ok(CodeSet::B)
}

/// 一个符号（码值）→ 位序列。条空交替，从「条」开始。
fn code128_symbol_bits(code: usize) -> Vec<bool> {
    let mut bits = Vec::with_capacity(13);
    let mut dark = true;
    for ch in CODE128_PATTERNS[code].chars() {
        let n = ch.to_digit(10).expect("图案表只含 0~9") as usize;
        for _ in 0..n {
            bits.push(dark);
        }
        dark = !dark;
    }
    bits
}

fn code128_encode(bytes: &[u8], gs1: bool) -> Result<BarcodeMatrix, String> {
    if bytes.len() > MAX_CODE128_BYTES {
        return Err(format!(
            "一维码内容 {} 字节，超出上限 {MAX_CODE128_BYTES} 字节（再长就宽到排不进报表列了）。\
             一维码适合单据号 / 序列号这类短码；长内容请改用二维码",
            bytes.len()
        ));
    }
    let set = code128_pick_set(bytes)?;

    let mut codes: Vec<usize> = Vec::new();
    codes.push(match set {
        CodeSet::A => C128_START_A,
        CodeSet::B => C128_START_B,
        CodeSet::C => C128_START_C,
    });
    if gs1 {
        codes.push(C128_FNC1);
    }
    match set {
        CodeSet::A => {
            for b in bytes {
                // 码集 A：0x00~0x1F → 64~95，0x20~0x5F → 0~63
                codes.push(if *b < 0x20 { (*b as usize) + 64 } else { (*b as usize) - 32 });
            }
        }
        CodeSet::B => {
            for b in bytes {
                codes.push((*b as usize) - 32);
            }
        }
        CodeSet::C => {
            for pair in bytes.chunks(2) {
                codes.push((pair[0] - b'0') as usize * 10 + (pair[1] - b'0') as usize);
            }
        }
    }
    // 校验位：起始符加权 1，其后第 i 个符号加权 i
    let sum: usize = codes.iter().enumerate().map(|(i, c)| if i == 0 { *c } else { i * *c }).sum();
    codes.push(sum % 103);
    codes.push(C128_STOP);

    let mut bits: Vec<bool> = Vec::new();
    for c in &codes {
        bits.extend(code128_symbol_bits(*c));
    }
    let mut m = BarcodeMatrix::new(bits.len(), 1);
    for (i, b) in bits.iter().enumerate() {
        m.set(0, i, *b);
    }
    // 先拉伸再补静区（顺序反了拉伸就失效，见 `with_quiet` 的注释）；
    // 一维码只补左右静区，上下不补
    Ok(m.stretched().with_quiet(BAR_QUIET, 0))
}

// ================================================================ 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn m(value: &str, sym: &str) -> BarcodeMatrix {
        encode(value, Some(sym), false).unwrap_or_else(|e| panic!("{sym} {value:?} 应当编得出: {e}"))
    }

    // ------------------------------------------------ 表自检

    #[test]
    fn qr_block_table_matches_total_codewords() {
        // 分块表与总码字数是从规范的不同表里抄的，对得上才说明没抄错
        for vi in 0..10 {
            let (ec_len, spec) = QR_M_BLOCKS[vi];
            let blocks: usize = spec.iter().map(|(n, _)| n).sum();
            let total: usize = spec.iter().map(|(n, len)| n * (len + ec_len)).sum();
            assert_eq!(
                total, QR_TOTAL_CODEWORDS[vi],
                "版本 {} 的分块表算出 {total} 个码字，总码字表说 {}",
                vi + 1,
                QR_TOTAL_CODEWORDS[vi]
            );
            assert!(blocks >= 1);
        }
    }

    #[test]
    fn qr_byte_capacity_matches_published_table() {
        // 规范附录里的「字节模式 / 纠错 M」容量表
        let want = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
        for vi in 0..10 {
            assert_eq!(qr_byte_capacity(vi), want[vi], "版本 {} 容量不符", vi + 1);
        }
        assert_eq!(MAX_QR_BYTES, want[9], "上限常量要与版本 10 的容量一致");
    }

    #[test]
    fn qr_version_info_matches_spec() {
        for (i, want) in QR_VERSION_INFO.iter().enumerate() {
            let v = i + 7;
            assert_eq!(qr_version_info_bits(v), *want, "版本 {v} 的版本信息不符");
        }
    }

    #[test]
    fn qr_format_info_matches_spec() {
        for (mask, want) in QR_FORMAT_M.iter().enumerate() {
            assert_eq!(qr_format_bits(mask), *want, "掩码 {mask} 的格式信息不符");
        }
    }

    #[test]
    fn qr_alignment_positions_are_consistent_with_size() {
        // 最后一个中心必须落在 size-7 上（贴着右下定位图案），否则图案会画到边界外
        for vi in 0..10 {
            let pos = QR_ALIGN_POS[vi];
            if pos.is_empty() {
                assert_eq!(vi, 0, "只有版本 1 没有定位图案");
                continue;
            }
            assert_eq!(*pos.last().unwrap(), 17 + 4 * (vi + 1) - 7);
            assert_eq!(pos[0], 6, "第一个中心固定在 6（与定时图案同行）");
        }
    }

    #[test]
    fn code128_pattern_table_is_well_formed() {
        assert_eq!(CODE128_PATTERNS.len(), 107);
        for (i, p) in CODE128_PATTERNS.iter().enumerate() {
            let sum: usize = p.chars().map(|c| c.to_digit(10).unwrap() as usize).sum();
            if i == C128_STOP {
                assert_eq!(sum, 13, "终止符应当是 13 模块");
                assert_eq!(p.len(), 7, "终止符是 7 段（条空条空条空条）");
            } else {
                assert_eq!(sum, 11, "符号 {i} 应当是 11 模块，实际 {sum}（{p}）");
                assert_eq!(p.len(), 6, "符号 {i} 应当是 6 段，实际 {}（{p}）", p.len());
            }
            assert!(
                p.chars().all(|c| ('1'..='4').contains(&c)),
                "符号 {i} 有非 1~4 的宽度：{p}"
            );
        }
    }

    #[test]
    fn code128_start_and_stop_patterns_are_the_documented_ones() {
        // 这三个是规范表里的固定值，抄错任何一个条码都扫不出来
        assert_eq!(CODE128_PATTERNS[C128_START_A], "211412");
        assert_eq!(CODE128_PATTERNS[C128_START_B], "211214");
        assert_eq!(CODE128_PATTERNS[C128_START_C], "211232");
        assert_eq!(CODE128_PATTERNS[C128_STOP], "2331112");
    }

    // ------------------------------------------------ Reed-Solomon

    #[test]
    fn rs_generator_is_monic_and_has_the_right_degree() {
        for n in [1, 7, 10, 22, 26] {
            let g = rs_generator(n);
            assert_eq!(g.len(), n + 1);
            assert_eq!(g[0], 1, "首项必须是 1（综合除法省掉一次除法全靠它）");
        }
    }

    #[test]
    fn rs_remainder_of_a_multiple_of_the_generator_is_zero() {
        // 把生成多项式本身当被除数，余数必然是 0 —— 这是 RS 最硬的自检
        for n in [7, 10, 22] {
            let g = rs_generator(n);
            assert_eq!(rs_remainder(&g, &g), vec![0u8; n], "n={n}");
        }
    }

    #[test]
    fn rs_remainder_handles_the_degenerate_degree_one_case() {
        // n=1 时 rotate_left 会把唯一的元素挪走，容易写出越界 / 语义错的分支
        let g = rs_generator(1);
        assert_eq!(g, vec![1, 1]); // x + a^0 = x + 1
        assert_eq!(rs_remainder(&[0x00], &g), vec![0x00]);
        assert_eq!(rs_remainder(&[0x01], &g), vec![0x01]);
    }

    #[test]
    fn gf_mul_is_commutative_and_has_the_expected_identities() {
        for a in 0..=255u8 {
            assert_eq!(gf_mul(a, 1), a, "乘 1 应当是恒等");
            assert_eq!(gf_mul(a, 0), 0);
        }
        // 本原多项式 0x11D 的根：a^8 = 0x1D
        assert_eq!(gf_mul(0x80, 2), 0x1D);
        assert_eq!(gf_mul(2, 0x80), 0x1D, "乘法必须可交换");
    }

    // ------------------------------------------------ QR 结构

    #[test]
    fn qr_has_the_expected_size_and_quiet_zone() {
        for (len, version) in [(1usize, 1usize), (20, 2), (60, 4), (200, 10)] {
            let v = m(&"a".repeat(len), "qr");
            let side = 17 + 4 * version + QR_QUIET * 2;
            assert_eq!(v.width, side, "{len} 字节应当是版本 {version}");
            assert_eq!(v.height, side, "二维码必须是正方形");
        }
    }

    #[test]
    fn qr_quiet_zone_is_entirely_light() {
        let v = m("HELLO", "qr");
        for i in 0..v.width {
            for q in 0..QR_QUIET {
                assert!(!v.get(q, i), "上静区第 {i} 列有黑格");
                assert!(!v.get(v.height - 1 - q, i), "下静区第 {i} 列有黑格");
                assert!(!v.get(i, q), "左静区第 {i} 行有黑格");
                assert!(!v.get(i, v.width - 1 - q), "右静区第 {i} 行有黑格");
            }
        }
    }

    #[test]
    fn qr_finder_patterns_are_present_in_three_corners() {
        let v = m("HELLO", "qr");
        // 三个 7×7 定位图案（跳过静区后从 (0,0)、(0,size-7)、(size-7,0) 起）
        let want = [
            "1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111",
        ];
        let q = QR_QUIET;
        let size = v.width - 2 * q;
        for (r0, c0) in [(0usize, 0usize), (0, size - 7), (size - 7, 0)] {
            for (dr, row) in want.iter().enumerate() {
                for (dc, ch) in row.chars().enumerate() {
                    let got = v.get(q + r0 + dr, q + c0 + dc);
                    assert_eq!(
                        got,
                        ch == '1',
                        "定位图案 ({r0},{c0}) 的第 {dr} 行第 {dc} 列不符"
                    );
                }
            }
        }
    }

    #[test]
    fn qr_timing_pattern_alternates_on_row_and_column_six() {
        let v = m("HELLO", "qr");
        let q = QR_QUIET;
        let size = v.width - 2 * q;
        for i in 8..size - 8 {
            assert_eq!(v.get(q + 6, q + i), i % 2 == 0, "第 6 行第 {i} 列");
            assert_eq!(v.get(q + i, q + 6), i % 2 == 0, "第 {i} 行第 6 列");
        }
    }

    #[test]
    fn qr_dark_module_is_always_dark() {
        // 规范 8.9 的固定深色模块，位置 (size-8, 8)。它在格式信息第二份旁边，
        // 画错的话符号方向校正就废了
        for len in [1usize, 30, 120, 200] {
            let v = m(&"x".repeat(len), "qr");
            let q = QR_QUIET;
            let size = v.width - 2 * q;
            assert!(v.get(q + size - 8, q + 8), "{len} 字节时固定深色模块丢了");
        }
    }

    #[test]
    fn qr_version_info_is_written_for_version_seven_and_up() {
        // 版本 7 起右上 / 左下角各有一块 3×6 的版本信息；
        // 版本 6 及以下那块位置是数据区，不能有「固定图案」
        let v7 = m(&"a".repeat(130), "qr"); // 122 < 130 ≤ 152 → 版本 8
        let q = QR_QUIET;
        let size = v7.width - 2 * q;
        // 版本信息在 (0..6, size-11..size-8) 一带：至少得有个黑格，
        // 全浅说明整块没写
        let mut dark = 0;
        for r in 0..6 {
            for c in size - 11..size - 8 {
                if v7.get(q + r, q + c) {
                    dark += 1;
                }
            }
        }
        assert!(dark > 0, "版本 8 的版本信息区全是浅色，说明没写");
    }

    #[test]
    fn qr_masking_actually_changes_the_symbol() {
        // 掩码是「选一个罚分最低的」而不是可选项。这条防的是
        // 「掩码算完忘了应用」——那样图也能扫，只是不规范
        let base = {
            let mut g = QrGrid::new(21, 1);
            g.draw_function_patterns();
            g.draw_codewords(&vec![0u8; QR_TOTAL_CODEWORDS[0]]);
            g
        };
        let mut a = base.clone();
        a.apply_mask(0);
        let mut b = base.clone();
        b.apply_mask(1);
        assert_ne!(a.dark, b.dark, "两种掩码应当产出不同的图");
        // 功能图案不能被掩码改
        for row in 0..21 {
            for col in 0..21 {
                if base.is_func(row, col) {
                    assert_eq!(a.get(row, col), base.get(row, col), "掩码改了功能区 ({row},{col})");
                }
            }
        }
    }

    /// 手工构造一张 `size × size` 的画布，`dark` 返回该格是否为黑
    fn grid(size: usize, dark: impl Fn(usize, usize) -> bool) -> QrGrid {
        let mut g = QrGrid::new(size, 1);
        for r in 0..size {
            for c in 0..size {
                g.dark[r * size + c] = dark(r, c);
            }
        }
        g
    }

    #[test]
    fn penalty_rule_1_counts_long_runs() {
        // 全浅 6×6：6 行 × run(6)=4 分 = 24，列同样 24 → 48
        let all_light = grid(6, |_, _| false);
        assert_eq!(all_light.penalty_runs(), 48);
        // 棋盘：每段长度都是 1，不罚
        let checker = grid(6, |r, c| (r + c) % 2 == 0);
        assert_eq!(checker.penalty_runs(), 0);
        // 单段罚分本身：5 个同色 → 3 分，6 个 → 4 分
        assert_eq!(run_penalty(4), 0, "4 个还不到罚线");
        assert_eq!(run_penalty(5), 3);
        assert_eq!(run_penalty(6), 4);
        assert_eq!(run_penalty(10), 8);
    }

    #[test]
    fn penalty_rule_2_counts_2x2_blocks() {
        // 全浅 6×6 有 5×5 = 25 个 2×2 同色块 → 75 分
        assert_eq!(grid(6, |_, _| false).penalty_blocks(), 75);
        // 棋盘一个都没有
        assert_eq!(grid(6, |r, c| (r + c) % 2 == 0).penalty_blocks(), 0);
        // 单块：2×2 全黑 → 3 分
        assert_eq!(grid(2, |_, _| true).penalty_blocks(), 3);
    }

    #[test]
    fn penalty_rule_3_counts_finder_like_sequences() {
        // 一行里放一个 10111010000：正着一次、反着一次都要认
        let fwd = grid(11, |r, c| r == 0 && [1u8, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0][c] == 1);
        assert!(fwd.penalty_finder_like() >= 40, "正向序列没被认出来");
        let rev = grid(11, |r, c| r == 0 && [0u8, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1][c] == 1);
        assert!(rev.penalty_finder_like() >= 40, "反向序列没被认出来");
        // 棋盘里没有这种序列
        assert_eq!(grid(11, |r, c| (r + c) % 2 == 0).penalty_finder_like(), 0);
        // 小于 11 的边长根本不扫（窗口放不下），不能越界
        assert_eq!(grid(6, |_, _| true).penalty_finder_like(), 0);
    }

    #[test]
    fn penalty_rule_4_never_underflows_and_is_zero_at_fifty_percent() {
        // 正好 50% → 0 分。这条防的是下溢：早期写法在 50% 时算出 -1，
        // usize 下直接 panic（release 下变成天文数字，永远挑同一个掩码）
        let checker = grid(6, |r, c| (r + c) % 2 == 0); // 18/36 = 50%
        assert_eq!(checker.penalty_balance(), 0);
        // 全浅 → 偏离 50% → (50/5)×10 = 100
        assert_eq!(grid(6, |_, _| false).penalty_balance(), 100);
        // 全黑同样 100
        assert_eq!(grid(6, |_, _| true).penalty_balance(), 100);
        // 规范的分档是「50±5k 到 50±5(k+1) 记 k 分」→ 偏离 5% 就落在 k=1
        let g45 = grid(10, |r, c| r * 10 + c < 45);
        assert_eq!(g45.penalty_balance(), 10, "45% 偏离 5%，记一档");
        let g40 = grid(10, |r, c| r * 10 + c < 40);
        assert_eq!(g40.penalty_balance(), 20, "40% 偏离 10%，记两档");
    }

    #[test]
    fn qr_data_area_matches_the_spec_codeword_count() {
        // 这是整套 QR 里**最强的一条结构检查**：数据区（非功能区）的格数必须
        // 正好等于「总码字×8 + 剩余位」。
        //
        // 它一次性验掉定位图案 / 分隔符 / 定时图案 / 定位（校正）图案 / 格式信息区 /
        // 版本信息区 / 固定深色模块的**全部占位**。少占一格（比如格式信息忘了预留），
        // 数据就会填进去，图看着还是完整的方块 —— 只有扫的时候才发现是错的。
        for vi in 0..10 {
            let version = vi + 1;
            let size = 17 + 4 * version;
            let mut g = QrGrid::new(size, version);
            g.draw_function_patterns();
            let non_func = (0..size)
                .flat_map(|r| (0..size).map(move |c| (r, c)))
                .filter(|(r, c)| !g.is_func(*r, *c))
                .count();
            let expected = QR_TOTAL_CODEWORDS[vi] * 8 + QR_REMAINDER_BITS[vi];
            assert_eq!(
                non_func, expected,
                "版本 {version} 的数据区格数不符：功能区占错了"
            );
        }
    }

    #[test]
    fn qr_draw_codewords_writes_exactly_the_stream_bits() {
        // 剩余位必须「没被写到」。判据不是去猜它们在哪几格（那要重算一遍之字形，
        // 等于把被测代码抄一遍），而是用**全 1 流**：每个写入的比特都是黑格，
        // 于是「非功能区里的黑格数」必须正好等于流长 ——
        // 多一个说明写进了剩余位，少一个说明漏了格子。
        for vi in [0usize, 1, 6, 9] {
            let version = vi + 1;
            let size = 17 + 4 * version;
            let n = QR_TOTAL_CODEWORDS[vi];
            let count_dark = |g: &QrGrid| {
                (0..size)
                    .flat_map(|r| (0..size).map(move |c| (r, c)))
                    .filter(|(r, c)| !g.is_func(*r, *c) && g.get(*r, *c))
                    .count()
            };

            let mut g = QrGrid::new(size, version);
            g.draw_function_patterns();
            g.draw_codewords(&vec![0xFFu8; n]);
            assert_eq!(count_dark(&g), n * 8, "版本 {version}：写进去的比特数不对");

            // 反过来：全 0 流一个黑格都不该留
            let mut z = QrGrid::new(size, version);
            z.draw_function_patterns();
            z.draw_codewords(&vec![0x00u8; n]);
            assert_eq!(count_dark(&z), 0, "版本 {version}：全 0 流不该留黑格");
        }
    }

    #[test]
    fn qr_rejects_payload_over_the_limit_and_names_the_numbers() {
        let ok = encode(&"a".repeat(MAX_QR_BYTES), Some("qr"), false);
        assert!(ok.is_ok(), "正好到上限应当编得出");
        let err = encode(&"a".repeat(MAX_QR_BYTES + 1), Some("qr"), false).unwrap_err();
        assert!(err.contains(&(MAX_QR_BYTES + 1).to_string()), "要说出实际字节数：{err}");
        assert!(err.contains(&MAX_QR_BYTES.to_string()), "要说出上限：{err}");
    }

    #[test]
    fn qr_handles_multibyte_utf8_by_byte_length() {
        // 中文按 UTF-8 字节数算容量，不是字符数
        let s = "销售".repeat(30); // 180 字节
        assert_eq!(s.len(), 180);
        let v = m(&s, "qr");
        // 180 ≤ 180 → 版本 9
        assert_eq!(v.width, 17 + 4 * 9 + QR_QUIET * 2);
        // 再多 40 个汉字（240 字节）就超了
        assert!(encode(&"销售".repeat(70), Some("qr"), false).is_err());
    }

    // ------------------------------------------------ Code128 结构

    #[test]
    fn code128_is_stretched_to_bar_height_with_quiet_zones() {
        let v = m("12345678", "code128");
        assert_eq!(v.height, BAR_ROWS, "一维码必须拉伸成面");
        assert!(v.width > BAR_QUIET * 2, "宽度要含两侧静区");
        // 静区全浅
        for r in 0..v.height {
            for q in 0..BAR_QUIET {
                assert!(!v.get(r, q), "左静区第 {q} 列有黑格");
                assert!(!v.get(r, v.width - 1 - q), "右静区第 {q} 列有黑格");
            }
        }
        // 拉伸后每一行都应当一样
        for r in 1..v.height {
            for c in 0..v.width {
                assert_eq!(v.get(r, c), v.get(0, c), "第 {r} 行与首行不同");
            }
        }
    }

    #[test]
    fn code128_starts_with_a_bar_and_ends_with_the_stop_pattern() {
        let v = m("ABC", "code128");
        assert!(v.get(0, BAR_QUIET), "符号必须从黑条开始");
        // 终止符 2331112：条空交替，**最后一段是 2 个黑模块**（不是浅的）
        let end = v.width - BAR_QUIET;
        assert!(v.get(0, end - 1) && v.get(0, end - 2), "终止符末尾应当是 2 个黑模块");
        // 再往前是宽度 1 的空白段
        assert!(!v.get(0, end - 3), "终止符倒数第 3 个模块应当是浅色");
        // 最前面是宽度 2 的黑条（起始符 211412 / 211214 / 211232 都以 2 开头）
        assert!(v.get(0, BAR_QUIET) && v.get(0, BAR_QUIET + 1));
        assert!(!v.get(0, BAR_QUIET + 2), "起始符第 3 个模块应当是浅色");
    }

    #[test]
    fn code128_picks_set_c_for_even_digit_runs() {
        // 8 位数字 → 码集 C：起始 + 4 对 + 校验 + 终止 = 7 个符号
        // 宽度 = 6×11 + 13 + 20（静区）= 99
        let v = m("12345678", "code128");
        assert_eq!(v.width, 6 * 11 + 13 + BAR_QUIET * 2);
        // 奇数位数字走码集 B：起始 + 7 + 校验 + 终止 = 10 个符号
        let v2 = m("1234567", "code128");
        assert_eq!(v2.width, 9 * 11 + 13 + BAR_QUIET * 2);
    }

    #[test]
    fn code128_uses_set_a_only_when_control_characters_are_present() {
        // 无控制字符 → 码集 B
        assert_eq!(code128_pick_set(b"ABC").unwrap(), CodeSet::B);
        // 有控制字符且全在码集 A 范围内 → 码集 A
        assert_eq!(code128_pick_set(b"ABC\x01").unwrap(), CodeSet::A);
        // 有控制字符又有小写 → 一个码集装不下，必须报错而不是悄悄编错
        let err = code128_pick_set(b"ABC\x01abc").unwrap_err();
        assert!(err.contains("码集"), "错误要说清楚原因：{err}");
    }

    #[test]
    fn code128_rejects_non_ascii_and_points_at_qr() {
        let err = encode("销售单", Some("code128"), false).unwrap_err();
        assert!(err.contains("ASCII"), "{err}");
        assert!(err.contains("qr"), "要指向二维码：{err}");
    }

    #[test]
    fn code128_rejects_del() {
        let err = encode("AB\x7fC", Some("code128"), false).unwrap_err();
        assert!(err.contains("DEL"), "{err}");
    }

    #[test]
    fn code128_rejects_payload_over_the_width_limit() {
        let err = encode(&"A".repeat(MAX_CODE128_BYTES + 1), Some("code128"), false).unwrap_err();
        assert!(err.contains(&MAX_CODE128_BYTES.to_string()), "要说出上限：{err}");
        assert!(encode(&"A".repeat(MAX_CODE128_BYTES), Some("code128"), false).is_ok());
    }

    #[test]
    fn code128_gs1_inserts_fnc1_right_after_the_start_symbol() {
        let plain = m("12345678", "code128");
        let gs1 = encode("12345678", Some("code128"), true).unwrap();
        // FNC1 是 11 个模块，加在起始符后面
        assert_eq!(gs1.width, plain.width + 11);
        // 前 11 个模块（起始符）应当一样，接下来 11 个是 FNC1
        for i in 0..11 {
            assert_eq!(gs1.get(0, BAR_QUIET + i), plain.get(0, BAR_QUIET + i));
        }
    }

    /// 把编出来的条码**解回符号序列**：按连续段宽度切成 6 段一组（终止符 7 段），
    /// 再拿图案表反查。这是「编码器 vs 图案表」的往返验证 ——
    /// 只断言宽度等于 99 是测不出「宽度对但图案错了」的。
    fn code128_symbols(m: &BarcodeMatrix) -> Vec<usize> {
        let mut runs: Vec<usize> = Vec::new();
        let mut color = m.get(0, BAR_QUIET);
        assert!(color, "符号必须从黑条开始");
        let mut n = 0usize;
        for c in BAR_QUIET..m.width - BAR_QUIET {
            let b = m.get(0, c);
            if b == color {
                n += 1;
            } else {
                runs.push(n);
                color = b;
                n = 1;
            }
        }
        runs.push(n);
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < runs.len() {
            // 终止符是 7 段，其余都是 6 段
            let take = if runs.len() - i == 7 { 7 } else { 6 };
            assert!(runs.len() - i >= 6, "剩余段数不足一个符号：{i}/{}", runs.len());
            let pat: String = runs[i..i + take]
                .iter()
                .map(|v| char::from_digit(*v as u32, 10).expect("段宽只能是 1~4"))
                .collect();
            let idx = CODE128_PATTERNS
                .iter()
                .position(|p| *p == pat)
                .unwrap_or_else(|| panic!("段 {pat} 不在图案表里（第 {i} 段起）"));
            out.push(idx);
            i += take;
        }
        out
    }

    #[test]
    fn code128_round_trips_through_the_pattern_table() {
        // 8 位数字 → 码集 C：Start C(105) + 12 + 34 + 56 + 78 + 校验 + Stop(106)
        // 校验 = (105 + 1×12 + 2×34 + 3×56 + 4×78) mod 103 = (105+12+68+168+312) = 665 mod 103
        let v = m("12345678", "code128");
        let got = code128_symbols(&v);
        assert_eq!(got, vec![105, 12, 34, 56, 78, 665 % 103, 106], "码集 C 的符号序列不符");

        // 字母 → 码集 B：Start B(104) + 'A'-32 + 'B'-32 + 'C'-32 + 校验 + Stop
        let v = m("ABC", "code128");
        let got = code128_symbols(&v);
        let sum = 104 + 1 * 33 + 2 * 34 + 3 * 35;
        assert_eq!(got, vec![104, 33, 34, 35, sum % 103, 106], "码集 B 的符号序列不符");

        // GS1-128：起始符后面紧跟 FNC1(102)
        let v = encode("12345678", Some("code128"), true).unwrap();
        let got = code128_symbols(&v);
        assert_eq!(got[0], 105, "GS1 下起始符仍是 Start C");
        assert_eq!(got[1], 102, "GS1-128 的第二个符号必须是 FNC1");
        assert_eq!(got.len(), 8, "比不加 GS1 多一个符号");
    }

    #[test]
    fn code128_set_a_uses_the_control_character_offsets() {
        // 码集 A：0x00~0x1F → 64~95。'\x01' 应当是 65
        let v = m("\x01\x02", "code128");
        let got = code128_symbols(&v);
        assert_eq!(got[0], 103, "有控制字符时必须用 Start A");
        assert_eq!(got[1], 65, "0x01 在码集 A 里是 65");
        assert_eq!(got[2], 66, "0x02 在码集 A 里是 66");
        // 大写字母在码集 A 里同样是 b - 32
        let v = m("A\x01", "code128");
        let got = code128_symbols(&v);
        assert_eq!(got[1], 33, "'A' 在码集 A 里是 33");
        assert_eq!(got[2], 65, "0x01 在码集 A 里是 65");
    }

    #[test]
    fn code128_checksum_is_weighted_by_position() {
        // 校验位不是简单求和：起始符权重 1，其后第 i 个符号权重 i。
        // 用两组「数字和相同但位置不同」的数据区分开
        let a = code128_symbols(&m("120000", "code128"));
        let b = code128_symbols(&m("001200", "code128"));
        assert_eq!(a[0], 105);
        assert_eq!(b[0], 105);
        assert_ne!(a[a.len() - 2], b[b.len() - 2], "位置不同校验位应当不同");
        // 手算：105 + 1×12 + 2×00 + 3×00 = 117 → 117 % 103 = 14
        assert_eq!(a[a.len() - 2], 117 % 103);
        // 105 + 1×00 + 2×12 + 3×00 = 129 → 129 % 103 = 26
        assert_eq!(b[b.len() - 2], 129 % 103);
    }

    // ------------------------------------------------ 入口约定

    #[test]
    fn symbology_defaults_to_qr_and_accepts_aliases() {
        assert_eq!(normalise_symbology(None).unwrap(), "qr");
        assert_eq!(normalise_symbology(Some("")).unwrap(), "qr");
        assert_eq!(normalise_symbology(Some("  QR  ")).unwrap(), "qr");
        assert_eq!(normalise_symbology(Some("QRCode")).unwrap(), "qr");
        assert_eq!(normalise_symbology(Some("CODE-128")).unwrap(), "code128");
    }

    #[test]
    fn unknown_symbology_errors_and_lists_supported_ones() {
        let err = normalise_symbology(Some("code39")).unwrap_err();
        assert!(err.contains("code39"), "要点名作者写的值：{err}");
        assert!(err.contains("qr") && err.contains("code128"), "要列出支持的：{err}");
    }

    #[test]
    fn empty_payload_is_rejected_for_both_symbologies() {
        for sym in SYMBOLOGIES {
            let err = encode("", Some(sym), false).unwrap_err();
            assert!(err.contains("空"), "{sym} 空内容要报错：{err}");
        }
    }

    #[test]
    fn matrix_rows_as_strings_round_trips() {
        let v = m("HELLO", "qr");
        let rows = v.rows_as_strings();
        assert_eq!(rows.len(), v.height);
        for (r, row) in rows.iter().enumerate() {
            assert_eq!(row.len(), v.width);
            for (c, ch) in row.chars().enumerate() {
                assert_eq!(ch == '1', v.get(r, c), "({r},{c}) 不符");
            }
        }
    }

    #[test]
    fn encoding_is_deterministic() {
        // 掩码选择若有并列而用了 HashSet 之类的不稳定结构，同一输入会出不同图，
        // 导出的文件就没法做二进制比对
        for sym in SYMBOLOGIES {
            let a = m("ORDER-2026-0001", sym);
            let b = m("ORDER-2026-0001", sym);
            assert_eq!(a, b, "{sym} 两次编码结果不同");
        }
    }

    // ------------------------------------------------ 外部 oracle 脚手架

    /// 把若干样本的位矩阵按文本倒出来，交给外部解码器（zxing）验。
    ///
    /// **默认不跑**（`#[ignore]`）：它要写文件、要外部工具，不属于单测。
    /// `scripts/verify-barcode.py` 会带着 `--ignored` 调它，再把每个矩阵
    /// 栅格化成 PNG 用 zxing 解回来对原文。
    ///
    /// 为什么要这一层：上面所有单测都只能证明「内部自洽」——
    /// 图案表抄错、之字形方向反了、掩码没应用，这些单测全绿而条码是废的。
    /// 只有真正的解码器说「读出来是这串」才算数。
    #[test]
    #[ignore = "外部 oracle 脚手架，由 scripts/verify-barcode.py 驱动"]
    fn dump_matrices_for_external_oracle() {
        let dir = std::env::var("BARCODE_DUMP_DIR")
            .unwrap_or_else(|_| "/tmp/barcode-dump".to_string());
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("建 dump 目录");

        let samples: Vec<(&str, String, &str, bool)> = vec![
            ("qr_hello", "HELLO WORLD".to_string(), "qr", false),
            ("qr_url", "https://example.com/order/2026-0001".to_string(), "qr", false),
            ("qr_cjk", "销售单号：2026-0001".to_string(), "qr", false),
            ("qr_v1_min", "A".to_string(), "qr", false),
            ("qr_v10_max", "x".repeat(MAX_QR_BYTES), "qr", false),
            ("qr_numeric", "0123456789012345678901234567890".to_string(), "qr", false),
            ("c128_setb", "ORDER-2026-0001".to_string(), "code128", false),
            ("c128_setc", "1234567890".to_string(), "code128", false),
            ("c128_seta", "AB\x0d".to_string(), "code128", false),
            ("c128_gs1", "0104912345123459".to_string(), "code128", true),
        ];

        let mut index = String::new();
        for (name, payload, sym, gs1) in &samples {
            let m = encode(payload, Some(sym), *gs1)
                .unwrap_or_else(|e| panic!("{name} 应当编得出: {e}"));
            let mut text = String::new();
            for row in m.rows_as_strings() {
                text.push_str(&row);
                text.push('\n');
            }
            std::fs::write(dir.join(format!("{name}.txt")), text).expect("写矩阵");
            index.push_str(&format!(
                "{name}\t{}\t{}\t{}\n",
                sym,
                m.width,
                m.height
            ));
            // 载荷单独存，避免制表符 / 换行把 TSV 弄坏
            std::fs::write(dir.join(format!("{name}.payload")), payload).expect("写载荷");
        }
        std::fs::write(dir.join("index.tsv"), index).expect("写索引");
        eprintln!("已倒出 {} 个样本到 {}", samples.len(), dir.display());
    }
}
