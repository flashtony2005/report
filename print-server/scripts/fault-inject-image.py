#!/usr/bin/env python3
"""对「图片格」这一刀做故障注入：把每处关键逻辑改回错的写法，
确认对应的测试**真的会红**。

不注入就不知道测试是「守住了」还是「碰巧是绿的」。
注入后若报编译错（error[），说明这个锚点没打准 —— 那不算验过，要重挑锚点。

用法：python3 scripts/fault-inject-image.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "src/report/xlsx.rs"
ENGINE = ROOT / "src/report/engine.rs"

CASES = [
    (
        "占位判据漏掉图片格（只放 logo 的格子会整格消失）",
        ENGINE,
        "cell.value.is_none() && cell.model.is_none() && cell.image.is_none()",
        "cell.value.is_none() && cell.model.is_none()",
        "bad_image_src_warns_and_puts_the_reason_in_text",
    ),
    (
        "px→字符用四舍五入（列比图窄，图还是得缩）",
        XLSX,
        "    let c = (f64::from(px) - 5.5) / MAX_DIGIT_WIDTH;\n    c.ceil()",
        "    let c = f64::from(px.saturating_sub(CELL_PADDING)) / MAX_DIGIT_WIDTH;\n    c.round()",
        "image_widens_its_column",
    ),
    (
        "去掉高度兜底（高图盖到下面几行去）",
        XLSX,
        "    if out_h > avail_h {\n        let k2 = f64::from(avail_h) / f64::from(out_h);\n        out_w = (f64::from(out_w) * k2).round().max(1.0) as u32;\n        out_h = avail_h;\n    }",
        "    let _ = avail_h;",
        "fit_image_scales_down_to_fit_and_centers",
    ),
    (
        "行高不夹 Excel 上限（写出 Excel 拒收的文件）",
        XLSX,
        "let need_pts = (f64::from(need_px.saturating_sub(others)) * 3.0 / 4.0).min(MAX_ROW_PTS);",
        "let need_pts = f64::from(need_px.saturating_sub(others)) * 3.0 / 4.0;\n            let _ = MAX_ROW_PTS;",
        "row_height_is_capped_at_excels_maximum",
    ),
    (
        "小图也放大（logo 被拉糊）",
        XLSX,
        "    let k = if nat_w > avail_w { f64::from(avail_w) / f64::from(nat_w) } else { 1.0 };",
        "    let k = f64::from(avail_w) / f64::from(nat_w);",
        "fit_image_never_upscales",
    ),
    (
        "合并格不扣掉其它行已占的高度（锚行撑过头）",
        XLSX,
        "            let need_pts = (f64::from(need_px.saturating_sub(others)) * 3.0 / 4.0).min(MAX_ROW_PTS);",
        "            let need_pts = (f64::from(need_px) * 3.0 / 4.0).min(MAX_ROW_PTS);\n            let _ = others;",
        "merged_image_height_is_shared_across_rows",
    ),
    (
        "撑行高时直接赋值（把换行撑出来的高行压回去）",
        XLSX,
        "            if let Some(p) = row_pts.get_mut(r) {\n                if need_pts > *p {\n                    *p = need_pts;\n                }\n            }",
        "            if let Some(p) = row_pts.get_mut(r) {\n                *p = need_pts;\n            }",
        "image_never_shrinks_an_already_tall_row",
    ),
    (
        "忽略图片 dpi（203dpi 的图大 2.1 倍）",
        XLSX,
        "    (img.width() * 96.0 / dw, img.height() * 96.0 / dh)",
        "    (img.width(), img.height())",
        "high_dpi_image_is_measured_by_physical_size",
    ),
    (
        "纵向居中只按锚行算（合并格里偏上）",
        XLSX,
        "            let avail_h: u32 =\n                (r..r + rs).filter_map(|rr| row_pts.get(rr)).map(|p| row_pixels(*p)).sum();",
        "            let avail_h: u32 = row_pts.get(r).map(|p| row_pixels(*p)).unwrap_or(20);\n            let _ = rs;",
        "merged_image_is_centered_in_the_whole_span",
    ),
    (
        "图片不撑列宽（图缩成 61px 宽）",
        XLSX,
        "            if d.w <= span_pixels(widths, c, cell.colspan) {\n                continue;\n            }",
        "            if true {\n                continue;\n            }",
        "image_widens_its_column",
    ),
    (
        "不插图（只写个空格子，图根本没进 xlsx）",
        XLSX,
        "                        ws.insert_image_with_offset(r0, c0, &img, pl.x_off, pl.y_off)\n                            .map_err(|e| e.to_string())?;",
        "                        let _ = (&img, pl.x_off, pl.y_off);",
        "xlsx_embeds_image_bytes_and_drawing",
    ),
    (
        "HTML 预览不出 img（预览看不到图）",
        ROOT / "src/report/mod.rs",
        '                        format!(\n                            "<img src=\\"{}\\" alt=\\"{}\\" style=\\"max-width:100%;height:auto\\">",\n                            escape(src),\n                            escape(&alt)\n                        )',
        "                        { let _ = (src, alt); escape(&cell.text) }",
        "html_preview_emits_img_for_image_cells",
    ),
]


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def main():
    failures = []
    for name, path, old, new, test in CASES:
        src = path.read_text(encoding="utf-8")
        if old not in src:
            print(f"✗ 锚点没找到，跳过（这一条**没验过**）：{name}")
            failures.append(name)
            continue
        path.write_text(src.replace(old, new, 1), encoding="utf-8")
        try:
            # **不要加 `--exact`**：它要求给全路径（`report::xlsx::tests::xxx`），
            # 只给函数名的话一个用例都匹配不到、退出码仍是 0 ——
            # 那样每条注入都会被判成「仍然是绿的」。子串匹配就够了。
            r = run(["cargo", "test", test])
            out = r.stdout + r.stderr
            ran = [ln for ln in out.splitlines() if ln.startswith("test result:")]
            if "error[E" in out or "could not compile" in out:
                verdict = "编译不过（锚点没打准，不算验过）"
                failures.append(name)
            elif not ran or "0 passed" in ran[0] and "0 failed" in ran[0]:
                # 没跑到任何用例 = 这一条**没验过**，不能算绿
                verdict = "**一个用例都没跑到** ✗"
                failures.append(name)
            elif "FAILED" in ran[0]:
                verdict = "如期变红 ✓"
            else:
                verdict = f"**仍然是绿的** ✗（{ran[0]}）"
                failures.append(name)
        finally:
            path.write_text(src, encoding="utf-8")
        print(f"{verdict}  {name}  →  {test}")

    print()
    if failures:
        print(f"有 {len(failures)} 条没验成：")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print(f"全部 {len(CASES)} 条注入都如期变红。")


if __name__ == "__main__":
    main()
