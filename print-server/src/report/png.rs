//! 最小 PNG 编码器（1 位灰度，零依赖）。
//!
//! ## 为什么必须自己写
//!
//! xlsx 只收**位图**（`rust_xlsxwriter` 的 `Image` 只认 PNG/JPEG/GIF/BMP 字节，
//! 没有 EMF / SVG 通路 —— 这一点是查了 crate 源码确认的，不是猜的）。
//! 而服务端**一个 PNG 编码器都没有**：`rust_xlsxwriter` 只**读** PNG，不写。
//!
//! 引 `image` / `png` crate 也能解决。**但「为了 MSRV」这个理由不成立**
//! （本节原文这么写过，已改）：本项目 `Cargo.toml` **没有** `rust-version`，
//! 实际下界由依赖决定，而 `cargo metadata` 量出来**已经是 1.88**
//! （`calamine 0.36.1` / `encoding_rs 0.8.41` / `zip 8.6.0` /
//! `rust_xlsxwriter 0.99.0` 里最高的那个）→ 引它**不会**抬高最低编译器版本。
//!
//! 仍然自研的理由是**取舍，不是硬约束**：这个服务要跑在客户机上，为一个
//! 「把黑白点阵写成文件」的功能拖进 `image` 那棵树（`moxcms` / `pxfm` …）不值当；
//! 而 1 位灰度 PNG 的写出路径很短，**正确性有外部 oracle 兜底**
//! （`scripts/verify-barcode.py` 把产物交给 zxing 解码对原文）。
//! 哪天真要读图 / 转码，再引不迟 —— 那时按「依赖树大小」权衡，**别按 MSRV**。
//!
//! ## 为什么是 1 位灰度
//!
//! 条码只有黑白两色。1 位灰度（`bit_depth=1, color_type=0`）每像素 1 比特，
//! 而 8 位 RGB 是 24 比特 —— 一个 195×195 的二维码差 24 倍。
//! 而且 1 位图**没有插值余地**：Excel 缩放时也不会把灰边造出来（灰边会毁掉条码）。
//!
//! ## zlib 用「存储块」而不是压缩
//!
//! DEFLATE 的存储块（`BTYPE=00`）不做压缩，直接原样塞 —— 但它是**合法**的
//! zlib 流，任何解码器都认。写一个真正的 Huffman 编码器要多几百行，
//! 而这里的数据量本来就小（几十 KB），压缩收益不值那些行数和出错面。
//! 代价照实说：文件比压缩过的大，仅此而已。

/// 1 位灰度 PNG：`dark(x, y) == true` 的位置是黑。
///
/// 颜色约定：PNG 的 1 位灰度里 **0 = 黑、1 = 白**，与直觉相反。
/// 写反了整个图会黑白颠倒 —— 屏幕上看还是一张「有条码形状的图」，
/// 只是扫不出来。所以下面写位时是「不黑才置 1」，并有单测钉住。
pub fn encode_gray1(width: usize, height: usize, dark: impl Fn(usize, usize) -> bool) -> Vec<u8> {
    let row_bytes = width.div_ceil(8);
    let mut raw = Vec::with_capacity((row_bytes + 1) * height);
    for y in 0..height {
        raw.push(0); // 每行的滤波器：0 = None（1 位图用不上差分滤波）
        let mut acc = 0u8;
        let mut bit = 0usize;
        for x in 0..width {
            if !dark(x, y) {
                acc |= 1 << (7 - bit); // 白 = 1
            }
            bit += 1;
            if bit == 8 {
                raw.push(acc);
                acc = 0;
                bit = 0;
            }
        }
        if bit > 0 {
            raw.push(acc); // 行末不足 8 位要补齐（PNG 要求按字节对齐）
        }
    }

    let mut out = Vec::with_capacity(raw.len() + 128);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.push(1); // 位深：1
    ihdr.push(0); // 颜色类型：0 = 灰度
    ihdr.push(0); // 压缩方法：0 = deflate（PNG 只定义了这一种）
    ihdr.push(0); // 滤波方法：0
    ihdr.push(0); // 隔行：0 = 不隔行
    chunk(&mut out, b"IHDR", &ihdr);

    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", &[]);
    out
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_in = Vec::with_capacity(4 + data.len());
    crc_in.extend_from_slice(kind);
    crc_in.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_in).to_be_bytes());
}

