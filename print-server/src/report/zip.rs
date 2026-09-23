//! 最小 ZIP 写出器 —— 只写「存储」条目（method 0），**不压缩**
//!
//! ## 为什么自研
//!
//! `Cargo.toml` 里没有 zip crate（`zip 8.6.0` 只在依赖树里，是别的 crate 间接带的，
//! 提升成直接依赖也是一行的事）—— 但 docx 一共就 4~5 个小 XML，而 **ZIP 规范允许
//! 条目不压缩**（method 0），Word / Pages / 任何解压器都认。既然可以不压缩，
//! 就不需要 deflate 编码器，整个写出器只剩「头 + 数据 + 中央目录」这点结构。
//! 沿用 `png.rs` / `chartkit` 的路子。
//!
//! ⚠️ 不压缩的代价是文件大。报表 XML 里文本占多数，实测量级是「压缩后 1/5」——
//! 但 docx 是给人存档 / 发出的，几百 KB 无所谓。**哪天要塞图片进去再考虑 deflate**，
//! 那时按「引 `flate2` 还是自研」权衡，别默认自研。
//!
//! ## CRC-32 从 `png.rs` 搬来
//!
//! PNG 块尾的 CRC 和 ZIP 条目的 CRC 是**同一条多项式**（CRC-32/ISO-HDLC），
//! 收成一份，`png.rs` 反过来用这里的 —— 两处各写一遍迟早会不一致。
//!
//! ## 关于「能不能真的被读出来」
//!
//! **这个模块自己证明不了**。它能保证的只有「字节结构符合 APPNOTE 6.3.x」，
//! 真正读它的是解压器 —— 由 `scripts/verify-docx.py` 用 Python 的 `zipfile`
//! （另一个实现）读回来验证。**别把下面的单测当成「zip 能用」的证据。**

/// CRC-32（ISO-HDLC 多项式，与 zlib / PNG 同一条）
pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 固定时间戳：2020-01-01 00:00
///
/// **刻意写死**，不取当前时间 —— 否则同样的报表每次导出字节都不同，
/// 探针就没法做「逐字节比对」，也让「改一行代码看 diff」变得不可能。
/// ZIP 的 DOS 时间字段精度只有 2 秒，本来也不承载有用信息。
const DOS_TIME: u16 = 0x0000;
const DOS_DATE: u16 = (2020 - 1980) << 9 | 1 << 5 | 1; // 年<<9 | 月<<5 | 日

