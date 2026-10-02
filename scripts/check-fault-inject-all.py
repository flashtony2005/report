#!/usr/bin/env python3
"""给 `scripts/fault-inject-all.sh` **自己**做故障注入 —— 证明那几条承重断言真的会红。

## 为什么需要这一层（它防的是同一个病往上再爬一层）

`fault-inject-all.sh` 的全部作用是「**证明别的闸有牙齿**」。那么它自己呢？
它里面有几条断言是**承重**的：守卫失效时，它的输出会**从「有失败」变成「全绿」**
—— 那不是漏报，是**反向撒谎**。

本项目已经把「闸是绿的、但没有跑器」关了三次（openprint 引擎层、designer-react 的
32 个 spec、20 个 fault-inject 脚本）。这一层是第四次：**「跑器的守卫没人验」**。
所以本脚本逐条拆掉那些守卫，要求 `fault-inject-all.sh` **以特定方式变红**。

## 五条断言（A / B1 / B2 / C / D），各拆一次

| # | 断言 | 拆掉之后会怎样 | 期望 |
| --- | --- | --- | --- |
| A | **分类完整性守卫**：`fault-inject-*.py` 必须落在 CI_ABLE 或 EXCLUDED | 新脚本既不跑、也不报，`--list` 照样打印一份「看着挺全」的清单 | `--list` 必须 **rc=2** 且报「新增脚本没有分类」 |
| B | **退出码捕获**：`set -o pipefail` **与** `rc=${PIPESTATUS[0]}` | 少了它，`$?` 拿到 **tee** 的 0 ⇒ 脚本失败被读成**通过** | 正确时 rc=1；**两个一起拆**后 rc=0 ⇒ **证明这一对承重** |
| C | **前置条件缺失 → 「没跑成」(2)** | 缺 cargo 时报成「通过」或「失败」都是在误导 | 必须 **rc=2** 且报「PATH 里没有 cargo」 |
| D | **工作树守卫**：脚本跑完工作树变了就停 | 上一个脚本被中断、源码停在注入态，后面每个都会锚点失配 → 那些红**指向错的方向** | 必须 **rc=2** 且报「工作树在 … 跑完之后变了」 |

> ⚠️ **B 为什么是「一对」**：`fault-inject-all.sh` 顶部有 `set -o pipefail`，所以
> `$?` **并不**恒 0（管道会返回最右的非零码）。2026-10-02 实测：**只**把
> `rc=${PIPESTATUS[0]}` 换成 `rc=$?`，脚本**照样 rc=1** —— B2 不变绿。
> 必须**连 `pipefail` 一起拆**才退化成「失败读成通过」。结论：这两者是**冗余**的，
> 承重的是**这一对**，不是单独哪一行。（顺带更正了 `fault-inject-all.sh` 里
> 「`$?` 恒 0」那句注释 —— 它是错的。）

## 手法：**假脚本**，不碰任何产品代码

B / D 需要「一个会失败的注入脚本」和「一个不还原的注入脚本」。
本脚本临时造两个 **`fault-inject-zzz-*.py`**（内容就是 `sys.exit(1)` / 写一个临时文件），
跑完删掉。**一个字节的产品代码都不动**，所以比「就地改产品源码」干净得多。

⚠️ **顺序是有讲究的**：假脚本一旦落在 `scripts/` 里，就成了「未分类的新脚本」，
分类守卫会**先于一切**报红。所以
  · C 排在最前（此刻磁盘上没有任何假脚本）；
  · A 造出第一个假脚本（**故意不分类**）；
  · B 把它补进 CI_ABLE（否则守卫先红，B1/B2 都验不到退出码）；
  · D 再造第二个，并把**两个都**补进 CI_ABLE。
（第一版把造脚本放在最前面、几个用例共用，于是 B/C/D 全被守卫提前拦掉 ——
 「基线必须先绿」这条纪律当场把这个 bug 抓了出来。
 第二次真跑又抓到**本脚本自己的第二个 bug**：`with_entries` 把 CI_ABLE 的
 **最后一条**（`ai-dropped`）顶掉了 —— 于是 B/D 里 `ai-dropped` 变成「未分类」，
 分类守卫先红、rc=2 看着像「如期」。**必须 `LAST_ENTRY + ins`，不能只写 `ins`。**）

⚠️ 唯一被临时改的是 `fault-inject-all.sh` 自己（B 那条要注入 `rc=$?` **并**把
`set -uo pipefail` 改成 `set -u`）。改之前存哈希，`finally` 里逐字节还原，并**再核一次**哈希。

⚠️ A 那一条**必须用 `--list` 验**：`--list` 曾经排在分类校验**之前**，于是清单漂了
的时候它照样打印一份「看着挺全」的清单 —— 那正是本仓库最想消灭的
「看着像检查过了」。这里就把它钉死。

用法：python3 scripts/check-fault-inject-all.py
退出码：0 = 五条断言都如期变红（守卫有牙齿）；1 = 有守卫拆了也不红（那是摆设）；
        2 = **没跑成**（`fault-inject-all.sh` 正在跑，改它会自毁 —— 等它跑完）。
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "fault-inject-all.sh"
PROBE_FAIL = ROOT / "scripts" / "fault-inject-zzz-teeth-probe.py"
PROBE_DIRTY = ROOT / "scripts" / "fault-inject-zzz-dirty-probe.py"
DIRT = ROOT / "designer-react" / "src" / "__teeth_dirty__.tmp"

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 往 CI_ABLE 末尾插一条。锚点是它的收尾两行 —— 全文件唯一。
#
# ⚠️ **替换时必须把最后一条原样留下**（`LAST_ENTRY + ins`），否则 `ai-dropped`
# 会被顶掉、变成「未分类」，于是分类守卫在 B/D 里先红 —— 那些 rc=2 看着像「如期」，
# 其实指向的是错的方向。这个 bug 是 2026-10-02 本脚本**第一次真跑**时它自己抓出来的
# （第一版写成 `text.replace(ANCHOR_LIST_END, ins + ")")`，把 ai-dropped 吞了）。
LAST_ENTRY = '  "fault-inject-ai-dropped.py|designer+openprint"\n'
ANCHOR_LIST_END = LAST_ENTRY + ')'
# ⚠️ 锚点**只取代码部分**（不含行尾注释）：注释改过两次，锚点跟着漂过一次。
#    只匹配 `rc=${PIPESTATUS[0]}` 这段代码，注释怎么写都不影响。
ANCHOR_PIPESTATUS = "  rc=${PIPESTATUS[0]}"
ANCHOR_PIPEFAIL = "set -uo pipefail"

FAIL_PROBE_SRC = (
    "#!/usr/bin/env python3\n"
    '"""临时假注入脚本：恒定失败。由 check-fault-inject-all.py 生成，跑完即删。"""\n'
    "import sys\n"
    "print('（假脚本）模拟「有注入没被抓到」')\n"
    "sys.exit(1)\n"
)

DIRTY_PROBE_SRC = (
    "#!/usr/bin/env python3\n"
    '"""临时假注入脚本：留下脏文件、不还原。由 check-fault-inject-all.py 生成，跑完即删。"""\n'
    "from pathlib import Path\n"
    "print('（假脚本）模拟「脚本被中断、没还原干净」')\n"
    "Path(__file__).resolve().parent.parent.joinpath(\n"
    "    'designer-react/src/__teeth_dirty__.tmp').write_text('dirty\\n', encoding='utf-8')\n"
    "raise SystemExit(0)\n"
)


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_runner(args: list[str], env: dict | None = None) -> tuple[int, str]:
    full = dict(os.environ)
    if env:
        full.update(env)
    p = subprocess.run(
        ["bash", "scripts/fault-inject-all.sh", *args],
        cwd=ROOT, capture_output=True, text=True, env=full,
    )
    return p.returncode, ANSI.sub("", p.stdout + p.stderr)


def with_entries(text: str, entries: list[str]) -> str | None:
    """把若干条目插到 CI_ABLE 末尾（**保留**原有的最后一条）；锚点必须恰好匹配 1 处。"""
    if text.count(ANCHOR_LIST_END) != 1:
        return None
    ins = "".join(f'  "{e}"\n' for e in entries)
    return text.replace(ANCHOR_LIST_END, LAST_ENTRY + ins + ")")


def main() -> int:
    # ⚠️ 本脚本会**临时改写 `fault-inject-all.sh`**（B 那条要注入 `rc=$?`）。
    # 而 bash 是**按字节偏移增量读脚本**的：改一个正在跑的脚本，它会从旧偏移继续读
    # 新内容 → 报莫名其妙的 syntax error（`verify-ci-workflow.py` 顶部记着同款事故）。
    # 所以这里先确认**没有**别的实例在跑。CI 上两者是**串行的两步**，不会撞上；
    # 本机手动同时跑才会 —— 那就是这一条要挡的。
    # （放在最前：此刻本脚本还没派生任何子进程，pgrep 命中的一定是外来的。）
    try:
        probe = subprocess.run(["pgrep", "-f", "fault-inject-all.sh"],
                               capture_output=True, text=True)
    except FileNotFoundError:
        print("（没有 pgrep，跳过「另一个实例在跑吗」这条守卫。）")
    else:
        if probe.returncode == 0:
            print("✗ `fault-inject-all.sh` 已经在跑了（pid "
                  f"{probe.stdout.split()}）。")
            print("  本脚本会改写那个文件 —— 边跑边改会让它读到新旧拼接的内容，")
            print("  结论无效。等它跑完再来。")
            return 2

    original = RUNNER.read_text(encoding="utf-8")
    before_hash = sha(RUNNER)
    rows: list[tuple[str, str, str]] = []
    missed = 0

    def record(label: str, ok: bool, detail: str) -> None:
        nonlocal missed
        if not ok:
            missed += 1
        rows.append((label, "✅ 如期" if ok else "❌ 没红", detail))

    try:
        # ── C（排最前）：前置条件缺失 → 「没跑成」(2) ─────────────────────
        # 纯环境注入，**不造任何假脚本**（造了就轮到分类守卫先红了）。
        rc, out = run_runner(["--only", "table-pins"], env={"PATH": "/usr/bin:/bin"})
        record(
            "C 缺 cargo → 没跑成（rc=2，不是 0 也不是 1）",
            rc == 2 and "没有 cargo" in out,
            f"rc={rc}（期望 2），{'报了「PATH 里没有 cargo」' if '没有 cargo' in out else '**没报**'}",
        )
        if rc != 2:
            print(out[-800:])

        # ── A：分类完整性守卫（假脚本存在但故意不分类） ──────────────────
        PROBE_FAIL.write_text(FAIL_PROBE_SRC, encoding="utf-8")
        rc, out = run_runner(["--list"])
        record(
            "A 未分类的新脚本 → --list 必须 rc=2 并报「没有分类」",
            rc == 2 and "没有分类" in out,
            f"rc={rc}（期望 2），{'报了「没有分类」' if '没有分类' in out else '**没报**'}",
        )
        if rc != 2:
            print(out[-800:])

        # ── B：PIPESTATUS 承重 ──────────────────────────────────────────
        text = with_entries(original, ["fault-inject-zzz-teeth-probe.py|none"])
        if text is None:
            record("B PIPESTATUS 承重", False, "锚点失效（CI_ABLE 收尾行匹配不到 1 处）")
        else:
            RUNNER.write_text(text, encoding="utf-8")
            try:
                rc_ok, out_ok = run_runner(["--only", "zzz-teeth"])
                record(
                    "B1 注入失败 → 汇总 rc=1（正确实现）",
                    rc_ok == 1 and "失败" in out_ok,
                    f"rc={rc_ok}（期望 1）",
                )
                if rc_ok != 1:
                    print(out_ok[-800:])

                if text.count(ANCHOR_PIPESTATUS) != 1 or text.count(ANCHOR_PIPEFAIL) != 1:
                    record("B2 拆掉退出码捕获 → 失败被读成通过", False,
                           "锚点失效（PIPESTATUS / pipefail 匹配不到 1 处）")
                else:
                    broken = text.replace(ANCHOR_PIPESTATUS, "  rc=$?") \
                                 .replace(ANCHOR_PIPEFAIL, "set -u")
                    RUNNER.write_text(broken, encoding="utf-8")
                    rc_bug, out_bug = run_runner(["--only", "zzz-teeth"])
                    # 期望 **rc=0**（tee 的 0 被当成脚本退出码）—— 这才证明 B1 不是碰巧绿的。
                    # ⚠️ 只拆 PIPESTATUS 不够：顶部 `set -o pipefail` 会兜住（实测仍 rc=1），
                    #    必须**连 pipefail 一起拆**才退化成「失败读成通过」。
                    record(
                        "B2 拆掉「退出码捕获」这一对（PIPESTATUS + pipefail）→ 失败被读成通过",
                        rc_bug == 0,
                        f"rc={rc_bug}（期望 0 = 失败被吃掉），输出含「通过」={'通过' in out_bug}",
                    )
                    RUNNER.write_text(text, encoding="utf-8")
            finally:
                RUNNER.write_text(original, encoding="utf-8")

        # ── D：工作树守卫（两个假脚本都要分类，否则守卫先红） ─────────────
        PROBE_DIRTY.write_text(DIRTY_PROBE_SRC, encoding="utf-8")
        text = with_entries(original, [
            "fault-inject-zzz-teeth-probe.py|none",
            "fault-inject-zzz-dirty-probe.py|none",
        ])
        if text is None:
            record("D 工作树守卫", False, "锚点失效")
        else:
            RUNNER.write_text(text, encoding="utf-8")
            try:
                rc, out = run_runner(["--only", "zzz-dirty"])
                record(
                    "D 脚本跑完工作树变脏 → 停下并报没跑成（rc=2）",
                    rc == 2 and "工作树在" in out,
                    f"rc={rc}（期望 2），{'报了「工作树在…变了」' if '工作树在' in out else '**没报**'}",
                )
                if rc != 2:
                    print(out[-800:])
            finally:
                RUNNER.write_text(original, encoding="utf-8")
    finally:
        RUNNER.write_text(original, encoding="utf-8")
        for p in (PROBE_FAIL, PROBE_DIRTY, DIRT):
            p.unlink(missing_ok=True)

    restored = sha(RUNNER) == before_hash
    leftovers = [p.name for p in (PROBE_FAIL, PROBE_DIRTY, DIRT) if p.exists()]

    print("\n" + "=" * 72)
    for label, verdict, detail in rows:
        print(f"{verdict}  {label}\n        {detail}")
    print("=" * 72)
    print(f"{len(rows)} 条断言，如期变红 {len(rows) - missed} 条")
    print(f"fault-inject-all.sh 逐字节还原：{restored}")
    print(f"临时文件已清理：{'是' if not leftovers else f'否 —— 残留 {leftovers}'}")

    ok = missed == 0 and restored and not leftovers
    print("\n结果：" + ("守卫都有牙齿" if ok else "❌ 有守卫拆了也不红，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
