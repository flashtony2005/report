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
# ## 谁在跑它
#
# **CI**：`.github/workflows/ci.yml` 在 push 到 main / 开 PR / 手动触发时跑的就是
# 本脚本（`bash scripts/check-all.sh`，与本地逐字相同）。
# 「闸是绿的、但没人跑」比「红的闸」更坏（绿的会主动产出空头的信心）——
# 挂上 CI 就是为了消掉那一态。
# CI 的覆盖**不多不少**就是本脚本的覆盖：下面那两个目录仍不在里面。
#
# ## 不含什么
#
# 20 个 `fault-inject-*.py` 与 17 个 `verify-*.py` **不在这里**：前者要改源码、
# 后者**多数**要起真服务（127.0.0.1:18888）。它们按需单独跑，改哪个特性跑哪一个。
#   ls scripts/fault-inject-*.py   # 注入：证明某条闸真的有牙齿
#   ls scripts/verify-*.py         # 探针：对活服务做端到端验证
#
# ⚠️ 有一个例外，**刻意不放进来**：`verify-ci-workflow.py` 不需要服务，
# 但它会**反过来执行 `check-all.sh`**（证明 CI 要跑的命令真的跑得通）——
# 放进来就是无限递归。想校验 CI 就单独跑 `python3 scripts/verify-ci-workflow.py`。
#
# （这两个数字漂过五次：初版写的 13 / 13 —— `verify` 当时确实是 13，`fault-inject`
#  **早就已经是 14**，加了新脚本没同步注释。2026-09-26 加 `fault-inject-issues-ui.py`
#  核成 15；2026-09-27 加 `fault-inject-mirror-semantics.py` 核成 16，同日加
#  `fault-inject-atomic-save.py` / `fault-inject-save-confirm.py` + `verify-atomic-save.py`
#  核成 18 / 14；同日再给「覆盖冲突」加 `fault-inject-save-conflict.py` +
#  `verify-save-conflict.py` 核成 19 / 15；同日再给「updatedAt 乐观锁」加
#  `fault-inject-optimistic-lock.py` + `verify-optimistic-lock.py` 核成 20 / 16；
#  同日挂 CI 时加 `verify-ci-workflow.py` 核成 **20 / 17**。
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
  7. bash    scripts/ts-test-designer.sh grid-report-  设计器 UI 单测（jsdom，串行，12 文件 / 151 用例，~160s）
--fast 只跑 1、2。

第 7 道**带过滤参数**（`grid-report-`，12 文件 / 151 用例），不是整套 designer-react：
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

# ------------------------------------------------------------------ 诊断通道
#
# ⚠️ 在 GitHub Actions 上，**check-run 的 annotation 是唯一不需要 admin 权限就能读的输出**。
#    2026-09-27 实测：job log 走 API 要 admin（403「Must have admin rights to Repository.」），
#    而同一个 check-run 的 annotations 用裸 curl 就拿到了。
#    ⇒ 红的时候必须把**原因**写进 annotation。否则一条红 CI 只能告诉你
#      「有东西失败了」—— 读不到是哪个闸、为什么。那正是本项目最讨厌的那种
#      「闸在跑、但结论不可用」。
#
# 只在 Actions 上启用：本地保持**实时流式**输出（缓冲会让 160s 的 UI 闸全程无输出）。
GH_ANNOTATE=0
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then GH_ANNOTATE=1; fi

# 失败/没跑成的闸的明细：`名字|退出码|日志文件`（日志文件仅 Actions 上存在）
declare -a FAIL_DETAIL=()
# annotation 正文里的 `%` 和 `\r` 必须转义，否则 GitHub 解析不出来（换行另走「一行一条」）
# ⚠️ 这两个都是**读 stdin 的过滤器**，不是 `f "$x"` ——
#    第一版把 gh_escape 写成 `printf '%s' "$1"` 却拿它当管道过滤器用，
#    在 `set -u` 下直接 `$1: unbound variable`，annotation 变成空行（实测踩过）。
gh_escape() { sed -e 's/%/%25/g' -e 's/\r//g'; }
# 闸的输出带 ANSI 颜色码，直接塞进 annotation 会显示成乱码
gh_strip_ansi() { sed $'s/\033\\[[0-9;]*[A-Za-z]//g'; }

