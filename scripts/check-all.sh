#!/usr/bin/env bash
#
# 一把跑完本仓库所有「不需要起服务」的闸。
#
# ## 为什么要有这个脚本
#
# 这些闸早就造好了，但此前**没有任何入口会把它们串起来**：没有 CI，没有聚合脚本，
# 写这个脚本时，27 个 `.py`（13 故障注入 + 13 探针 + mirror-check）**没有任何 shell 脚本调用过**。
# 于是「闸是绿的」只意味着「上次有人手动跑过」，不意味着「现在没问题」。
#
# **一个没人跑的绿闸比一个红闸更坏** —— 红闸至少会喊；没人跑的绿闸会主动产出
# 「契约一致」的信心，而那份信心是空头的。本脚本就是为了消掉这一条。
#
# ## 三种结果，**故意不合并成两种**
#
#   0  通过      —— 真的检查过了，没问题
#   1  失败      —— 检查过了，有问题
#   2  没跑成    —— 环境缺东西（借不到 tsc / vitest / node / cargo），**根本没检查**
#
# 「没跑成」算成「通过」就是假绿（最坏）；算成「失败」就是假红（会让人去改本来没错的
# 代码 —— 本项目为此专门在 node-bin.sh 里写过一段注释）。所以这里分开报，
# 整体退出码取最坏的那一种。
#
# ## 用法
#
#   scripts/check-all.sh           # 全部：含两个慢的项目级类型检查 + cargo test
#   scripts/check-all.sh --fast    # 只跑秒级的（mirror-check + ts-check），日常改动用
#   scripts/check-all.sh --list    # 只列出会跑哪几道闸
#
# ## 顺序：**便宜的排前面**
#
# 不是为了快，是为了「出错时先在几十秒内看到」。mirror-check 是纯 Python 解析、
# 零依赖、亚秒级，而且它是**唯一**能发现 Rust↔TS 漂移的闸 —— 所以排第一。
#
# ## 不含什么
#
# 18 个 `fault-inject-*.py` 与 14 个 `verify-*.py` **不在这里**：前者要改源码、
# 后者要起真服务（127.0.0.1:18888）。它们按需单独跑，改哪个特性跑哪一个。
#   ls scripts/fault-inject-*.py   # 注入：证明某条闸真的有牙齿
#   ls scripts/verify-*.py         # 探针：对活服务做端到端验证
#
# （这两个数字漂过三次：初版写的 13 / 13 —— `verify` 当时确实是 13，`fault-inject`
#  **早就已经是 14**，加了新脚本没同步注释。2026-09-26 加 `fault-inject-issues-ui.py`
#  核成 15；2026-09-27 加 `fault-inject-mirror-semantics.py` 核成 16，同日加
#  `fault-inject-atomic-save.py` / `fault-inject-save-confirm.py` + `verify-atomic-save.py`
#  核成 18 / 14。
#  **注释里的数字是最容易漂的东西 —— 改完记得 `ls scripts/*.py | wc -l` 核一遍。**）
#
# 退出码：0 / 1 / 2，语义见上。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

FAST=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;
    --list)
      cat <<'EOT'
会跑的闸（按执行顺序）：
  1. python3 scripts/mirror-check.py           Rust↔TS 契约对账（形状 24 组 + 语义 8 条，亚秒级）
  2. bash    scripts/ts-check.sh               逐文件类型检查（--noResolve，快）
  3. bash    scripts/ts-test.sh                前端纯函数单测（借外部 vitest，node 环境）
  4. bash    scripts/ts-project-check.sh               整项目类型检查 · designer-react
  5. bash    scripts/ts-project-check.sh openprint     整项目类型检查 · openprint（vue-tsc --build）
  6. cargo   test --bin print-server           Rust 单测
  7. bash    scripts/ts-test-designer.sh grid-report-  设计器 UI 单测（jsdom，串行，12 文件 / 142 用例，~145s）
--fast 只跑 1、2。

第 7 道**带过滤参数**（`grid-report-`，12 文件 / 142 用例），不是整套 designer-react：
整套要 **~346s**（且必须 `--no-file-parallelism`，见 ts-test-designer.sh 顶部）。
日常改的报表弹窗全在 `grid-report-*` 里，先用这个把「改了弹窗没人管」堵上；
要全量就自己跑 `bash scripts/ts-test-designer.sh`（无参数 = 全部）。
⚠️ 这是**已知的覆盖缺口**：`designer-react` 另外那 32 个 spec 文件（canvas / panels /
toolbar / stores…）仍然不在本脚本里 —— 不是「没必要」，是那 346s 太贵。
EOT
      exit 0
      ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    # ⚠️ `${a}（` 的花括号不能省 —— `$VAR` 紧跟非 ASCII 字符会被本机 bash 3.2
    # 静默吃掉（详见 ts-check.sh 里的说明）。
    *) echo "未知参数：${a}（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ 跑器

