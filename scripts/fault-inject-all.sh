#!/usr/bin/env bash
#
# 跑所有「**不需要起真服务**」的 fault-inject 脚本。
#
# ## 为什么要有这个脚本
#
# `fault-inject-*.py` 是「**闸的断言真有牙齿**」的**唯一**证明 ——
# 它们故意把产品代码改坏，要求**指定的那条用例/探针变红**。
# 没有它们，「闸是绿的」只说明「没报错」，不说明「抓得住错」。
#
# 而 2026-10-01 之前，这 20 个脚本**一条闸都不跑**：`check-all.sh` 里只有注释提到它们，
# CI 里也没有。这是本项目招牌失败形态「**闸是绿的、但没有跑器**」的**第三个器官**
# （前两个：openprint 引擎层 67 个 spec、designer-react 的 32 个 spec，都已关闭）。
#
# 第三个器官更隐蔽：前两个是「用例没人跑」，这个是「**证明用例有牙齿的脚本**没人跑」。
# 少了它，前面所有的绿都只是**未被检验的自信**。
#
# ## 为什么只跑一部分 —— 分类依据（2026-10-01 逐个读源码得出，不是猜的）
#
# 20 个脚本**异构**，只有 8 个能在「不起服务、不装原生依赖」的环境里跑完：
#
#   · **可 CI 化（8 个，见 CI_ABLE）**：只改源码文本 + 跑一条**已经在 CI 里**的闸
#     （`mirror-check.py` / `cargo test` / designer-react 的 vitest）。零服务、零平台依赖。
#   · **不可（12 个，见 EXCLUDED）**：门禁要 `cargo build` **再起一个 print-server**
#     （探针打 127.0.0.1:18888 / :18907），或者要 `--features odbc` 那套原生驱动。
#     它们的依赖是**真实**的，不是保守估计 —— 每个的理由都写在 EXCLUDED 里。
#
# ⚠️ 所以本脚本的保证**只覆盖 8/20**。别把它的绿读成「20 个都验过了」。
#    剩下 12 个仍然只能按需手跑（改哪个特性跑哪一个）。
#
# ## 三种结果，与 `check-all.sh` 同一套语义
#
#   0  通过      —— 8 个脚本都跑了、都 rc=0（每条注入都被指定用例抓到）
#   1  失败      —— 至少一个脚本 rc≠0（有注入漏网，或锚点失效）
#   2  没跑成    —— 环境缺东西（缺 node_modules / 缺 cargo）**或工作树被弄脏**，
#                   **根本没检查**。绝不能算通过。
#
# 退出码取**最坏**的那一种，且 1 优先于 2（有确凿失败就报失败）。
#
# ## ⚠️ 必须**串行**，这是正确性要求，不是性能选择
#
# 8 个脚本里 **5 个改的是同一个文件**（`designer-react/src/modals/GridReportModal.tsx`），
# 另外几个改 `openprint/src/report/grid-report.ts` / `print-server/src/report/chart.rs`。
# 并行 = 互相读到对方注入到一半的源码 = 结果全是垃圾。所以这里**逐个跑**。
# （同 `ts-test-designer.sh` 的 `--no-file-parallelism`：串行是正确性要求。）
#
# ## ⚠️ `rc=${PIPESTATUS[0]}` 不能省
#
# 为了**边跑边出**（CI 上这活要几十分钟，全缓冲等于全程黑屏），输出进了 `| tee`。
# 那时**要是没有** `set -o pipefail`，`$?` 就是 **tee 的**（恒 0）—— 把失败读成通过。
#
# 本脚本**同时**有顶部的 `set -o pipefail` 和这里的 `PIPESTATUS[0]`，两者**任一**都够用：
#   · `pipefail`：让 `$?` = 管道里最右的非零退出码（通常正好是 python 的）；
#   · `PIPESTATUS[0]`：直接取管道里**第一个**命令（python）的退出码。
# 留 `PIPESTATUS[0]` 是因为它**更精确**：tee 自己失败时（本项目撞过磁盘满），
# `$?` 会拿到 tee 的码，把「没跑成(2)」误报成「失败(1)」—— 指向错的方向。
# 所以这是**双保险**，不是单点依赖。
# ⚠️ 2026-10-02 实测更正：本注释曾写「`$?` 恒 0」，那是**错的** —— 有 `pipefail` 在，
#    `$?` 并不恒 0。当时 `check-fault-inject-all.py` 的 B2 用例（只把这一行换成 `rc=$?`）
#    **没有变绿**，正是它把这个错误结论顶了出来：必须**连 `pipefail` 一起拆**才会退化成
#    「失败读成通过」。这也说明这两者是**冗余**的，而非单行承重。
#
# 用法：
#   bash scripts/fault-inject-all.sh            # 跑全部 8 个（串行，几十分钟）
#   bash scripts/fault-inject-all.sh --list     # 只列出会跑哪些、跳过了哪些
#   bash scripts/fault-inject-all.sh --only ui  # 只跑名字含 ui 的
#
# 退出码：0 / 1 / 2，语义见上。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# ─────────────────────────────────────────────────────────────── 清单
#
# 格式：`脚本名|前置条件`。前置条件 ∈ {none, cargo, designer, designer+openprint}
#   cargo    = PATH 里有 cargo（脚本跑 `cargo test`）
#   designer = designer-react 装好了 vitest
#   openprint= openprint 装好了 vitest
#
# ⚠️ **刻意写死，不用 glob** —— 理由有两层，第二层更重要：
#   1. glob 会把将来新增的、**要起服务**的脚本也吸进来 → CI 上红，而原因难查；
#   2. 写死之后「哪些被 CI 覆盖」才有唯一的事实来源。而为了不让它**漂**，
#      下面有 `check_classification()`：任何 `fault-inject-*.py` 只要不在这两个清单里，
#      本脚本**当场红**。新增脚本时忘了分类 = 不可能静默漏掉。
CI_ABLE=(
  "fault-inject-mirror-semantics.py|none"
  "fault-inject-table-pins.py|cargo"
  "fault-inject-inline-dataset.py|designer"
  "fault-inject-save-confirm.py|designer"
  "fault-inject-issues-ui.py|designer"
  "fault-inject-ui-panel.py|designer"
  "fault-inject-inline-ui.py|designer"
  "fault-inject-ai-dropped.py|designer+openprint"
)