run() {
  local name="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  local t0=$SECONDS rc=0 out=""
  if [ "$GH_ANNOTATE" = 1 ]; then
    # 只在 CI 上缓冲：这样失败时能拿到完整输出写进 annotation。
    # ⚠️ 注意**不能**改成 `"$@" | tee` —— 那会让 `$?` 变成 tee 的（恒 0），
    #    正是本脚本最忌讳的「把失败读成通过」。
    out="$(mktemp "${TMPDIR:-/tmp}/check-all.XXXXXX")"
    "$@" >"$out" 2>&1 || rc=$?
    cat "$out"
  else
    "$@" || rc=$?
  fi
  local dt=$((SECONDS - t0))
  case $rc in
    0) printf '   \033[32m✓ 通过\033[0m（%ss）\n' "$dt"; passed=$((passed + 1)) ;;
    2) printf '   \033[33m⚠ 没跑成\033[0m（%ss，退出码 2 = 环境缺东西，**不等于通过**）\n' "$dt"
       skipped=$((skipped + 1)); SKIPPED_NAMES+=("$name")
       FAIL_DETAIL+=("$name|2|$out")
       if [ "$worst" -lt 2 ]; then worst=2; fi ;;
    *) printf '   \033[31m✗ 失败\033[0m（%ss，退出码 %s）\n' "$dt" "$rc"
       failed=$((failed + 1)); FAILED_NAMES+=("$name")
       FAIL_DETAIL+=("$name|$rc|$out")
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

printf '\n（不含 20 个 fault-inject / 17 个 verify —— 要改源码 / 起服务，按需单独跑：`ls scripts/fault-inject-*.py`）\n'
printf '（CI 跑的就是本脚本：`.github/workflows/ci.yml`。覆盖边界与它一致，别读成「全都验过了」。）\n'

case $worst in
  0) printf '\033[32m全绿\033[0m\n' ;;
  1) printf '\033[31m有失败项\033[0m\n' ;;
  2) printf '\033[33m有闸没跑成 —— **不等于通过**，先把环境补齐再下结论\033[0m\n' ;;
esac

# ------------------------------------------------------------------ 写 annotation
#
# 放在最后：失败原因（哪个闸 + 退出码 + 输出尾部）写成 check-run annotation。
# 为什么值得占这一段代码：**读 CI 的人未必有 admin**（我这次就没有）。
# 只有一条「Process completed with exit code 1」的红 CI，等于把诊断成本全推给下一个人。
if [ "$GH_ANNOTATE" = 1 ] && [ "$worst" -ne 0 ]; then
  # ⚠️ GitHub 每个 check-run 的 annotation **有上限**（实测 failure 级 10 条，
  #    超出的会被**静默丢弃**）。所以顺序很关键：
  #
  #    第一版是「一个闸连头带尾发完再发下一个」，12 条额度被第一个红闸的输出吃光 →
  #    后面红的闸**一条都不出现**。**诊断通道自己制造了「看不见的失败」** ——
  #    比没有诊断更坏，因为它看着像「只有这一个闸红了」。
  #
  #    现在**两遍走**：先把**每个**红闸的名字报全（一行一个），再拿剩下的额度补输出尾部。
  _ann=0
  for _entry in "${FAIL_DETAIL[@]}"; do
    _nm="${_entry%%|*}"; _rest="${_entry#*|}"
    _rc="${_rest%%|*}"
    if [ "$_rc" = 2 ]; then _kind="没跑成（环境缺东西，**不等于通过**）"; else _kind="失败"; fi
    printf '::error::闸「%s」%s，退出码 %s\n' "$_nm" "$_kind" "$_rc"
    _ann=$((_ann + 1))
  done

  # 第二遍：补输出尾部。尾部比头部有用（头部多半是启动噪声），所以取 tail。
  for _entry in "${FAIL_DETAIL[@]}"; do
    [ "$_ann" -ge 10 ] && break
    _log="${_entry#*|}"; _log="${_log#*|}"
    [ -n "$_log" ] && [ -f "$_log" ] || continue
    while IFS= read -r _l; do
      # 跳过空行与纯颜色码的行（它们占名额但不带信息）
      case "$(printf '%s' "$_l" | gh_strip_ansi | tr -d '[:space:]')" in
        '') continue ;;
      esac
      printf '::error::  %s\n' "$(printf '%s' "$_l" | gh_strip_ansi | gh_escape)"
      _ann=$((_ann + 1))
      [ "$_ann" -ge 10 ] && break
    done < <(tail -n 15 "$_log")
  done

  # 清理临时日志（无论是否用上）
  for _entry in "${FAIL_DETAIL[@]}"; do
    _log="${_entry#*|}"; _log="${_log#*|}"
    [ -n "$_log" ] && rm -f "$_log"
  done
fi

exit $worst