/// 把若干条目写成一个 ZIP（全部 method 0 = 存储）
///
/// `entries` 是 `(包内路径, 内容)`，按**给定顺序**写入。
/// 顺序对 docx 有一点讲究：`[Content_Types].xml` 习惯上放第一个（OPC 读取器
/// 有的会先找它），所以调用方把它排在最前面就行，这里不重排。
pub(crate) fn zip_stored(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();

    for (name, data) in entries {
        let name_b = name.as_bytes();
        offsets.push(out.len() as u32);
        let crc = crc32(data);

        // ---- 本地文件头（APPNOTE 4.3.7）----
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // 签名 'PK\x03\x04'
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0
        out.extend_from_slice(&0u16.to_le_bytes()); // flags（名字是 ASCII，不用 UTF-8 位）
        out.extend_from_slice(&0u16.to_le_bytes()); // method 0 = 存储
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 压缩后大小
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 原始大小（存储时相同）
        out.extend_from_slice(&(name_b.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra 长度
        out.extend_from_slice(name_b);
        out.extend_from_slice(data);
    }

    let cd_offset = out.len() as u32;
    for ((name, data), offset) in entries.iter().zip(offsets) {
        let name_b = name.as_bytes();
        let crc = crc32(data);

        // ---- 中央目录条目（APPNOTE 4.3.12）----
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // 'PK\x01\x02'
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_b.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // 注释
        central.extend_from_slice(&0u16.to_le_bytes()); // 起始磁盘号
        central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
        central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_b);
    }

    // ---- 中央目录结束记录（APPNOTE 4.3.16）----
    let n = entries.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes()); // 'PK\x05\x06'
    out.extend_from_slice(&0u16.to_le_bytes()); // 本磁盘号
    out.extend_from_slice(&0u16.to_le_bytes()); // 中央目录所在磁盘
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes([b[i], b[i + 1]])
    }
    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }

    /// CRC-32/ISO-HDLC 的标准测试向量 —— 这条过了，CRC 实现就是对的
    #[test]
    fn crc32_matches_the_known_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn local_header_has_the_expected_shape() {
        let z = zip_stored(&[("a.txt", b"hello")]);
        assert_eq!(&z[..4], &[0x50, 0x4b, 0x03, 0x04], "本地头签名");
        assert_eq!(u16_at(&z, 8), 0, "method 必须是 0（存储）");
        assert_eq!(u32_at(&z, 14), crc32(b"hello"), "CRC 要写对");
        assert_eq!(u32_at(&z, 18), 5, "压缩后大小");
        assert_eq!(u32_at(&z, 22), 5, "原始大小（存储时等于压缩后）");
        assert_eq!(u16_at(&z, 26), 5, "名字长度");
        assert_eq!(&z[30..35], b"a.txt");
        assert_eq!(&z[35..40], b"hello");
    }

    /// 中央目录的偏移必须真的指向本地头 —— 写错了解压器会读到垃圾
    #[test]
    fn central_directory_offsets_point_at_local_headers() {
        let z = zip_stored(&[("one", b"aaa"), ("two", b"bbbb")]);
        let eocd = z.len() - 22;
        assert_eq!(u32_at(&z, eocd), 0x0605_4b50, "EOCD 签名");
        assert_eq!(u16_at(&z, eocd + 10), 2, "条目数");
        let cd_off = u32_at(&z, eocd + 16) as usize;
        let cd_size = u32_at(&z, eocd + 12) as usize;
        assert_eq!(cd_off + cd_size, eocd, "中央目录应紧挨 EOCD");

        // 第一条：中央目录条目 46 字节头 + 名字
        let c0 = cd_off;
        assert_eq!(u32_at(&z, c0), 0x0201_4b50, "中央目录签名");
        assert_eq!(u32_at(&z, c0 + 42), 0, "第一条的本地头偏移应为 0");
        let c1 = c0 + 46 + 3; // "one" 三个字节
        // 30（本地头）+ 3（"one"）+ 3（"aaa"）
        assert_eq!(u32_at(&z, c1 + 42), 36, "第二条本地头偏移应是 36");
        assert_eq!(&z[cd_off + 46..cd_off + 49], b"one");
    }

    /// 条目数写在两处（EOCD 的「本磁盘」和「总计」），两处必须一致
    #[test]
    fn entry_counts_agree() {
        let z = zip_stored(&[("x", b"")]);
        let e = z.len() - 22;
        assert_eq!(u16_at(&z, e + 8), 1);
        assert_eq!(u16_at(&z, e + 10), 1);
    }

    /// 空条目（0 字节）也要能写 —— docx 里不会有，但写错时最容易崩在这里
    #[test]
    fn empty_entry_is_written() {
        let z = zip_stored(&[("e", b"")]);
        assert_eq!(u32_at(&z, 18), 0);
        assert_eq!(u32_at(&z, 22), 0);
        assert_eq!(u32_at(&z, 14), 0, "空数据的 CRC 是 0");
    }

    /// 同样的输入必须产出同样的字节 —— 时间戳写死了才能做到，
    /// 探针要做逐字节比对，这个性质不能破
    #[test]
    fn output_is_deterministic() {
        let a = zip_stored(&[("a", b"1"), ("b", b"2")]);
        let b = zip_stored(&[("a", b"1"), ("b", b"2")]);
        assert_eq!(a, b);
    }
}