# 格式：`脚本名|不可 CI 化的依据`。依据必须写**它到底要什么**，不能写「太慢」之类。
EXCLUDED=(
  "fault-inject-inline-probe.py|门禁是 verify-inline-dataset.py，打 /api/report/render → 要真服务"
  "fault-inject-atomic-save.py|门禁含 verify-atomic-save.py（起服务 + RLIMIT_FSIZE/SIGXFSZ）"
  "fault-inject-optimistic-lock.py|L8–L13 门禁是 verify-optimistic-lock.py（要真服务，状态码只有真发请求才验得到）"
  "fault-inject-save-conflict.py|S1/S3/S4/S5/S6 门禁是 verify-save-conflict.py（要真服务）"
  "fault-inject-docx.py|自起 print-server:18888；且 PY_BIN 默认值是 macOS 绝对路径"
  "fault-inject-html-style.py|自起 print-server:18907"
  "fault-inject-report-paper.py|自起 print-server:18888"
  "fault-inject-chart-probe.py|自起 print-server:18888"
  "fault-inject-image-probe.py|自起 print-server:18888"
  "fault-inject-conditional.py|门禁是 verify-xlsx-conditional.py --port（要真服务）"
  "fault-inject-barcode-probe.py|门禁是 verify-xlsx-barcode.py --port（要真服务）"
  "fault-inject-odbc-probe.py|要 cargo build --features odbc（unixODBC + sqliteodbc 原生驱动）"
)

ONLY=""; MODE="run"
for a in "$@"; do
  case "$a" in
    --list) MODE="list" ;;
    --only) ONLY="__NEXT__" ;;
    -h|--help) MODE="help" ;;
    *)
      if [ "$ONLY" = "__NEXT__" ]; then ONLY="$a"
      else echo "未知参数：${a}（用 --help 看用法）" >&2; exit 2
      fi
      ;;
  esac
done
[ "$ONLY" = "__NEXT__" ] && { echo "--only 后面要跟一个子串" >&2; exit 2; }
[ "$MODE" = "help" ] && { sed -n '2,68p' "$0"; exit 0; }

