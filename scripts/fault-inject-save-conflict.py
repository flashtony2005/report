#!/usr/bin/env python3
"""给「覆盖已有报表必须被服务端拦住」这道闸做故障注入。

## 为什么必须做

这道闸**平时不拦任何东西**（新建本来就该过），所以它的价值全在
「该拦的时候拦住了」。一组恒绿的用例和一组真有牙齿的用例，在「不拦」的时候
长得**一模一样** —— 必须把机制逐条拆坏，看门禁会不会红。

## 六条注入，每条拆**一个独立机制**

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| S1 | `save_new` 不查存在性（退化成 `save`） | 单测 `目标已存在时_save_new_拒绝且不碰文件` + 真机探针 |
| S2 | `save_new` 拿**未归一化**的 id 查存在性 | 单测 `save_new_判据与落盘同口径` |
| S3 | `forced()` 放宽成「带了 force 参数就算」 | 真机探针（`?force=0` / typo 会被当授权） |
| S4 | `Conflict` 也映射成 400 | 真机探针（状态码错了，UI 那个确认框永远弹不出来） |
| S5 | handler 永远走 `save`（等于没有闸） | 真机探针 |
| S6 | `save_new` 的 id 校验返回 `Conflict` | 真机探针（非法 id 报成 409，把人指向错误方向） |

## S2 是这里最值钱的一条

它证明的是一件**只有靠注入才看得见**的事：`" t8 "` 与 `"t8"` 是不是同一个目标。
`save` 会 trim，所以 `" t8 "` 落盘成 `t8.json`；如果 `save_new` 拿没 trim 的串
去查存在性，它会判定「不存在」→ 放行 → `save` 覆盖掉已有的 `t8.json`。
**不报错、不警告，安静地毁数据。** 这条注入把这个绕过复现出来，
看那条用例会不会红 —— 不红的话，那条用例就是摆设。

## S4 / S5 只有真机探针抓得到

`Conflict` → 400 这种错在**函数层完全看不出来**（`save_new` 老老实实返回了
`SaveError::Conflict`，单测全绿），错的只是 handler 把它翻译成哪个状态码。
UI 靠状态码分辨「弹错误」还是「弹覆盖确认框」—— 翻错了那个框**永远弹不出来**，
而用户只会看到「报表已存在」且无路可走。
所以这两条注入必须有真机门禁，单测代替不了。

## 已知边界（诚实标注，别当成验过了）

探针第 6 步还断言了「**先校验 id 再查存在性**」这个顺序。但下面这六条注入
**没有一条能让它红** —— 顺序反了的话，`bad/id` 走到 `save` 里照样会被校验拦成 400，
结果一样。也就是说那个顺序目前是**代码阅读得出的结论，不是被注入证明的**。
真要证明它，得让探针在报表目录**外面**造一个文件、再用带 `..` 的 id 去撞 ——
代价大、收益小（那个顺序的真实作用是「别拿未校验的 id 去拼路径」，
属于防御性写法）。写在这里是为了不让后来者以为它被验过了。

用法：python3 scripts/fault-inject-save-conflict.py
退出码：0 = 六条注入都被对应门禁抓到，且文件逐字节还原；1 = 有漏网。
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "print-server" / "src" / "report" / "store.rs"
MOD = ROOT / "print-server" / "src" / "report" / "mod.rs"

# ── store.rs 的锚点 ────────────────────────────────────────────────

# S1：把「已存在就拒」整段拿掉
ANCHOR_EXISTS_CHECK = """    if path_of(dir, &id).exists() {
        return Err(SaveError::Conflict(format!(
            "报表 {id} 已存在；覆盖会换掉原内容。确认要覆盖请带 ?force=1 重发。"
        )));
    }"""

# S2：查存在性时用**未归一化**的 id（`id` 是 trim 过的，`def.id` 不是）
ANCHOR_EXISTS_LINE = "    if path_of(dir, &id).exists() {"

# S6：id 校验返回 Conflict 而不是 Invalid
ANCHOR_INVALID = """    if !is_valid_id(&id) {
        return Err(SaveError::Invalid(format!(
            "报表 id 不合法（只允许字母数字、-、_，最长 80）: {id:?}"
        )));
    }
    if path_of(dir, &id).exists() {"""

# ── mod.rs 的锚点 ─────────────────────────────────────────────────

# S3：force 判据放宽成「带了就算」
ANCHOR_FORCED = """        matches!(
            self.force
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("1") | Some("true") | Some("yes")
        )"""

# S4：Conflict 也翻成 400
ANCHOR_CONFLICT_MAP = "        store::SaveError::Conflict(m) => (StatusCode::CONFLICT, m),"

# S5：handler 永远走 save
ANCHOR_HANDLER_PICK = """    let result = if q.forced() {
        store::save(&dir, def)
    } else {
        store::save_new(&dir, def)
    };"""

# (说明, 文件, 锚点原文, 替换成, [门禁…])
# 门禁两种：("unit", 用例名) 跑 cargo test；("probe", None) 跑真机探针。
# 探针那一道要重新编译，排在单测后面。
CASES = [
    (
        "S1 save_new 不查存在性（退化成直接覆盖）",
        STORE,
        ANCHOR_EXISTS_CHECK,
        "    // （注入：这里本来会拒绝覆盖已有报表）",
        [
            ("unit", "目标已存在时_save_new_拒绝且不碰文件"),
            ("probe", None),
        ],
    ),
    (
        "S2 查存在性时用未归一化的 id（trim 只做了一半）",
        STORE,
        ANCHOR_EXISTS_LINE,
        "    if path_of(dir, &def.id).exists() {",
        [("unit", "save_new_判据与落盘同口径")],
    ),
    (
        "S3 force 判据放宽成「带了参数就算」",
        MOD,
        ANCHOR_FORCED,
        "        self.force.is_some()",
        [("probe", None)],
    ),
    (
        "S4 Conflict 也映射成 400（状态码错了）",
        MOD,
        ANCHOR_CONFLICT_MAP,
        "        store::SaveError::Conflict(m) => (StatusCode::BAD_REQUEST, m),",
        [("probe", None)],
    ),
    (
        "S5 handler 永远走 save（等于没有这道闸）",
        MOD,
        ANCHOR_HANDLER_PICK,
        "    let _ = q.forced();\n    let result = store::save(&dir, def);",
        [("probe", None)],
    ),
    (
        "S6 id 校验返回 Conflict 而不是 Invalid",
        STORE,
        ANCHOR_INVALID,
        """    if !is_valid_id(&id) {
        return Err(SaveError::Conflict(format!(
            "报表 id 不合法（只允许字母数字、-、_，最长 80）: {id:?}"
        )));
    }
    if path_of(dir, &id).exists() {""",
        [("probe", None)],
    ),
]

PROBE = "scripts/verify-save-conflict.py"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build() -> bool:
    r = subprocess.run(
        ["cargo", "build", "--offline"],
        cwd=ROOT / "print-server", capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout[-1500:], r.stderr[-1500:])
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

    「真的跑了」的判据：探针必须明确表态。退出码 2 表示它自己说「没验成」
    （服务起不来 / 二进制不在），那种情况**不算抓到**，要照实报成「没验过」。
    """
    if not build():
        return False, False
    r = subprocess.run(["python3", PROBE], cwd=ROOT, capture_output=True, text=True)
    out = r.stdout + r.stderr
    verdict = "覆盖冲突契约成立" in out or "有" in out and "条不成立" in out
    if r.returncode == 2:
        print(out[-1500:])
        return False, False
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
    seen = set()
    for *_, gates in CASES:
        for kind, arg in gates:
            key = (kind, arg)
            if key in seen:
                continue
            seen.add(key)
            ran, passed = run_gate(kind, arg)
            if not ran:
                print(f"✗ **没验过**：{gate_label(kind, arg)} 没给出明确结论")
                print("  单测多半是用例名写错；探针多半是「没验成」（端口占用等）。")
                return 1
            if not passed:
                print(f"✗ 基线就跑不过：{gate_label(kind, arg)}")
                print("  先把门禁修绿再来注入 —— 否则「变红」说明不了任何事。")
                return 1
    print("基线 ✓\n")

    missed = []
    for desc, path, old, new, gates in CASES:
        original = path.read_text(encoding="utf-8")
        before = sha(path)

        n = original.count(old)
        if n != 1:
            print(f"✗ 锚点匹配 {n} 处（要求恰好 1 处），**没验过**：{desc}")
            print(f"  文件：{path.relative_to(ROOT)}")
            print("  多半是源码改了措辞。重新对准锚点，别跳过。")
            missed.append(desc)
            continue

        path.write_text(original.replace(old, new, 1), encoding="utf-8")
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
            path.write_text(original, encoding="utf-8")
            build()  # 还原后立刻重编，别让下一个用例跑到注入过的二进制上

        after = sha(path)
        if after != before:
            print(f"✗ 还原后文件变了！{path}（{before[:12]} → {after[:12]}）")
            return 2

    print()
    if missed:
        print(f"有 {len(missed)} 条没抓到，服务端那道闸有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    total = sum(len(g) for *_, g in CASES)
    print(f"全部 {total} 道门禁都被对应用例/探针抓到；store.rs / mod.rs 已逐字节还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
