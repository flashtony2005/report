#!/usr/bin/env python3
"""给「报表存盘」这条路径做故障注入：把**原子写**拆回非原子写，确认单测真的会红。

## 为什么必须做

原子写的价值全在**失败路径**上：「写到一半出事时目标文件还是旧的」。
而失败路径**平时不执行** —— 一组恒绿的用例和一组真的有牙齿的用例，
在成功路径上长得**一模一样**。所以「用例全绿」必须先证明「把实现改坏它会红」。

## 三条注入，各拆一个**互相独立**的机制

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| A 去原子性 | `写 .tmp → rename` 改成**直接写目标文件** | `写入失败时目标文件仍是旧的完整内容`（单测）**+** 真机探针 |
| B 去备份 | 删掉 `.bak` 拷贝 | `覆盖时留下上一版备份` |
| C 放宽列表判据 | `extension()=="json"` → `file_name().contains(".json")` | `备份与临时文件不进报表列表` |

注入 A **故意挂两道门禁**：单测（造「写入失败」）与真机探针
（造「写一半进程被杀」，靠 `RLIMIT_FSIZE` + SIGXFSZ）。
两道都红了，才说明「原子性」这件事在两个层次上都被守住 ——
只红一道时，另一道可能是摆设。

**A 的锚点只包住「原子性」那三行，不碰 `create_dir_all`。**
这一条是踩出来的：第一版把 `save()` 里整句 `write_atomic(&path, &text)?;`
换成 `std::fs::write(&path, text)?`，结果**连 `create_dir_all` 一起删掉了**，
于是 `由配置路径推出的目录能存能列` 也红了 —— 而它红的原因是
`No such file or directory`（目录都没建），**跟原子性毫无关系**。
那种注入会让人误以为「有 3 条用例守住了原子性」，其实只有 2 条。
**注入的锚点要恰好包住被测的那个机制，多一行都是噪声。**

同理，注入 C 第一版写的是 `ends_with(".json")` —— **它抓不到**，因为
`foo.json.bak` 并不以 `.json` 结尾。真正会漏的是 `contains(".json")`。
**注入没红时先怀疑注入**（`fault-injection-verify` 纪律 3），别去改用例。

## 「真的跑了」必须单独判

`cargo test <过滤名>` 在**匹配不到任何用例时仍然返回 0** → 打错用例名会伪装成
「通过」。所以下面数输出里真的出现了几条 `... ok` / `... FAILED`。

用法：python3 scripts/fault-inject-atomic-save.py
退出码：0 = 所有注入都被对应门禁抓到，且文件逐字节还原；1 = 有漏网。
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "print-server" / "src" / "report" / "store.rs"

# 注入 A：只把「写 .tmp 再 rename」换成「直接写目标文件」。
# 刻意**不碰** create_dir_all 与 .bak —— 那两件事各有自己的注入。
ANCHOR_TMP_RENAME = """    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, text).map_err(|e| format!("写入报表临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换报表文件失败: {e}"))"""

# 注入 B：删掉备份那一段。
ANCHOR_BAK = """    if path.exists() {
        let bak = PathBuf::from(format!("{}.bak", path.display()));
        std::fs::copy(path, &bak).map_err(|e| format!("备份原报表失败: {e}"))?;
    }"""

# 注入 C：把 list 的扩展名判据放宽成「文件名以 .json 结尾」。
ANCHOR_LIST_EXT = """        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }"""

# (说明, 锚点原文, 替换成, [门禁…])
# 门禁两种：("unit", 用例名) 跑 cargo test；("probe", None) 跑真机探针。
# 探针门禁要重新编译，所以它排在单测后面 —— 单测先红的话，探针那一轮就没必要等了。
CASES = [
    (
        "A 去原子性：写 .tmp + rename → 直接写目标文件",
        ANCHOR_TMP_RENAME,
        """    std::fs::write(path, text).map_err(|e| format!("写入报表文件失败: {e}"))""",
        [
            ("unit", "写入失败时目标文件仍是旧的完整内容"),
            ("probe", None),
        ],
    ),
    (
        "B 去备份：不再留 .bak",
        ANCHOR_BAK,
        "    // （注入：这里本来会拷贝一份 .bak）",
        [("unit", "覆盖时留下上一版备份")],
    ),
    (
        "C 放宽列表判据：extension == json → file_name **contains** .json",
        ANCHOR_LIST_EXT,
        """        let is_json = path
            .file_name()
            .and_then(|s| s.to_str())
            .map_or(false, |n| n.contains(".json"));
        if !is_json {
            continue;
        }""",
        [("unit", "备份与临时文件不进报表列表")],
    ),
]

PROBE = "scripts/verify-atomic-save.py"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build() -> bool:
    r = subprocess.run(
        ["cargo", "build", "--offline"],
        cwd=ROOT / "print-server", capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout[-1200:], r.stderr[-1200:])
    return r.returncode == 0


def run_test(name: str):
    """跑指定用例，返回 `(是否真的跑了, 是否通过)`。

    「真的跑了」必须单独判：**`cargo test <过滤名>` 在匹配不到任何用例时仍然返回 0**，
    于是把用例名打错会伪装成「通过」—— 基线看着绿、注入看着「没抓到」，两种都是假结论。
    """
    r = subprocess.run(
        [
            "cargo", "test",
            "--manifest-path", "print-server/Cargo.toml",
            "--bin", "print-server",
            "--", name,
        ],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = r.stdout + r.stderr
    ran = out.count("... ok") + out.count("... FAILED")
    return ran > 0, r.returncode == 0


def run_probe():
    """跑真机探针，返回 `(是否真的跑了, 是否通过)`。

    「真的跑了」的判据：探针必须明确表态（要么 ✓ 要么 ✗），
    而不是以「没验成」（退出码 2）收场 —— 那种情况它自己会说不算通过，
    这里也要照实报成「没验过」，别把它算进战果。
    """
    if not build():
        return False, False
    r = subprocess.run(
        ["python3", PROBE], cwd=ROOT, capture_output=True, text=True
    )
    out = r.stdout + r.stderr
    verdict = ("✓ 原子性成立" in out) or ("✗ **原子性不成立**" in out)
    return verdict, r.returncode == 0


def run_gate(kind: str, arg):
    if kind == "unit":
        return run_test(arg)
    if kind == "probe":
        return run_probe()
    raise AssertionError(f"未知门禁：{kind}")


def gate_label(kind: str, arg) -> str:
    return arg if kind == "unit" else f"真机探针 {PROBE}"


def main() -> int:
    print("先跑基线（未注入时所有门禁应当是绿的）…")
    baseline_gates = [(k, a) for *_, gates in CASES for k, a in gates]
    # 基线去重：探针只跑一次，别为每个用例各跑一遍
    seen = set()
    for kind, arg in baseline_gates:
        key = (kind, arg)
        if key in seen:
            continue
        seen.add(key)
        ran, passed = run_gate(kind, arg)
        if not ran:
            print(f"✗ **没验过**：{gate_label(kind, arg)} 没给出明确结论")
            print("  单测多半是用例名写错；探针多半是「没验成」（端口占用等）。")
            print("  先把这一条弄成明确结论，再谈注入。")
            return 1
        if not passed:
            print(f"✗ 基线就跑不过：{gate_label(kind, arg)}")
            print("  先把门禁修绿再来注入 —— 否则「变红」说明不了任何事。")
            return 1
    print("基线 ✓\n")

    missed = []
    for desc, old, new, gates in CASES:
        original = STORE.read_text(encoding="utf-8")
        before = sha(STORE)

        n = original.count(old)
        if n != 1:
            print(f"✗ 锚点匹配 {n} 处（要求恰好 1 处），**没验过**：{desc}")
            print("  多半是源码改了措辞。重新对准锚点，别跳过。")
            missed.append(desc)
            continue

        STORE.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            for kind, arg in gates:
                ran, passed = run_gate(kind, arg)
                label = gate_label(kind, arg)
                if not ran:
                    print(f"✗ **没验过**（{label}）：{desc}")
                    missed.append(desc)
                elif passed:
                    print(f"✗ **{label} 仍然是绿的**（这条注入没抓到）：{desc}")
                    missed.append(desc)
                else:
                    print(f"✓ 如期变红  {desc}")
                    print(f"    被抓者：{label}")
        finally:
            STORE.write_text(original, encoding="utf-8")
            build()  # 还原后立刻重编，别让下一个用例跑到注入过的二进制上

        # 还原必须逐字节一致 —— 否则注入脚本自己就成了污染源
        after = sha(STORE)
        if after != before:
            print(f"✗ 还原后文件变了！{STORE}（{before[:12]} → {after[:12]}）")
            return 2

    print()
    if missed:
        print(f"有 {len(missed)} 条没抓到，原子写有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    total = sum(len(g) for *_, g in CASES)
    print(f"全部 {total} 道门禁都被对应用例/探针抓到；store.rs 已逐字节还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
