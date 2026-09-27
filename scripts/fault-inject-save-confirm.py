#!/usr/bin/env python3
"""给「保存」这条路上的两道确认 + 乐观锁接线做故障注入：逐条拆掉判据，确认对应用例会红。

## 为什么必须做

这两道闸**平时不拦任何东西**（正常保存本来就该直接过），所以它们的价值全在
「该拦的时候拦住了」。而一组恒绿的用例和一组真有牙齿的用例，
在「不拦」的时候长得**一模一样** —— 必须把判据拆坏，看用例会不会红。

## 第一组（注入 1–8）：覆盖确认（409）

判据是 `id !== lastSavedId && (!reportsListKnown || 列表里有这个 id)`，
三个子句各管一件事，所以要**分别**拆：

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| 1 整个确认 | 判据整段删掉，直接存 | 目标 id 已存在却发出请求 |
| 2 判据恒真 | 后半句改成恒真（**每次都弹**） | 对照组「id 不存在 → 不弹」 |
| 3 `reportsListKnown` | 只按列表判 | 「列表读不到 → 仍然弹」 |
| 4 `lastSavedId` | 去掉「是我在编辑的那份」那半 | 对照组「确认过一次 → 不再弹」 |
| 5 确认后不落盘 | `onOk` 里不调 `doSave` | 「点覆盖 → 带 force 重发」 |
| 6 取消当确定 | `onCancel` 改成和 `onOk` 一样 | 「点取消 → 请求为 0」 |
| 7 拆掉 409 分支 | `doSave` 里那段 `if (res.status === 409)` 删掉 | ★「客户端快照过期」 |
| 8 永远带 force | 落盘时恒 `force: true` | 对照组「新增不该带 force」 |

**注入 2 和 4 是这里的关键**：它们证明那三条**对照组**（必须**不**弹）不是摆设。
没有它们，「每次都弹框」和「只有覆盖才弹」在用例上分不开 ——
而「每次都弹」正是会让用户闭眼点确定、把这道闸作废的那种实现。

**注入 7 和 8 是服务端那道闸加进来之后补的**（`Expect::Absent` + `?force=1`）：

- 7 拆掉的是「服务端 409 → 弹确认框」这条翻译。没有它，客户端快照过期时
  409 会落进通用错误分支，用户看到「报表已存在」却**没有任何办法继续保存**。
  那条用例（★ 客户端快照过期）是**唯一**能抓到这个的 —— 其它七条都抓不到。
- 8 拆掉的是「只在有授权时才带 force」。要是无脑永远带 `force=1`，
  服务端那道闸就形同虚设（任何调用方都能覆盖任何报表），
  而「永远带 force」**同样能让注入 1~7 全过** —— 只有那条反向对照能抓到它。

注入 5、6 拆的是**按钮接线**而不是判据：判据对了、按钮没接上也照样是 bug。

## 第二组（注入 9–14）：乐观锁（412）

这一组拆的是**装填 → 携带 → 回填 → 出路**这条链上的每一环，
它们分别坏掉时的症状**完全不同**，所以一条都不能省：

| 注入 | 拆掉什么 | 期望变红 |
| --- | --- | --- |
| 9 拆掉 412 分支 | `if (res.status === 412)` 那段删掉 | ★「服务端 412 → 弹被改过了框」 |
| 10 不回填 base | 保存成功后不 `setBaseUpdatedAt` | ★「回填新版本 → 第二次 base 不同」 |
| 11 打开时不装填 | `openReport` 里不 `setBaseUpdatedAt` | ★「打开一份报表再保存 → 带版本」 |
| 12 硬覆盖时带上 base | 「用我的版本覆盖」传 `base` 而不是 null | ★「点用我的版本覆盖」 |
| 13 拆掉「重新打开」 | 那个按钮不调 `openReport` | ★「点放弃我的改动，重新打开」 |
| 14 永远不带 base | 落盘时恒 `base: null` | ★「对照组：不该发一个不带 base 的保存」 |

**注入 10 和 14 是一对，症状看着像「功能没了」，其实是两件不同的事：**

- 14 是**从来没带上过** base → 这把锁一次都没生效过，而屏幕上一切正常
  （这正是最坏的那种：声明了有保护、实际没有）。
- 10 是**第一次带对了、第二次带的是旧值** → 用户连存两次，第二次弹
  「这份报表在别处被改过了」—— 而那个「别人」就是他自己。
  这种「功能看起来是好的、只是偶尔诈尸」最难查，所以必须有独立一条钉子。

**注入 9 与 7 是同一种错的两半**：7 拆的是 409 那条翻译，9 拆的是 412 那条。
两条路都会落进 `!res.ok → setError`，症状都是「用户被告知出事了，却没有出路」。

## 关于「编译失败不算抓住」

这里跑的是 vitest，它用 esbuild **只剥类型、不做类型检查**，
所以拆完 `lastSavedId` 变成未使用变量也照样跑得起来 ——
注入只需要**语法**合法。真要类型检查会红，那是 `ts-project-check.sh` 的事，
不是这一轮的判据（别把它算进战果）。

## 一个副作用：**用例改名会让「抓到」变成「没抓到」**

每条注入都写死了「应当红在哪条用例上」（按标题子串匹配）。所以**改了用例标题**
就会让这条注入报「红了，但不是期望的那条」—— 明明抓到了，却报成漏网。

这不是 bug，是刻意的：它宁可**多报一次**，也不肯用「反正红了就算抓到」的松判据
（那样一条无关的用例红也能冒充战果）。但代价是**改标题时要顺手同步这里的字符串**。

（本轮就踩了两次：先是 `点「覆盖」→ 请求真的发出去` 改成 `点「覆盖」→ 带 force=1 重发`
之后忘了改这里；这次是 `doSave(def, id, force)` 改成 `doSave(def, id, {force, base})`
之后，注入 1~6、8 的锚点与用例名全都要重对。看到「红了但不是期望的那条」时，
先看一眼是不是标题漂了，别急着怀疑判据。）

用法：python3 scripts/fault-inject-save-confirm.py
退出码：0 = 十四条注入都被对应用例抓到，且文件逐字节还原；1 = 有漏网。
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODAL = ROOT / "designer-react" / "src" / "modals" / "GridReportModal.tsx"
SPEC = "src/modals/grid-report-save-confirm.spec.tsx"

# 判据 + 落盘那一句。`mine` / `base` 两个实参就是乐观锁的携带方式。
COND = """    if (id !== lastSavedId && (!reportsListKnown || savedReports.some((r) => r.id === id))) {
      setPendingOverwrite({ def, id })
      return
    }
    const mine = id === lastSavedId
    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })"""

# 判据整段删掉之后还得真的发一个请求出去，否则注入 1 变成「什么都不做」
DIRECT_SAVE = """    await doSave(def, id, {
      force: id === lastSavedId,
      base: id === lastSavedId ? baseUpdatedAt || null : null,
    })"""

# `onOk` 里真正落盘的那一段。
#
# ⚠️ 两个坑都在这里踩过，别简化：
#
# 1. **纯子串匹配不认行首**。只锚 `          if (p) void doSave(...)` 那一行的话，
#    它会在「用我的版本覆盖」那个 14 空格缩进的同内容行的**第 4 个字符**处命中，
#    `count()` 得到 2 → 脚本报「锚点匹配 2 处，没验过」。
# 2. **中间还夹着三行注释**。所以「上一行 + 这一行」的拼法也不成立
#    （会得到 0 处，同样报没验过）。
#
# 结论：锚点必须**整段照抄**，从 `title=` 起把中间所有行（含注释）都包进来。
# 这段以 `title="覆盖已有报表？"` 开头，全局唯一。
ON_OK_SAVE = """        title="覆盖已有报表？"
        open={pendingOverwrite !== null}
        onOk={() => {
          const p = pendingOverwrite
          setPendingOverwrite(null)
          // `force = true`：用户明确点了「覆盖」→ 这正是服务端要的那句授权。
          // ⚠️ `base` 必须是 **null**：服务端那边 `base` 压过 `force`，
          //    两个都带的话 base 赢、再 412 一次 —— 用户点了「覆盖」却还是存不进去。
          //    这一条是「用户已经在框里表过态」的那条路，所以刻意放弃版本比对。
          if (p) void doSave(p.def, p.id, { force: true, base: null })
        }}"""

# 注入 5 的替换：按钮还在、框还会关，就是**不落盘**
ON_OK_NO_SAVE = """        title="覆盖已有报表？"
        open={pendingOverwrite !== null}
        onOk={() => {
          const p = pendingOverwrite
          setPendingOverwrite(null)
          void p
        }}"""

ON_CANCEL = "        onCancel={() => setPendingOverwrite(null)}"

# `doSave` 里那段 409 分支。**它是「服务端说有冲突」转成「弹确认框」的唯一入口**，
# 拆掉它 409 就会落进下面的 `!res.ok → setError`，用户看到「已存在」却无路可走。
ON_409 = """        if (res.status === 409) {
          setError('')
          setPendingOverwrite({ def, id })
          return
        }"""

# 412 分支 —— 与 409 那条是**两半**：这条转的是「你手上过期了」。
# 拆掉它，用户会看到一句「被改过了」然后没有任何出路（连「重新打开」都点不到）。
ON_412 = """        if (res.status === 412) {
          setError('')
          setPendingStale({ def, id, actual: staleActualOf(text) })
          return
        }"""

# 回填：把服务端刚给出的版本变成我手上这份的新 base
BACKFILL = """          setBaseUpdatedAt(stamp)
          // 存成功之后，这个 id 就是「我正在编辑的那一份」了
          setLastSavedId(id)"""

# 装填：打开报表时记下「我基于哪一版」
SEED = "      setBaseUpdatedAt(def.updatedAt ?? '')"

# 「重新打开」那条出路（14 空格缩进）
STALE_RELOAD = "              if (p) void openReport(p.id)"

# 「用我的版本覆盖」：只带 force、不带 base
STALE_FORCE = (
    "              if (p) void doSave(p.def, p.id, { force: true, base: null })"
)

# (说明, 锚点原文, 替换成, 期望变红的用例名)
CASES = [
    (
        "1 整个确认拆掉：判据整段删掉，直接落盘",
        COND,
        DIRECT_SAVE,
        "目标 id 已存在且不是我在编辑的那份",
    ),
    (
        "2 判据恒真：改成「每次都弹」（后半句永真）",
        COND,
        """    if (id !== lastSavedId && (savedReports.length >= 0 || savedReports.some((r) => r.id === id))) {
      setPendingOverwrite({ def, id })
      return
    }
    const mine = id === lastSavedId
    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })""",
        "对照组：列表里**没有**这个 id",
    ),
    (
        "3 去掉 reportsListKnown：只按列表判（列表读不到 = 空列表 = 放行）",
        COND,
        """    if (id !== lastSavedId && savedReports.some((r) => r.id === id)) {
      setPendingOverwrite({ def, id })
      return
    }
    const mine = id === lastSavedId
    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })""",
        "列表**读不到**时不算「没有同名」",
    ),
    (
        "4 去掉 lastSavedId：只看列表里有没有（于是存自己那份也会弹）",
        COND,
        """    if (!reportsListKnown || savedReports.some((r) => r.id === id)) {
      setPendingOverwrite({ def, id })
      return
    }
    const mine = id === lastSavedId
    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })""",
        "对照组：确认过一次之后再存同一个 id",
    ),
    (
        "5 onOk 里不落盘：判据对了，但「覆盖」按钮没接上",
        ON_OK_SAVE,
        ON_OK_NO_SAVE,
        "点「覆盖」→ 带 force=1 重发",
    ),
    (
        "6 取消当确定：onCancel 干起了 onOk 的活",
        ON_CANCEL,
        """        onCancel={() => {
          const p = pendingOverwrite
          setPendingOverwrite(null)
          if (p) void doSave(p.def, p.id, { force: true, base: null })
        }}""",
        "点「取消」→ 什么都不做",
    ),
    (
        "7 拆掉 409 分支：服务端说有冲突，前端却当成普通错误",
        ON_409,
        "        // （注入：这里本来会把 409 转成确认框）",
        "客户端快照过期",
    ),
    (
        "8 永远带 force：等于把服务端那道闸作废",
        "    const mine = id === lastSavedId\n"
        "    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })",
        "    await doSave(def, id, { force: true, base: null })",
        "对照组：列表里**没有**这个 id",
    ),
    # ── 乐观锁（412）那一组 ──────────────────────────────────────
    (
        "9 拆掉 412 分支：版本冲突被当成普通错误",
        ON_412,
        "        // （注入：这里本来会把 412 转成冲突框）",
        "★ 服务端 412（别处改过）",
    ),
    (
        "10 不回填 base：第二次保存拿旧版本去比 → 412 自己",
        BACKFILL,
        "          void stamp\n          setLastSavedId(id)",
        "★ 保存成功后必须**回填新版本**",
    ),
    (
        "11 打开报表时不装填 base：请求里根本没有版本可带",
        SEED,
        "      void def.updatedAt",
        "★ 打开一份报表再保存",
    ),
    (
        "12 硬覆盖时带上 base：base 压过 force → 框会反复弹回来",
        STALE_FORCE,
        "              if (p) void doSave(p.def, p.id, { force: true, base: baseUpdatedAt || null })",
        "★ 点「用我的版本覆盖」",
    ),
    (
        "13 拆掉「重新打开」：412 那个框只剩「覆盖」一条路",
        STALE_RELOAD,
        "              void p",
        "★ 点「放弃我的改动，重新打开」",
    ),
    (
        "14 永远不带 base：这把锁一次都没生效过，而屏幕上一切正常",
        "    const mine = id === lastSavedId\n"
        "    await doSave(def, id, { force: mine, base: mine ? baseUpdatedAt || null : null })",
        "    await doSave(def, id, { force: mine, base: null })",
        "★ 对照组：版本冲突时**不该**发一个「不带 base」的保存",
    ),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_spec(name_filter: str):
    """跑这个 spec 文件，返回 `(是否真的跑了, 是否通过, 失败用例名列表, 原始输出)`。

    「真的跑了」必须单独判：spec 里 `import` 阶段炸掉时 vitest 会报
    `Test Files 1 failed` 而**根本不打印 `Tests` 行** ——
    那时退出码非 0、看着像「注入被抓到」，其实一条用例都没执行。
    """
    r = subprocess.run(
        ["bash", "scripts/ts-test-designer.sh", name_filter],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = r.stdout + r.stderr
    ran = ("Test Files" in out) and ("Tests " in out)
    failed: list[str] = []
    for ln in out.splitlines():
        s = ln.strip()
        # vitest 的失败行：`FAIL  src/x.spec.tsx > describe > 用例名`
        if s.startswith("FAIL "):
            failed.append(s.split(">")[-1].strip())
        # 汇总区里的：`× 用例名`
        elif s.startswith("×"):
            failed.append(s.lstrip("× ").strip())
    return ran, r.returncode == 0, failed, out


def main() -> int:
    print("先跑基线（未注入时 15 条用例应当全绿）…")
    ran, passed, failed, out = run_spec(SPEC)
    if not ran:
        print("✗ **没验过**：这个 spec 没跑起来")
        print(out[-1500:])
        return 1
    if not passed:
        print("✗ 基线就跑不过，先把用例修绿再来注入：")
        for f in failed[:5]:
            print("   ", f)
        return 1
    print("基线 ✓\n")

    missed = []
    for desc, old, new, test_name in CASES:
        original = MODAL.read_text(encoding="utf-8")
        before = sha(MODAL)

        n = original.count(old)
        if n != 1:
            print(f"✗ 锚点匹配 {n} 处（要求恰好 1 处），**没验过**：{desc}")
            print("  多半是源码改了措辞。重新对准锚点，别跳过。")
            missed.append(desc)
            continue

        MODAL.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            ran, passed, failed, out = run_spec(SPEC)
        finally:
            MODAL.write_text(original, encoding="utf-8")

        # 还原必须逐字节一致 —— 否则注入脚本自己就成了污染源
        after = sha(MODAL)
        if after != before:
            print(f"✗ 还原后文件变了！{MODAL}（{before[:12]} → {after[:12]}）")
            return 2

        if not ran:
            print(f"✗ **没验过**（spec 没跑起来）：{desc}")
            print(out[-1200:])
            missed.append(desc)
        elif passed:
            print(f"✗ **用例仍然是绿的**（这条注入没抓到）：{desc}")
            print(f"    应当红在「{test_name}」上。")
            missed.append(desc)
        else:
            hit = [f for f in failed if test_name in f]
            if hit:
                print(f"✓ 如期变红  {desc}")
                print(f"    被抓者：{hit[0][:80]}")
            else:
                # ⚠️ 红了，但**不是**期望的那条 —— 这正是「判据要细到哪一条用例」那条纪律。
                # 不区分的话，一条无关的用例红也能冒充「注入被抓到」。
                print(f"✗ 红了，但**不是期望的那条用例**：{desc}")
                print(f"    期望含「{test_name}」，实际红的是：")
                for f in failed[:5]:
                    print("     ", f[:90])
                missed.append(desc)

    print()
    if missed:
        print(f"有 {len(missed)} 条没抓到，保存这条路有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    print(f"全部 {len(CASES)} 条注入都被对应用例抓到；GridReportModal.tsx 已逐字节还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