/// zlib 流：2 字节头 + DEFLATE 存储块 + Adler-32 校验
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    // 0x78 0x01：deflate、32K 窗口、最快压缩级别；0x7801 % 31 == 0 是 zlib 的校验要求
    let mut out = vec![0x78, 0x01];
    let mut i = 0usize;
    if raw.is_empty() {
        // 空输入也要有一个「最后一块」的块头，否则解压器读不到 BFINAL
        out.push(1);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    }
    while i < raw.len() {
        let n = (raw.len() - i).min(65535); // 存储块的长度字段是 u16
        let last = i + n == raw.len();
        out.push(u8::from(last)); // BFINAL(1 位) | BTYPE=00(2 位) → 整字节就是 0 或 1
        let len = n as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes()); // NLEN 是 LEN 的按位取反
        out.extend_from_slice(&raw[i..i + n]);
        i += n;
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

// PNG 块尾的 CRC 与 ZIP 条目的 CRC 是**同一条多项式**（CRC-32/ISO-HDLC），
// 已收进 `zip.rs` 一份，两边共用 —— 各写一遍迟早不一致。
use super::zip::crc32;

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521; // 小于 2^16 的最大素数
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + u32::from(byte)) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn be32(b: &[u8]) -> u32 {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }

    /// 遍历所有块，返回 `(类型, 数据)`，并**顺手校验每个块的 CRC**。
    /// CRC 错了任何解码器都会拒绝，而自己写块的时候最容易漏的就是它。
    fn parse_chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "签名不对");
        let mut out = Vec::new();
        let mut i = 8;
        while i < png.len() {
            let len = be32(&png[i..i + 4]) as usize;
            let kind = String::from_utf8(png[i + 4..i + 8].to_vec()).unwrap();
            let data = png[i + 8..i + 8 + len].to_vec();
            let want = be32(&png[i + 8 + len..i + 12 + len]);
            let got = crc32(&png[i + 4..i + 8 + len]);
            assert_eq!(got, want, "{kind} 块的 CRC 不对");
            out.push((kind, data));
            i += 12 + len;
        }
        out
    }

    /// 把存储块格式的 zlib 流解回来（只支持我们自己产出的这种）
    fn inflate_stored(z: &[u8]) -> Vec<u8> {
        assert_eq!(&z[..2], &[0x78, 0x01], "zlib 头不对");
        let mut out = Vec::new();
        let mut i = 2;
        loop {
            let header = z[i];
            assert_eq!(header >> 1, 0, "BTYPE 应当是存储块");
            let last = header & 1 == 1;
            i += 1;
            let len = u16::from_le_bytes([z[i], z[i + 1]]) as usize;
            let nlen = u16::from_le_bytes([z[i + 2], z[i + 3]]);
            assert_eq!(nlen, !(len as u16), "NLEN 应当是 LEN 的取反");
            i += 4;
            out.extend_from_slice(&z[i..i + len]);
            i += len;
            if last {
                break;
            }
        }
        let want = be32(&z[i..i + 4]);
        assert_eq!(adler32(&out), want, "Adler-32 不对");
        assert_eq!(i + 4, z.len(), "尾部有多余字节");
        out
    }

    /// 把 PNG 解回「哪些像素是黑的」—— 这是**往返验证**：
    /// 只断言「文件头是 PNG」是测不出位写反 / 行末补位写错的。
    fn decode_gray1(png: &[u8]) -> (usize, usize, Vec<Vec<bool>>) {
        let chunks = parse_chunks(png);
        assert_eq!(chunks[0].0, "IHDR");
        let ihdr = &chunks[0].1;
        assert_eq!(ihdr[8], 1, "位深应当是 1");
        assert_eq!(ihdr[9], 0, "颜色类型应当是灰度");
        assert_eq!(ihdr[12], 0, "不隔行");
        let (w, h) = (be32(&ihdr[0..4]) as usize, be32(&ihdr[4..8]) as usize);

        let idat: Vec<u8> = chunks
            .iter()
            .filter(|(k, _)| k == "IDAT")
            .flat_map(|(_, d)| d.clone())
            .collect();
        let raw = inflate_stored(&idat);
        let row_bytes = w.div_ceil(8);
        assert_eq!(raw.len(), (row_bytes + 1) * h, "扫描线总长不对");

        let mut rows = Vec::with_capacity(h);
        for y in 0..h {
            let line = &raw[y * (row_bytes + 1)..(y + 1) * (row_bytes + 1)];
            assert_eq!(line[0], 0, "滤波器应当是 None");
            let mut row = Vec::with_capacity(w);
            for x in 0..w {
                // 0 = 黑
                row.push(line[1 + x / 8] & (1 << (7 - x % 8)) == 0);
            }
            rows.push(row);
        }
        (w, h, rows)
    }

    #[test]
    fn png_round_trips_pixels_exactly() {
        let (w, h) = (13usize, 7usize);
        let src: Vec<Vec<bool>> =
            (0..h).map(|y| (0..w).map(|x| (x * 3 + y * 5) % 4 < 2).collect()).collect();
        let png = encode_gray1(w, h, |x, y| src[y][x]);
        let (gw, gh, got) = decode_gray1(&png);
        assert_eq!((gw, gh), (w, h));
        for y in 0..h {
            for x in 0..w {
                assert_eq!(got[y][x], src[y][x], "({x},{y}) 像素不符");
            }
        }
    }

    #[test]
    fn png_black_is_bit_zero_not_one() {
        // 1 位灰度里 0 = 黑。写反了图会黑白颠倒，而屏幕上只是「一张有条码形状的图」
        let png = encode_gray1(1, 1, |_, _| true); // 全黑
        let (_, _, rows) = decode_gray1(&png);
        assert!(rows[0][0], "全黑图里那个像素应当是黑的");

        let png = encode_gray1(1, 1, |_, _| false); // 全白
        let (_, _, rows) = decode_gray1(&png);
        assert!(!rows[0][0], "全白图里那个像素不该是黑的");
    }

    #[test]
    fn png_pads_rows_to_whole_bytes() {
        // 宽度不是 8 的倍数时行末要补位，且**补的是白**（0 位不置 1 就是黑，
        // 补错会把右边多出一列黑边 —— 条码静区被吃掉就扫不出来）
        for w in 1..=17usize {
            let png = encode_gray1(w, 1, |_, _| false); // 全白
            let (gw, _, rows) = decode_gray1(&png);
            assert_eq!(gw, w);
            assert!(rows[0].iter().all(|d| !*d), "宽 {w} 时行末补位补成了黑");
        }
    }

    #[test]
    fn png_chunk_order_and_types_are_correct() {
        let png = encode_gray1(8, 2, |_, _| false);
        let kinds: Vec<String> = parse_chunks(&png).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kinds, vec!["IHDR", "IDAT", "IEND"], "块顺序不对");
        // IEND 是长度 0 + "IEND" + CRC，而 IEND 的 CRC 是个众所周知的常量
        // 0xAE426082 —— 用它顺带验一次 CRC 实现
        assert_eq!(
            &png[png.len() - 12..],
            &[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82],
            "结尾应当是空 IEND（含标准 CRC）"
        );
    }

    #[test]
    fn zlib_header_passes_the_checksum_rule() {
        // zlib 要求头两字节拼成的 u16 能被 31 整除，否则解码器直接拒绝
        let z = zlib_stored(b"hello");
        let head = (u16::from(z[0]) << 8) | u16::from(z[1]);
        assert_eq!(head % 31, 0, "zlib 头 {head:#06x} 不满足 %31 规则");
    }

    #[test]
    fn zlib_handles_payloads_larger_than_one_stored_block() {
        // 存储块的长度字段是 u16，超过 65535 必须切块 ——
        // 不切的话长度会被截断，解出来的图少一大截（而 PNG 头是对的）
        let raw = vec![0xAAu8; 70000];
        let z = zlib_stored(&raw);
        assert_eq!(inflate_stored(&z), raw, "跨块的大载荷没解回原样");
    }

    #[test]
    fn zlib_handles_empty_input() {
        let z = zlib_stored(&[]);
        assert_eq!(inflate_stored(&z), Vec::<u8>::new());
    }

    #[test]
    fn crc32_matches_the_known_check_value() {
        // CRC-32/ISO-HDLC 的标准测试向量
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn adler32_matches_the_known_check_value() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(adler32(b""), 1);
    }

    #[test]
    fn degenerate_sizes_do_not_panic() {
        // 0 宽 / 0 高在真实调用里不该出现（引擎侧已经挡了），但不能崩
        let png = encode_gray1(0, 0, |_, _| false);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let (w, h, rows) = decode_gray1(&png);
        assert_eq!((w, h), (0, 0));
        assert!(rows.is_empty());
    }
}
