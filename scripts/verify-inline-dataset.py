#!/usr/bin/env python3
"""内联数据集（`RenderRequest.datasets`）的真机探针 —— C 类「文件数据集」的落地验证。

## 这个探针要证什么

单测只证到「解析器把 CSV 变成了什么行」「请求体长什么样」。中间那一段 ——
**服务端拿到 `datasets` 到底渲不染得出、数字到底算不算得对** —— 只能真机跑。

## 为什么必须用**真解析器**产出行，而不是在 Python 里手搓

最容易坏的地方正是**两半的接缝**：解析器产出的键名 / null 处理 / 数值类型，
和服务端期望的是否一致。手搓的行可能恰好对上，而真解析器的输出对不上 ——
那就等于没测。所以这里用 node 的 `--experimental-strip-types` **直接跑
`openprint/src/report/dataset-import.ts`**（它零依赖，剥掉类型就能执行）。

## 核心那条：字符串数字「合计对、导出错」

`Val::as_num()`（`engine.rs:487`）对字符串会 `parse::<f64>()`，所以**求和是对的**；
而 `display()`（`engine.rs:3545`）对字符串给 `raw_number: None`，
`xlsx.rs:623` 于是走 `write_string` → **导出成文本格**。

`case_string_amounts_sum_right_but_export_as_text` 就是钉这个：
同一份数据、同样的合计，但**明细格**一个进 `<v>`、一个进 sharedStrings。
预览完全看不出来 —— 只有打开导出的文件才知道。

用法（先起服务）：
    cd print-server && cargo build && ~/.cargo/target/debug/print-server &
    python3 scripts/verify-inline-dataset.py
    python3 scripts/verify-inline-dataset.py --dump

退出码：0 = 全部符合；1 = 有不符合；2 = 服务连不上 / node 跑不起来。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

SERVER = "http://127.0.0.1:18888"
ROOT = Path(__file__).resolve().parent.parent
PARSER_TS = ROOT / "openprint" / "src" / "report" / "dataset-import.ts"

# ⚠️ 沙箱里 `HTTP_PROXY` 指向本地代理，探 127.0.0.1 会被拦成 **502**（看着像服务没起来）。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

fails: list[str] = []
dumps: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        fails.append(msg)


def http(path: str, body=None, method: str | None = None) -> tuple[int, bytes]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        SERVER + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if body is not None else "GET"),
    )
    try:
        with _OPENER.open(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ---------------------------------------------------------------- 真解析器

def _node_bin() -> str:
    """和 shell 脚本同一套探测顺序，避免又写死一个会随环境重发的版本号。"""
    base = Path.home() / ".workbuddy-ai" / "binaries" / "node"
    env = os.environ.get("NODE_BIN")
    if env and Path(env).is_file():
        return env
    cur = base / "versions" / "current"
    if cur.is_file():
        v = cur.read_text().strip()
        cand = base / "versions" / v / "bin" / "node"
        if cand.is_file():
            return str(cand)
    cands = sorted((base / "versions").glob("*/bin/node"))
    if cands:
        return str(cands[-1])
    raise RuntimeError("找不到可用的 node（见 scripts/node-bin.sh）")


def parse_csv_with_real_parser(csv_text: str) -> dict:
    """把 CSV 交给**真的** TS 解析器，取回 `{columns, rows}`。

    node 22 的 `--experimental-strip-types` 能直接跑零依赖的 TS ——
    不需要先编译，也就不存在「探针跑的是另一份转译产物」的问题。
    """
    helper = f"""
