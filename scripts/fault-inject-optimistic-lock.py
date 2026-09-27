#!/usr/bin/env python3
"""给 `updatedAt` 乐观锁做故障注入。

分两批：
- **L1–L7**：时间戳这一层（`store.rs` 纯函数 / 落盘），门禁是单测；
- **L8–L13**：闸与 HTTP 翻译这一层，门禁是**真机探针** `verify-optimistic-lock.py`
  （状态码、响应体字段、零副作用这些只有真发请求才验得到）。

## 为什么必须做

这把锁平时**什么都不拦**：没人并发改的时候，带不带 `base` 都一样能存。
一组恒绿的用例和一组真有牙齿的用例，在「没撞车」的时候长得**一模一样**。
必须把机制逐条拆坏，看门禁会不会红。

## 时间戳层（L1–L7）

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| L1 | `next_updated_at` 不做单调修正（直接取 now） | `同一文件连续保存的时间戳严格递增` + `旧版秒级时间戳的文件升级后仍单调` |
| L2 | 修正时用 `old` 而不是 `old + 1`（不**严格**递增） | 同上两条 |
| L3 | 只认当前形状，不认旧版秒级形状 | `旧版秒级时间戳的文件升级后仍单调` + `时间戳解析只认两种定宽形状` |
| L4 | 去掉时间戳的范围检查（月份 13 / 小时 24 也认） | `时间戳解析只认两种定宽形状` |
| L5 | `now_millis` 退回秒级（`as_secs() * 1000`） | `时间戳是毫秒精度` |
| L6 | 格式化时丢掉毫秒（`{:03}` 拿掉） | `时间戳格式化与解析互为逆运算` |
| L7 | 解析时丢掉毫秒（`.mmm` 读成 000） | `时间戳格式化与解析互为逆运算` |

### L1 / L2 为什么必须是两条

`max(now, old + 1ms)` 里有两个独立的东西：**取 max**（不倒退）和 **+1**（严格）。
L1 只拆 max，L2 只拆 +1 —— 只留一条注入的话，另一半个机制就没人守。
特别是 **L2**：`max(now, old)` 看着很像对的（「不倒退就行了嘛」），
但它允许「同一个 token 出现两次」，锁照样静默失效。这条注入是它的反证。

### L5 为什么单列

`时间戳是毫秒精度` 这条用例的存在本身就来自一个反直觉的结论：
**光靠「单调递增」抓不住精度**。因为 `+1ms` 修正会让秒级时钟也给出严格递增的
token。所以精度必须单独一条钉子，也就必须单独一条注入来证明那条钉子在守东西。
拆掉 L5，其余六条注入里**没有一条**会红 —— 这正是它需要单列的理由。

### L6 / L7 是**一对**，别只留一条

格式化丢毫秒、解析丢毫秒，症状完全不同：格式化丢毫秒 → 输出少 3 个字符，形状当场
就不对；解析丢毫秒 → 输出形状完全正常，只是**两个真实不同的时刻被判成同一个版本**
（这正好是乐观锁最怕的那种错）。两条都注一遍才知道往返用例守的是哪半边。

## 闸与 HTTP 层（L8–L13）

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| L8 | handler 把 `Stale` 也映射成 409 | 真机探针（第 3 步；UI 会把它当「要不要覆盖」弹出去） |
| L9 | handler 不解析 `base`（只看 force） | 真机探针（第 2 步；带 base 也存不进去） |
| L10 | `expect()` 里让 `force` 压过 `base` | 真机探针（第 5 步）+ `保存前提_base_压过_force` |
| L11 | `Expect::Base` 分支根本不比对 | 真机探针（第 3 步）+ `版本不符时报过期_且一个字节都不碰` |
| L12 | `Expect::Base` 对**不存在**的文件放行 | 真机探针（第 8 步）+ `基准指向的文件不存在时报过期_而不是当成新建` |
| L13 | 闸「装晚了」：先写盘、最后才报 `Stale` | 真机探针（第 3 步的「逐字节不变」+「无 .bak」） |

### L13 是这一批里最值钱的一条

它拆的不是「判得对不对」，而是**「拒绝了之后有没有动过盘」**。
只断言状态码的话，「先覆盖了再返回 412」这种实现**完全能过** ——
那就成了**又毁数据又报错**，比不报错还坏。所以探针第 3 步除了状态码，
还必须断言「文件逐字节不变」和「没有新 `.bak`」—— L13 就是那两条的反证。

### L8 与 L11 的区别（别以为重复）

L11 拆的是**函数层**（`save` 有没有比对），L8 拆的是**翻译层**（比对出来的
`Stale` 被翻成哪个状态码）。`save` 老老实实返回 `Stale`、handler 翻成 409 时，
单测**全绿**，只有真机探针抓得到。这正是「声明与实现漂移」的典型形态。

## 已知边界（诚实标注，别当成验过了）

- **没有任何一条**能证明「`next_updated_at` 必须在 `write_atomic` 之前算」。
  顺序反了的话时间戳压根进不了文件，那是另一类错误（文件里没有 updatedAt），
  现有断言不覆盖。这个顺序目前是**读代码得出的结论**，不是被注入证明的。
- `format!` 多给一个参数是**编译错误**（不是警告），所以 L6 的锚点必须
  连 `millis` 那个实参一起拿掉 —— 否则注入会以「编译不过」的形式被报成「没验过」。
- 探针第 7 步（`?base=` 空值）与第 4 步（乱填的 base）**没有专门的注入**：
  它们的实现在 `expect()` 的同一个 `filter` 里，拆掉会让第 5 步一起红，
  分不出是哪一个机制坏了。也就是说这两步目前是**顺带覆盖**，不是被单独证明的。

用法：python3 scripts/fault-inject-optimistic-lock.py
退出码：0 = 十三条注入都被对应门禁抓到，且源码逐字节还原；1 = 有漏网。
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "print-server" / "src" / "report" / "store.rs"
MOD = ROOT / "print-server" / "src" / "report" / "mod.rs"
PROBE = "scripts/verify-optimistic-lock.py"

# ── store.rs：时间戳层 ────────────────────────────────────────────

# L1：去掉单调修正，直接取当前时刻
ANCHOR_BUMPED_USE = "    format_rfc3339_millis(bumped.map_or(now, |b| now.max(b)))"

# L2：修正时 +1 拿掉（`max(now, old)` 看着很像对的，但它允许 token 重复）
ANCHOR_PLUS_ONE = "        .map(|old| old + 1);"

# L3：不认旧版秒级形状（定宽 20）
ANCHOR_LEGACY_ARM = """        20 => {
            if b[19] != b'Z' {
                return None;
            }
            0
        }"""

# L4：范围检查
ANCHOR_RANGE = """    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }"""

# L5：精度退回秒
ANCHOR_MILLIS = "        .map(|d| d.as_millis() as i64)"

# L6：格式化丢掉毫秒。**必须连 `millis` 实参一起拿掉** ——
# `format!` 多给一个参数是编译错误，注入会以「编译不过」的形式被误报成「没验过」。
ANCHOR_FORMAT = """        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        millis"""

# L7：解析丢掉毫秒（`.mmm` 一律读成 000）。形状仍然正常，只是精度没了。
ANCHOR_PARSE_MILLIS = "            s.get(20..23)?.parse::<i64>().ok()?"

# ── store.rs：闸这一层 ────────────────────────────────────────────

# L11：`Expect::Base` 根本不比对（闸变成空操作）
ANCHOR_BASE_COMPARE = """            let actual = read_def(&path).ok().and_then(|d| d.updated_at);
            if actual.as_deref() != Some(base.as_str()) {
                return Err(SaveError::Stale {
                    expected: base.clone(),
                    actual,
                });
            }"""

# L12：`Expect::Base` 对**不存在**的文件放行（漏掉「基础已经没了」那一半）
ANCHOR_BASE_MISSING = """            let actual = read_def(&path).ok().and_then(|d| d.updated_at);
            if actual.as_deref() != Some(base.as_str()) {"""

# ── mod.rs：HTTP 翻译与查询串 ─────────────────────────────────────

# L8：`Stale` 也翻成 409（状态码错了）
ANCHOR_STALE_MAP = """        store::SaveError::Stale { expected, actual } => (
            StatusCode::PRECONDITION_FAILED,"""

# L9：handler 不解析 base（等于没有乐观锁）
ANCHOR_HANDLER_EXPECT = "    store::save(&dir, def, q.expect())"

# L10：force 压过 base
ANCHOR_EXPECT_PRIORITY = """        match self
            .base
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(b) => store::Expect::Base(b.to_string()),
            None if self.forced() => store::Expect::Anything,
            None => store::Expect::Absent,
        }"""

# ── 用例名 ────────────────────────────────────────────────────────

MONO = "同一文件连续保存的时间戳严格递增"
LEGACY = "旧版秒级时间戳的文件升级后仍单调"
PARSE = "时间戳解析只认两种定宽形状"
ROUNDTRIP = "时间戳格式化与解析互为逆运算"
PRECISION = "时间戳是毫秒精度"
PRIORITY = "保存前提_base_压过_force"
STALE_UNIT = "版本不符时报过期_且一个字节都不碰"
BASE_MISSING_UNIT = "基准指向的文件不存在时报过期_而不是当成新建"

# (说明, 文件, 锚点原文, 替换成, [门禁…])
# 门禁两种：("unit", 用例名) 跑 cargo test；("probe", None) 跑真机探针。
CASES = [
    (
        "L1 next_updated_at 不做单调修正（直接取 now）",
        STORE,
        ANCHOR_BUMPED_USE,
        "    let _ = bumped;\n    format_rfc3339_millis(now)",
        [("unit", MONO), ("unit", LEGACY)],
    ),
    (
        "L2 修正时用 old 而不是 old+1（不严格递增）",
        STORE,
        ANCHOR_PLUS_ONE,
        "        .map(|old| old);",
        [("unit", MONO), ("unit", LEGACY)],
    ),
    (
        "L3 不认旧版秒级时间戳（定宽 20）",
        STORE,
        ANCHOR_LEGACY_ARM,
        "        20 => return None,",
        [("unit", LEGACY), ("unit", PARSE)],
    ),
    (
        "L4 去掉时间戳范围检查（月份 13 / 小时 24 也认）",
        STORE,
        ANCHOR_RANGE,
        "    // （注入：范围检查没了）",
        [("unit", PARSE)],
    ),
    (
        "L5 now_millis 退回秒级",
        STORE,
        ANCHOR_MILLIS,
        "        .map(|d| (d.as_secs() * 1000) as i64)",
        [("unit", PRECISION)],
    ),
    (
        "L6 格式化丢掉毫秒",
        STORE,
        ANCHOR_FORMAT,
        """        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60""",
        [("unit", ROUNDTRIP)],
    ),
    (
        "L7 解析丢掉毫秒（.mmm 读成 000）",
        STORE,
        ANCHOR_PARSE_MILLIS,
        "            0",
        [("unit", ROUNDTRIP)],
    ),
    (
        "L8 handler 把 Stale 也映射成 409",
        MOD,
        ANCHOR_STALE_MAP,
        """        store::SaveError::Stale { expected, actual } => (
            StatusCode::CONFLICT,""",
        [("probe", None)],
    ),
    (
        "L9 handler 不解析 base（等于没有乐观锁）",
        MOD,
        ANCHOR_HANDLER_EXPECT,
        "    let _ = q.expect();\n"
        "    store::save(\n"
        "        &dir,\n"
        "        def,\n"
        "        if q.forced() { store::Expect::Anything } else { store::Expect::Absent },\n"
        "    )",
        [("probe", None)],
    ),
    (
        "L10 expect() 里让 force 压过 base",
        MOD,
        ANCHOR_EXPECT_PRIORITY,
        """        if self.forced() {
            return store::Expect::Anything;
        }
        match self
            .base
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(b) => store::Expect::Base(b.to_string()),
            None => store::Expect::Absent,
        }""",
        [("probe", None), ("unit", PRIORITY)],
    ),
    (
        "L11 Expect::Base 分支根本不比对",
        STORE,
        ANCHOR_BASE_COMPARE,
        "            let _ = base;",
        [("probe", None), ("unit", STALE_UNIT)],
    ),
    (
        "L12 Expect::Base 对不存在的文件放行",
        STORE,
        ANCHOR_BASE_MISSING,
        """            let actual = read_def(&path).ok().and_then(|d| d.updated_at);
            if actual.is_some() && actual.as_deref() != Some(base.as_str()) {""",
        [("probe", None), ("unit", BASE_MISSING_UNIT)],
    ),
    (
        "L13 闸装晚了：先写盘、最后才报 Stale",
        STORE,
        ANCHOR_BASE_COMPARE,
        """            let actual = read_def(&path).ok().and_then(|d| d.updated_at);
            if actual.as_deref() != Some(base.as_str()) {
                // （注入：先写盘，最后才报错）
                let stale = SaveError::Stale {
                    expected: base.clone(),
                    actual,
                };
                let text = serde_json::to_string_pretty(&def)
                    .map_err(|e| SaveError::Invalid(format!("序列化报表失败: {e}")))?;
                write_atomic(&path, &text).map_err(SaveError::Invalid)?;
                return Err(stale);
            }""",
        [("probe", None), ("unit", STALE_UNIT)],
    ),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build() -> bool:
    r = subprocess.run(
        ["cargo", "build", "--offline"],
        cwd=ROOT / "print-server", capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
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
    verdict = "乐观锁契约成立" in out or "条不成立" in out
    if r.returncode == 2:
        print(out[-2000:])
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
    print(f"基线 ✓（{len(seen)} 道门禁）\n")

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
            if not build():
                print(f"✗ 注入后编译不过，**没验过**：{desc}")
                missed.append(desc)
                continue
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
        print(f"有 {len(missed)} 条没抓到，乐观锁有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    total = sum(len(g) for *_, g in CASES)
    print(f"全部 {total} 道门禁都被对应用例/探针抓到；store.rs / mod.rs 已逐字节还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