# ─────────────────────────────────────────────────────────────── 分类完整性
#
# **这是本脚本最重要的一段**：清单写死就有漂移风险，而漂移的方向恰好是最坏的那种
# ——新脚本既不在 CI_ABLE 也不在 EXCLUDED → 它**永远不跑**，而本脚本照样全绿。
# 那就是把「闸是绿的、但没有跑器」原样复制到这一层。所以：**必须当场红**。
check_classification() {
  local bad=0 f base
  for f in scripts/fault-inject-*.py; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    local found=0 e
    for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"}; do [ "${e%%|*}" = "$base" ] && found=1; done
    for e in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do [ "${e%%|*}" = "$base" ] && found=1; done
    if [ "$found" = 0 ]; then
      printf '\033[31m✗ 新增脚本没有分类：%s\033[0m\n' "$base" >&2
      printf '  它既不在 CI_ABLE 也不在 EXCLUDED ⇒ 永远不会被跑。\n' >&2
      printf '  请在本脚本顶部把它归入其中一个，并写明前置条件 / 不可 CI 化的依据。\n' >&2
      bad=1
    fi
  done
  # 反向：清单里写了但文件不在（改名/删除了），同样是漂移
  local e
  for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"} ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
    if [ ! -f "scripts/${e%%|*}" ]; then
      printf '\033[31m✗ 清单里的脚本不存在：%s\033[0m\n' "${e%%|*}" >&2
      bad=1
    fi
  done
  return $bad
}

if ! check_classification; then
  echo >&2
  echo "（分类清单与磁盘上的脚本对不上 —— 在修好之前**不跑任何注入**，免得给出误导性的绿。）" >&2
  exit 2
fi

# `--list` 放在分类校验**之后**：否则清单漂了的时候，`--list` 会照样打印一份
# 「看着挺全」的清单 —— 那正是本脚本最想消灭的那种「看着像检查过了」。
if [ "$MODE" = "list" ]; then
  printf '会跑（%d 个，串行）：\n' "${#CI_ABLE[@]}"
  for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"}; do printf '  ✓ %-38s [%s]\n' "${e%%|*}" "${e##*|}"; done
  printf '\n不跑（%d 个）—— 每个都写明了它到底要什么：\n' "${#EXCLUDED[@]}"
  for e in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do printf '  · %-38s %s\n' "${e%%|*}" "${e##*|}"; done
  printf '\n⚠️ 本脚本的保证只覆盖上面那 %d 个。别读成「20 个都验过了」。\n' "${#CI_ABLE[@]}"
  exit 0
fi

# ─────────────────────────────────────────────────────────────── 前置条件
prereq_ok() {
  case "$1" in
    none) return 0 ;;
    cargo) command -v cargo >/dev/null 2>&1 ;;
    designer) [ -x "$ROOT/designer-react/node_modules/.bin/vitest" ] ;;
    openprint) [ -e "$ROOT/openprint/node_modules/vitest/vitest.mjs" ] ;;
    designer+openprint)
      [ -x "$ROOT/designer-react/node_modules/.bin/vitest" ] \
        && [ -e "$ROOT/openprint/node_modules/vitest/vitest.mjs" ] ;;
    *) return 1 ;;
  esac
}

prereq_why() {
  case "$1" in
    cargo) printf 'PATH 里没有 cargo' ;;
    designer) printf 'designer-react 没装 node_modules（缺 vitest）' ;;
    openprint) printf 'openprint 没装 node_modules（缺 vitest）' ;;
    designer+openprint) printf 'designer-react 或 openprint 没装 node_modules' ;;
    *) printf '前置条件未知：%s' "$1" ;;
  esac
}

# ─────────────────────────────────────────────────────────────── 诊断通道
#
# 与 `check-all.sh` 同一套理由：GitHub Actions 上 **check-run 的 annotation 是唯一
# 不需要 admin 权限就能读到的输出**（job log 走 API 要 admin，实测 403）。
GH_ANNOTATE=0
[ "${GITHUB_ACTIONS:-}" = "true" ] && GH_ANNOTATE=1

gh_escape() { sed -e 's/%/%25/g' -e 's/\r//g'; }
gh_strip_ansi() { sed $'s/\033\\[[0-9;]*[A-Za-z]//g'; }

