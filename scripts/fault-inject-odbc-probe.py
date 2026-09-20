#!/usr/bin/env python3
"""
给 **ODBC 真机探针自己**做故障注入：往源码里塞已知的错，确认 `verify-odbc.py` 真的会红。

不注入就不知道探针是「守住了」还是「碰巧是绿的」——
这个项目已经在「测试全绿但功能是坏的」上栽过好几次。探针本身也是代码，
它读错了字段、算错了逆变换，照样一片绿。

**两组，各自验一半**，不能只做一组：
  - `CASES`    → `db_odbc.rs`，编 `--features odbc`，跑 `verify-odbc.py`
                 （验「能连上且连对」：目录转义 / 类型解码 / 注入面 / 主键 / 参数绑定）
  - `OFF_CASES`→ `db.rs`，编默认（无 feature），跑 `verify-odbc.py --expect-off`
                 （验「拒绝的措辞」：必须说「没编进这个构建」而不是「暂未实现」）
只测开着 feature 的那条路，会漏掉默认构建下页面/接口说什么这一半 ——
而那正是用户实际会看到的东西。

用法：python3 scripts/fault-inject-odbc-probe.py
      （每条注入都会重新 cargo build，两组加起来十几次，会慢一点）
退出码：0 = 每条注入都如期变红；1 = 有注入没抓到（探针的漏网）。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "print-server/src/db_odbc.rs"
PROBE = ROOT / "scripts/verify-odbc.py"

# (说明, 原片段, 换成)
CASES = [
    (
        "目录函数的表名不转义（_ 被当通配符，userXname 的字段混进来）",
        "        if matches!(ch, '\\\\' | '%' | '_') {\n            out.push('\\\\');\n        }\n",
        "",
    ),
    (
        "全部按文本取（整数 / 浮点变字符串，报表 sum() 会静默算错）",
        "        DataType::Integer | DataType::SmallInt | DataType::BigInt | DataType::TinyInt => {\n"
        "            let mut v = Nullable::<i64>::null();\n"
        "            row.get_data(idx, &mut v).map_err(bad)?;\n"
        "            Ok(v.into_opt().map_or(Value::Null, |n| json!(n)))\n"
        "        }\n",
        "        DataType::Integer | DataType::SmallInt | DataType::BigInt | DataType::TinyInt => {\n"
        "            let mut buf = Vec::new();\n"
        "            let not_null = row.get_text(idx, &mut buf).map_err(bad)?;\n"
        "            if !not_null { Ok(Value::Null) } else { Ok(Value::String(String::from_utf8_lossy(&buf).into_owned())) }\n"
        "        }\n",
    ),
    (
        "where 不设防（语句分隔符 / 注释放行）",
        "    for (pat, why) in [\n"
        "        (\";\", \"语句分隔符\"),\n"
        "        (\"--\", \"行注释\"),\n"
        "        (\"/*\", \"块注释\"),\n"
        "        (\"*/\", \"块注释\"),\n"
        "    ] {\n"
        "        if w.contains(pat) {\n"
        "            return Err(format!(\n"
        "                \"where 里不允许出现「{pat}」（{why}），已拒绝（防注入）\"\n"
        "            ));\n"
        "        }\n"
        "    }\n",
        "    let _ = w;\n",
    ),
    (
        "表名不做目录校验（任意表名都放行）",
        "    let hit = tables.iter().find(|t| {\n"
        "        let n = t[\"name\"].as_str().unwrap_or(\"\");\n"
        "        n == table || n.rsplit('.').next() == Some(table)\n"
        "    });\n",
        "    let hit = tables.iter().find(|_t| true);\n",
    ),
    (
        "不读主键（PRI 全丢）",
        "            pk: pk_cols.iter().any(|p| p == &name),\n",
        "            pk: false,\n",
    ),
    (
        "不绑参数（带 where 的取数直接失败）",
        "    let bound: Vec<OdbcText> = params\n"
        "        .iter()\n"
        "        .map(|v| param_text(v).into_parameter())\n"
        "        .collect();\n",
        "    let bound: Vec<OdbcText> = Vec::new();\n",
    ),
    (
        "total 恒为 0（不跑 COUNT）",
        "                v.into_opt().unwrap_or(0)\n",
        "                0\n",
    ),
    (
        "nullable 恒为 true（非空约束读不到）",
        "            nullable: row.nullable != 0,\n",
        "            nullable: true,\n",
    ),
]

# 「没编 feature」那条路的注入。目标文件 / 编译参数 / 探针参数都不同，所以单独一组：
# 这一组验的是**拒绝的措辞**。把措辞改回「暂未实现」，`--expect-off` 必须变红 ——
# 否则探针里那两条「不能说暂未实现」的断言就只是摆设。
SRC_DB = ROOT / "print-server/src/db.rs"
OFF_CASES = [
    (
        "把「没编进这个构建」改回「暂未实现」（措辞退化）",
        SRC_DB,
        '"ODBC 引擎没有编进这个构建：需要 `cargo build --features odbc`，\\',
        '"ODBC 引擎暂未实现：需要 `cargo build --features odbc`，\\',
    ),
]

# 编着 feature 时跑，但验的是**能力位**而不是引擎行为：配置页不再写死
# 「暂未实现」，改成读 `/health.odbc` —— 这个位一旦撒谎，页面就跟着撒谎。
SRC_HEALTH = ROOT / "print-server/src/health.rs"
HEALTH_CASES = [
    (
        "/health 谎报「没编入 ODBC」（配置页会跟着说谎）",
        SRC_HEALTH,
        '        "odbc": cfg!(feature = "odbc"),\n',
        '        "odbc": false,\n',
    ),
]


def run_probe(expect_off: bool = False) -> tuple[bool, str]:
    """跑探针，返回 (是否全绿, 末尾输出)。"""
    args = [sys.executable, str(PROBE)] + (["--expect-off"] if expect_off else [])
    p = subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True)
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode == 0, out


def build(with_feature: bool = True) -> tuple[bool, str]:
    args = ["cargo", "build"] + (["--features", "odbc"] if with_feature else [])
    p = subprocess.run(args, cwd=str(ROOT / "print-server"), capture_output=True, text=True)
    return p.returncode == 0, (p.stdout or "") + (p.stderr or "")


def run_group(cases, expect_off: bool, originals: dict) -> list[str]:
    """跑一组注入，返回「没被抓到」的说明列表。

    每组各自的编译参数不同（`--features odbc` vs 默认），所以 with_feature
    由 expect_off 推出来 —— 两件事必须同进同退，写死一个就会验错构建。
    """
    missed: list[str] = []
    for desc, path, old, new in cases:
        original = originals[path]
        if old not in original:
            print(f"✗ 注入点找不到（源码变了？）：{desc}")
            missed.append(f"{desc}（锚点失配）")
            continue
        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            built, bout = build(with_feature=not expect_off)
            if not built:
                print(f"✗ 注入后编译不过（注入写错了）：{desc}\n{bout[-800:]}")
                missed.append(f"{desc}（编译失败）")
                continue
            green, out = run_probe(expect_off=expect_off)
            if green:
                print(f"✗ 探针**没抓到**：{desc}")
                missed.append(desc)
            else:
                # 报出探针抓到的那几条，证明是「因为这条注入」变红的
                bad = [l.strip() for l in out.splitlines() if l.strip().startswith("✗")]
                # 明细行是「✗ 某条断言」，汇总行是「✗ N 条断言失败：」——
                # 汇总行在**最后**，所以不能直接取 bad[0]/bad[1]，要挑掉它
                detail = next((l for l in bad if "条断言失败" not in l), bad[0] if bad else "")
                if not detail and "Traceback" in out:
                    detail = "探针自己崩了（见输出），不算干净的抓到"
                print(f"  ✓ 抓到：{desc}\n      → {detail[:110]}")
        finally:
            path.write_text(original, encoding="utf-8")
    return missed


def main() -> int:
    originals = {
        SRC: SRC.read_text(encoding="utf-8"),
        SRC_DB: SRC_DB.read_text(encoding="utf-8"),
        SRC_HEALTH: SRC_HEALTH.read_text(encoding="utf-8"),
    }
    groups = [
        # CASES 是 (说明, 原片段, 换成) 三元组（都在 db_odbc.rs 里），
        # 这里补上目标文件，统一成 run_group 要的四元组
        (
            "--features odbc",
            True,
            False,
            [(d, SRC, o, n) for d, o, n in CASES] + HEALTH_CASES,
        ),
        ("默认构建（无 feature）", False, True, OFF_CASES),
    ]

    print("先确认两组探针本身都是绿的（不然注入结果没意义）…")
    for label, with_feature, expect_off, _ in groups:
        built, bout = build(with_feature=with_feature)
        if not built:
            print(f"✗ {label} 编不过，先修代码：\n{bout[-800:]}")
            return 1
        ok, out = run_probe(expect_off=expect_off)
        if not ok:
            print(f"✗ 未注入时探针（{label}）就是红的，先修探针：")
            print(out[-2000:])
            return 1
        print(f"  ✓ 基线绿（{label}）")
    print()

    missed: list[str] = []
    total = 0
    try:
        for _, _, expect_off, cases in groups:
            total += len(cases)
            missed += run_group(cases, expect_off, originals)
    finally:
        for path, text in originals.items():
            path.write_text(text, encoding="utf-8")
        # 两组注入各编过一次，还原后两种配置都要重编，别把注入版留在 target 里
        build(with_feature=True)
        build(with_feature=False)

    print()
    if missed:
        print(f"✗ {len(missed)} 条注入没被抓到：")
        for m in missed:
            print(f"    - {m}")
        return 1
    print(f"✓ 全部 {total} 条注入都被探针抓到")
    return 0


if __name__ == "__main__":
    sys.exit(main())