passed=0; failed=0; skipped=0; worst=0
declare -a FAILED_NAMES=() SKIPPED_NAMES=()

run() {
  local name="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  local t0=$SECONDS rc=0
  "$@" || rc=$?
  local dt=$((SECONDS - t0))
  case $rc in
    0) printf '   \033[32m✓ 通过\033[0m（%ss）\n' "$dt"; passed=$((passed + 1)) ;;
    2) printf '   \033[33m⚠ 没跑成\033[0m（%ss，退出码 2 = 环境缺东西，**不等于通过**）\n' "$dt"
       skipped=$((skipped + 1)); SKIPPED_NAMES+=("$name")
       if [ "$worst" -lt 2 ]; then worst=2; fi ;;
    *) printf '   \033[31m✗ 失败\033[0m（%ss，退出码 %s）\n' "$dt" "$rc"
       failed=$((failed + 1)); FAILED_NAMES+=("$name")
       if [ "$worst" -lt 1 ]; then worst=1; fi ;;
  esac
}

# 命令存在性：缺了就是「没跑成」（2），不是「失败」（1）。
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '   \033[33m⚠ 没跑成\033[0m：找不到 `%s`\n' "$1"
    skipped=$((skipped + 1)); SKIPPED_NAMES+=("$2")
    if [ "$worst" -lt 2 ]; then worst=2; fi
    return 1
  fi
  return 0
}

printf '\033[1mcheck-all\033[0m（%s）\n' "$ROOT"
[ "$FAST" = 1 ] && printf '模式：--fast（只跑秒级的，慢闸跳过）\n'

# ---------------------------------------------------- 1. 跨语言契约（最便宜、最独特）

# 唯一能发现 Rust↔TS 字段/清单漂移的闸。排第一是因为它亚秒级且零依赖 ——
# 它红了多半意味着后面几个小时的检查都白跑。
if need python3 "mirror-check.py"; then
  run "1/7 mirror-check（Rust↔TS 契约：形状 + 语义）" python3 scripts/mirror-check.py
fi

# ---------------------------------------------------- 2. 逐文件类型检查（快）

run "2/7 ts-check（逐文件类型）" bash scripts/ts-check.sh

if [ "$FAST" = 1 ]; then
  printf '\n（--fast：跳过 3~7）\n'
else

# ---------------------------------------------------- 3. 前端纯函数单测

run "3/7 ts-test（前端纯函数单测）" bash scripts/ts-test.sh

# ---------------------------------------------------- 4/5. 整项目类型检查（慢）

run "4/7 ts-project-check（designer-react）" bash scripts/ts-project-check.sh
run "5/7 ts-project-check（openprint）"      bash scripts/ts-project-check.sh openprint

# ---------------------------------------------------- 6. Rust 单测

if need cargo "cargo test"; then
  run "6/7 cargo test（print-server）" \
    cargo test --manifest-path print-server/Cargo.toml --bin print-server
fi

# ---------------------------------------------------- 7. 设计器 UI 单测（最贵，排在最后）

# 排在最后是因为它 **~160s**，比前面几道加起来还贵（「便宜的排前面」那条规则的直接后果）。
# 只跑 `grid-report-`：整套 designer-react 要 ~346s，见 ts-test-designer.sh 顶部。
run "7/7 ts-test-designer（报表弹窗 spec）" \
  bash scripts/ts-test-designer.sh grid-report-

fi

# ------------------------------------------------------------------ 汇总

printf '\n\033[1m══ 汇总 ══\033[0m\n'
printf '通过 %d · 失败 %d · 没跑成 %d\n' "$passed" "$failed" "$skipped"
[ "${#FAILED_NAMES[@]}"  -gt 0 ] && printf '失败：%s\n'   "${FAILED_NAMES[*]}"
[ "${#SKIPPED_NAMES[@]}" -gt 0 ] && printf '没跑成：%s\n' "${SKIPPED_NAMES[*]}"

printf '\n（不含 18 个 fault-inject / 14 个 verify —— 要改源码 / 起服务，按需单独跑：`ls scripts/fault-inject-*.py`）\n'

case $worst in
  0) printf '\033[32m全绿\033[0m\n' ;;
  1) printf '\033[31m有失败项\033[0m\n' ;;
  2) printf '\033[33m有闸没跑成 —— **不等于通过**，先把环境补齐再下结论\033[0m\n' ;;
esac
exit $worst