import {{ parseCsv }} from {json.dumps(str(PARSER_TS))}
import {{ readFileSync }} from 'node:fs'
const out = parseCsv(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(out))
"""
    with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as f:
        f.write(helper)
        path = f.name
    try:
        proc = subprocess.run(
            [_node_bin(), "--experimental-strip-types", path],
            input=csv_text,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"解析器跑失败：{proc.stderr[-500:]}")
        return json.loads(proc.stdout)
    finally:
        os.unlink(path)


def sample_template_without_datasets() -> dict:
    """拿样例模板，**摘掉它自带的内联数据**。

    样例模板本身带了 `datasets.ds1`（所以 `datasets: None` 也能渲染）。

    ⚠️ **摘掉它，不是因为「不摘就会测到旧数据」** —— 实测过，`render()` 里是
    `tpl.datasets.extend(ds)`（`mod.rs:114`），而 `BTreeMap::extend` 对**同名键是覆盖**，
    所以请求体的 `ds1` 本来就会盖掉模板自带的 `ds1`。
    （故障注入 #3 原本就是按「不摘就会红」写的，结果**没红** —— 错的是那个前提。）

    保留这一步是为了**不依赖那个细节**：探针要验的是「请求体的 datasets 生效」，
    那就让模板里根本没有同名数据，判据才单一。
    「请求体覆盖模板自带」这个语义由 `case_request_datasets_override_template_embedded` 单独钉。
    """
    st, body = http("/api/report/sample-template")
    assert st == 200, f"取样例模板失败：{st}"
    tpl = json.loads(body)
    assert "datasets" in tpl, "样例模板里居然没有 datasets —— 这个探针的前提变了，先看源码"
    tpl.pop("datasets", None)
    return tpl


def case_request_datasets_override_template_embedded() -> None:
    """模板**自带** datasets 时，请求体的同名 datasets 会**覆盖**它。

    这条是故障注入 #3 没红之后补的：既然「覆盖」是真实语义，就该**钉住**它，
    而不是让探针绕开它 —— 否则哪天 `extend` 被改成「已存在就不动」，
    设计器里「打开一张自带数据的报表、再喂一份文件数据」就会**静默用旧数据**。
    """
    st, body = http("/api/report/sample-template")
    assert st == 200, f"取样例模板失败：{st}"
    tpl = json.loads(body)  # 刻意**不** pop，带着自带 datasets
    assert "datasets" in tpl, "前提变了：样例模板不再自带 datasets"

    st, body = http(
        "/api/report/render",
        {
            "template": tpl,
            "datasets": {"ds1": parse_csv_with_real_parser(CSV_BASIC)["rows"]},
            "sources": None,
            "dump": None,
        },
    )
    check(st == 200, f"渲染失败：{st} {body[:200]!r}")
    if st != 200:
        return
    texts = all_texts(json.loads(body))
    check(str(TOTAL) in texts, f"请求体的 ds1 应当覆盖模板自带的 ds1（合计 {TOTAL}），实际没有：{texts[:30]}")
    # 样例自带那 10 行的总计是 116400；出现它就说明用的是模板里那份
    check("116400" not in texts, "渲染用的是模板自带的 ds1，不是请求体那份 —— 覆盖没生效？")


def render_with(rows: list[dict]) -> tuple[int, dict]:
    """按 `buildRenderRequest` 的样子发请求：模板无 datasets，行走请求体。"""
    st, body = http(
        "/api/report/render",
        {"template": sample_template_without_datasets(), "datasets": {"ds1": rows}, "sources": None, "dump": None},
    )
    if st != 200:
        return st, {"error": body.decode("utf8", "ignore")}
    return st, json.loads(body)


def xlsx_with(rows: list[dict]) -> tuple[int, str, str]:
    """导出 xlsx，返回 (状态, sheet XML, sharedStrings 文本)。"""
    st, buf = http(
        "/api/report/xlsx",
        {"template": sample_template_without_datasets(), "datasets": {"ds1": rows}, "sources": None, "dump": None},
    )
    if st != 200:
        return st, "", ""
    z = zipfile.ZipFile(io.BytesIO(buf))
    names = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    sheet = z.read(names[0]).decode("utf8", "ignore") if names else ""
    ss = z.read("xl/sharedStrings.xml").decode("utf8", "ignore") if "xl/sharedStrings.xml" in z.namelist() else ""
    return st, sheet, ss


def grid_cells(resp: dict) -> list[dict]:
    out: list[dict] = []
    for s in resp.get("sheets") or []:
        for row in s.get("rows") or []:
            out.extend(row)
    return out


def cell_with_text(resp: dict, text: str) -> dict | None:
    for c in grid_cells(resp):
        if (c.get("text") or "").strip() == text:
            return c
    return None


def all_texts(resp: dict) -> list[str]:
    return [(c.get("text") or "").strip() for c in grid_cells(resp)]


# ---------------------------------------------------------------- 用例

# 用样例模板的字段（region / city / salesman / amount），金额合计刻意好算
CSV_BASIC = "region,city,salesman,amount\n华东,上海,张三,100\n华东,上海,李四,200\n华南,广州,孙七,300\n"
TOTAL = 600


def case_basic_inline_dataset_renders() -> None:
    """请求体里的 datasets 真的被用上了：分组标签与合计都对。

    ⚠️ 前提是模板自带的 datasets 被摘掉了（见 `sample_template_without_datasets`）——
    否则这条会「通过」但什么都没验到。
    """
    parsed = parse_csv_with_real_parser(CSV_BASIC)
    check(parsed["columns"] == ["region", "city", "salesman", "amount"], f"列名不对：{parsed['columns']}")
    rows = parsed["rows"]
    check(len(rows) == 3, f"应当解析出 3 行，实际 {len(rows)}")

    st, resp = render_with(rows)
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    if st != 200:
        return

    texts = all_texts(resp)
    for label in ("华东", "华南", "上海", "广州", "张三", "孙七"):
        check(label in texts, f"渲染结果里没有「{label}」—— datasets 没被用上？")
    check(str(TOTAL) in texts, f"合计应当是 {TOTAL}，结果里没有；文本前 30：{texts[:30]}")

    # 合计必须是**数字**（否则导出会写成文本格）
    tot = cell_with_text(resp, str(TOTAL))
    check(tot is not None and tot.get("raw_number") == TOTAL, f"合计格不是数字：{tot}")


def case_number_detail_is_numeric_in_xlsx() -> None:
    """解析器转出来的数字，导出到 xlsx 是**数值格**（`<v>`），不是文本。"""
    rows = parse_csv_with_real_parser(CSV_BASIC)["rows"]
    st, sheet, ss = xlsx_with(rows)
    check(st == 200, f"导出失败：{st}")
    if st != 200:
        return
    dumps.append(("xlsx sheet（数字）", sheet))
    check("<v>100</v>" in sheet, "明细 100 没有写成数值格 —— 数字被当成文本导出了")
    check("100" not in ss, f"明细 100 进了 sharedStrings（= 文本格）：{ss[:400]}")


def case_string_amounts_sum_right_but_export_as_text() -> None:
    """**核心那条**：金额全是字符串时，合计仍然对，但明细导出成文本格。

    这是「为什么 CSV 必须做数值推断」的完整证据链：
    - 合计对 → 预览 / 页面看不出来任何异常（`as_num` 会 parse）
    - 明细进 sharedStrings → 导出的 xlsx 里那是文本，不右对齐、不进 Excel 算术
    """
    rows = [
        {"region": "华东", "city": "上海", "salesman": "张三", "amount": "100"},
        {"region": "华东", "city": "上海", "salesman": "李四", "amount": "200"},
        {"region": "华南", "city": "广州", "salesman": "孙七", "amount": "300"},
    ]
    st, resp = render_with(rows)
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    if st == 200:
        texts = all_texts(resp)
        # ① 合计**照样是对的** —— 所以「看着没问题」
        check(str(TOTAL) in texts, f"字符串数字的合计也该是 {TOTAL}（as_num 会 parse），实际没有：{texts[:30]}")
        # ② 但明细格没有 raw_number → 导出会是文本
        detail = cell_with_text(resp, "100")
        check(detail is not None, "明细 100 不在渲染结果里")
        check(
            detail is not None and "raw_number" not in detail,
            f"字符串金额的明细格不该有 raw_number（有的话说明服务端已经转过了）：{detail}",
        )

    st, sheet, ss = xlsx_with(rows)
    check(st == 200, f"导出失败：{st}")
    if st == 200:
        dumps.append(("xlsx sheet（字符串）", sheet))
        dumps.append(("sharedStrings（字符串）", ss))
        check("<v>100</v>" not in sheet, "字符串金额居然写成了数值格 —— 那这条对照就失效了")
        check("100" in ss, f"字符串金额没进 sharedStrings（= 没导出成文本格）：{ss[:400]}")


def case_parser_conservatism_survives_the_whole_chain() -> None:
    """保守规则要**穿透整条链**：`3.50` / `007` 一路到渲染都保持原样。

    解析器不把它们转数字（往返不一致），那么服务端看到的就该是字符串，
    渲染出来的文本也就该是 `3.50` / `007`，而不是被规范化成 `3.5` / `7`。
    """
    csv = "region,city,salesman,amount\n华东,上海,甲,3.50\n华东,上海,乙,007\n"
    rows = parse_csv_with_real_parser(csv)["rows"]
    check(rows[0]["amount"] == "3.50", f"3.50 应当保持字符串，实际 {rows[0]['amount']!r}")
    check(rows[1]["amount"] == "007", f"007 应当保持字符串，实际 {rows[1]['amount']!r}")

    st, resp = render_with(rows)
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    if st != 200:
        return
    texts = all_texts(resp)
    check("3.50" in texts, f"渲染后 3.50 变了样（被规范化了？）：{texts[:30]}")
    check("007" in texts, f"渲染后 007 变了样（前导零被吃掉？）：{texts[:30]}")
    check("3.5" not in texts, "出现了 3.5 —— 说明 3.50 被当成数字转过了")
    check("7" not in texts, "出现了 7 —— 说明 007 被当成数字转过了")


def case_sources_win_over_datasets() -> None:
    """两条通道同时给、且同名时：**`sources` 覆盖 `datasets`**（`mod.rs:491`）。

    这解释了前端为什么必须**二选一**（`buildRenderRequest` 里 `dataChannel` 只发一条）。
    用一个必然失败的库来判定走的是哪条：如果 datasets 生效，这次渲染会成功。
    """
    st, body = http(
        "/api/report/render",
        {
            "template": sample_template_without_datasets(),
            "datasets": {"ds1": parse_csv_with_real_parser(CSV_BASIC)["rows"]},
            "sources": [
                {
                    "name": "ds1",
                    "engine": "sqlite",
                    "database": "/definitely/not/here.db",
                    "table": "t",
                }
            ],
            "dump": None,
        },
    )
    check(st != 200, f"同名 sources 应当覆盖 datasets 并因取数失败报错，实际 {st}")
    err = body.decode("utf8", "ignore")
    check("取数失败" in err or "不存在" in err, f"错误文案没体现是取数失败：{err[:200]}")


def case_empty_dataset_does_not_crash() -> None:
    """空数组：服务端**不该 500**。前端的守卫（`inlineRows` 为空就报错）在更外层，
    但 API 直接调用者可以绕过它 —— 这里只要求「不崩」，把行为记下来。"""
    st, body = http(
        "/api/report/render",
        {"template": sample_template_without_datasets(), "datasets": {"ds1": []}, "sources": None, "dump": None},
    )
    check(st == 200, f"空数据集不该 500，实际 {st} {body[:200]!r}")
    if st == 200:
        resp = json.loads(body)
        dumps.append(("空数据集的 warnings", json.dumps(resp.get("warnings"), ensure_ascii=False, indent=2)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="打印 xlsx XML 片段")
    args = ap.parse_args()

    # 先确认服务在（连不上就别把「502 / 拒连」当成用例失败）
    try:
        st, _ = http("/api/report/sample-template")
    except Exception as e:  # noqa: BLE001
        print(f"连不上 {SERVER}：{type(e).__name__}: {e}", file=sys.stderr)
        print("先起服务：cd print-server && cargo build && ~/.cargo/target/debug/print-server &", file=sys.stderr)
        return 2
    if st != 200:
        print(f"{SERVER} 响应异常：{st}", file=sys.stderr)
        return 2

    for fn in (
        case_basic_inline_dataset_renders,
        case_request_datasets_override_template_embedded,
        case_number_detail_is_numeric_in_xlsx,
        case_string_amounts_sum_right_but_export_as_text,
        case_parser_conservatism_survives_the_whole_chain,
        case_sources_win_over_datasets,
        case_empty_dataset_does_not_crash,
    ):
        before = len(fails)
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            fails.append(f"{fn.__name__} 抛异常：{type(e).__name__}: {e}")
        print(f"{'✓' if len(fails) == before else '✗'} {fn.__name__}")

    if args.dump:
        for title, text in dumps:
            print(f"\n--- {title} ---")
            print(text[:3000])

    if fails:
        print("\n✗ 不通过：")
        for e in fails:
            print("  -", e)
        return 1
    print("\n✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