# ─────────────────────────────────────────────────────────────── 工作树守卫
#
# 注入脚本会**就地改源码再还原**。它要是被强杀（CI 超时 / OOM / 磁盘满），
# 源码就停在**注入态**，后面每个脚本都会锚点失配、报一堆「没验过」——
# 那些红**指向的是错的方向**（看着像断言没牙齿，其实是工作树脏了）。
# 所以每跑一个就比一次指纹；变了就**停下并报「没跑成」**（不自动还原 ——
# 本机可能有用户未提交的改动，自动 `git checkout` 会毁掉它们）。
tree_fp() { git status --porcelain 2>/dev/null | sort; }

printf '\033[1mfault-inject-all\033[0m（%s）\n' "$ROOT"
printf '模式：串行；只跑「不需要起真服务」的 %d/%d 个脚本\n' "${#CI_ABLE[@]}" "$(( ${#CI_ABLE[@]} + ${#EXCLUDED[@]} ))"

BASE_FP="$(tree_fp)"
if [ -n "$BASE_FP" ]; then
  printf '\033[33m⚠ 工作树本来就不干净（%d 个改动）。\n' "$(printf '%s\n' "$BASE_FP" | wc -l | tr -d ' ')"
  printf '  注入脚本改的是同一批文件；未提交的改动可能被当作「注入残留」。建议先 stash/commit。\033[0m\n'
fi

# ─────────────────────────────────────────────────────────────── 跑
passed=0; failed=0; skipped=0; worst=0
declare -a FAILED_NAMES=() SKIPPED_NAMES=() DETAIL=() FAIL_LOG=()
T_START=$SECONDS

for entry in ${CI_ABLE[@]+"${CI_ABLE[@]}"}; do
  name="${entry%%|*}"; need="${entry##*|}"
  [ -n "$ONLY" ] && case "$name" in *"$ONLY"*) ;; *) continue ;; esac

  printf '\n\033[1m── %s ──\033[0m（前置：%s）\n' "$name" "$need"

  if ! prereq_ok "$need"; then
    printf '   \033[33m⚠ 没跑成\033[0m：%s\n' "$(prereq_why "$need")"
    skipped=$((skipped + 1)); SKIPPED_NAMES+=("$name")
    DETAIL+=("$name|2|0"); FAIL_LOG+=("$name|2|")
    [ "$worst" -lt 2 ] && worst=2
    continue
  fi

  log="$(mktemp "${TMPDIR:-/tmp}/fi-all.XXXXXX")"
  t0=$SECONDS
  # `-u`：python 往管道写时会**块缓冲**（4KB 才吐一次）⇒ 长脚本全程黑屏。
  # 这个坑 2026-10-01 实测撞过：日志文件一直是 0 字节，看着像「卡住了」。
  python3 -u "scripts/$name" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}          # 取 python 自己的退出码（顶部「不能省」一节：与 pipefail 双保险）
  dt=$((SECONDS - t0))
  DETAIL+=("$name|$rc|$dt")

  case $rc in
    0) printf '   \033[32m✓ 通过\033[0m（%ss）\n' "$dt"; passed=$((passed + 1)) ;;
    2) printf '   \033[33m⚠ 没跑成\033[0m（%ss，退出码 2 = 它自己说「没验成」，**不等于通过**）\n' "$dt"
       skipped=$((skipped + 1)); SKIPPED_NAMES+=("$name")
       FAIL_LOG+=("$name|2|$log")
       [ "$worst" -lt 2 ] && worst=2 ;;
    *) printf '   \033[31m✗ 失败\033[0m（%ss，退出码 %s —— 有注入没被抓到，或锚点失效）\n' "$dt" "$rc"
       failed=$((failed + 1)); FAILED_NAMES+=("$name")
       FAIL_LOG+=("$name|$rc|$log")
       [ "$worst" -lt 1 ] && worst=1 ;;
  esac

  # 工作树守卫：上一个脚本有没有把源码留在注入态
  NOW_FP="$(tree_fp)"
  if [ "$NOW_FP" != "$BASE_FP" ]; then
    printf '\033[31m✗ 工作树在 %s 跑完之后变了 —— 它可能被中断、没还原干净。\033[0m\n' "$name"
    printf '  后面的结果**不可信**，就此停下。变动的文件：\n'
    printf '%s\n' "$NOW_FP" | sed 's/^/    /'
    [ "$worst" -lt 2 ] && worst=2
    break
  fi
done

# ─────────────────────────────────────────────────────────────── 汇总

printf '\n\033[1m══ 汇总 ══\033[0m\n'
printf '通过 %d · 失败 %d · 没跑成 %d\n' "$passed" "$failed" "$skipped"
[ "${#FAILED_NAMES[@]}" -gt 0 ]  && printf '失败：%s\n'   "${FAILED_NAMES[*]}"
[ "${#SKIPPED_NAMES[@]}" -gt 0 ] && printf '没跑成：%s\n' "${SKIPPED_NAMES[*]}"

printf '\n（本脚本只覆盖 %d/%d 个 fault-inject；另 %d 个要起真服务或原生驱动，见 --list。）\n' \
  "${#CI_ABLE[@]}" "$(( ${#CI_ABLE[@]} + ${#EXCLUDED[@]} ))" "${#EXCLUDED[@]}"

case $worst in
  # 用实际跑过的条数，**不写死 8** —— `--only` 时会少跑，写死就成了一句假话
  0) printf '\033[32m全绿\033[0m —— %d 个脚本的每条注入都被指定用例/探针抓到了\n' "${#DETAIL[@]}" ;;
  1) printf '\033[31m有失败项\033[0m —— 有注入漏网（闸的断言没牙齿），见上\n' ;;
  2) printf '\033[33m有脚本没跑成 —— **不等于通过**，先把环境补齐再下结论\033[0m\n' ;;
esac

# ─────────────────────────────────────────────────────────────── annotation
#
# 与 check-all.sh 同：**先报全每个失败脚本的名字**（一行一条），再拿剩余额度补输出尾部。
# 顺序很重要 —— GitHub 每个 check-run 的 annotation 有上限（实测 failure 级 10 条），
# 「一个脚本连头带尾发完再发下一个」会让额度被第一个吃光，后面的**一条都不出现**。
TOTAL=$((SECONDS - T_START))
if [ "$GH_ANNOTATE" = 1 ]; then
  if [ "$worst" -ne 0 ]; then
    _ann=0
    for _e in ${FAIL_LOG[@]+"${FAIL_LOG[@]}"}; do
      _nm="${_e%%|*}"; _rest="${_e#*|}"; _rc="${_rest%%|*}"
      if [ "$_rc" = 2 ]; then _kind="没跑成（**不等于通过**）"; else _kind="失败（有注入漏网）"; fi
      printf '::error::fault-inject「%s」%s，退出码 %s\n' "$_nm" "$_kind" "$_rc"
      _ann=$((_ann + 1))
    done
    for _e in ${FAIL_LOG[@]+"${FAIL_LOG[@]}"}; do
      [ "$_ann" -ge 10 ] && break
      _log="${_e#*|}"; _log="${_log#*|}"
      [ -n "$_log" ] && [ -f "$_log" ] || continue
      while IFS= read -r _l; do
        case "$(printf '%s' "$_l" | gh_strip_ansi | tr -d '[:space:]')" in '') continue ;; esac
        printf '::error::  %s\n' "$(printf '%s' "$_l" | gh_strip_ansi | gh_escape)"
        _ann=$((_ann + 1))
        [ "$_ann" -ge 10 ] && break
      done < <(tail -n 12 "$_log")
    done
  else
    _summary=""
    for _e in ${DETAIL[@]+"${DETAIL[@]}"}; do
      _nm="${_e%%|*}"; _rest="${_e#*|}"; _dt="${_rest#*|}"
      _summary="${_summary}${_summary:+ · }${_nm} ✓${_dt}s"
    done
    printf '::notice::fault-inject 全绿：跑完 %d 个脚本，共 %ss。明细：%s\n' \
      "${#DETAIL[@]}" "$TOTAL" "$_summary" | gh_escape
  fi
fi

for _l in ${FAIL_LOG[@]+"${FAIL_LOG[@]}"}; do
  _p="${_l#*|}"; _p="${_p#*|}"
  [ -n "$_p" ] && rm -f "$_p"
done

exit $worst
