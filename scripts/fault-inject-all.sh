#!/usr/bin/env bash
#
# 跑 fault-inject 脚本：默认跑「**不需要起真服务**」的 8 个，`--service` 跑「自己起停
# print-server」的 7 个。两个模式共用同一套退出码语义、守卫与日志机制。
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
# ## 为什么只跑一部分 —— 分类依据（逐个读源码得出，不是猜的）
#
# 20 个脚本**异构**，按「跑它需要什么」分三组：
#
#   · **免服务（8 个，见 CI_ABLE）**：只改源码文本 + 跑一条**已经在 CI 里**的闸
#     （`mirror-check.py` / `cargo test` / designer-react 的 vitest）。零服务、零平台依赖。
#   · **要服务（7 个，见 SERVICE_ABLE）**：门禁要 `cargo build` **再起一个 print-server**
#     （探针打 127.0.0.1:18888 / :1890x）。它们**自己起停服务**，所以只要 cargo 就能跑
#     —— 2026-10-12 起由第三个 CI 作业（`fault-inject-service`）覆盖。
#   · **CI 化不了（5 个，见 EXCLUDED）**：要 `--features odbc` 那套原生驱动，
#     或者门禁是**有状态**的（乐观锁 / 覆盖冲突 / 磁盘满注入 RLIMIT_FSIZE）。
#     每个的理由都写在 EXCLUDED 里 —— 必须是**真实**的依赖，不许写「太慢」。
#
# ⚠️ 所以单个模式的保证**不覆盖全部 20 个**。别把任一模式的绿读成「20 个都验过了」。
#    两个模式都绿 = 15/20 有跑器；剩下 5 个仍然只能按需手跑（改哪个特性跑哪一个）。
#
# ## 三种结果，与 `check-all.sh` 同一套语义
#
#   0  通过      —— 当前模式的脚本都跑了、都 rc=0（每条注入都被指定用例/探针抓到）
#   1  失败      —— 至少一个脚本 rc≠0（有注入漏网，或锚点失效）
#   2  没跑成    —— 环境缺东西（缺 node_modules / 缺 cargo）**或工作树被弄脏**，
#                   **根本没检查**。绝不能算通过。
#
# 退出码取**最坏**的那一种，且 1 优先于 2（有确凿失败就报失败）。
#
# ## ⚠️ 必须**串行**，这是正确性要求，不是性能选择
#
# 免服务模式里 **5 个脚本改同一个文件**（`designer-react/src/modals/GridReportModal.tsx`），
# 另外几个改 `openprint/src/report/grid-report.ts` / `print-server/src/report/chart.rs`；
# 要服务模式改的是 `print-server/src/report/{docx,xlsx,engine,model,mod,store}.rs`，
# 而且 6 个脚本共用 18888 端口。两种并行都会互相读到对方注入到一半的源码
# = 结果全是垃圾。所以**逐个跑**（同一时刻只允许一个实例，见下面的锁）。
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
#   bash scripts/fault-inject-all.sh            # 跑免服务的 8 个（串行，几十分钟）
#   bash scripts/fault-inject-all.sh --service  # 跑要服务的 7 个（自己起停 print-server）
#   bash scripts/fault-inject-all.sh --list     # 三组清单：会跑哪些、为什么跳过哪些
#   bash scripts/fault-inject-all.sh --only ui  # 只跑名字含 ui 的（配合上面任一模式）
#   bash scripts/fault-inject-all.sh --ci       # 等价于在前面写 CI=true（见下节）
#
# ## ⚠️ 碰「解析测试输出」的改动，本机必须带 `CI=true` 再验一次
#
# 2026-10-08 实测：`fault-inject-save-confirm.py` 漏了剥 ANSI ⇒
# **本机全绿、CI 全红**（run #17/#18）。链路：GitHub Actions 默认设 `CI=true`
# → `picocolors` 的判据里有 `|| !!env.CI`（`picocolors.js:4`，**与 TTY 无关**，
# 重定向到文件也照样上色）→ vitest 把 `FAIL ` 包成 `c.bgRed(c.bold(...))`
# → 按行首匹配的判据一条都认不出来 ⇒ 14 条注入全被报成「红了但不是期望的用例」。
# 详见《架构体检》§13.7。复现 CI 的那两条命令（后者等价于前者，`--ci` 只是省事）：
#
#   CI=true bash scripts/fault-inject-all.sh --only save-confirm
#   bash scripts/fault-inject-all.sh --ci --only save-confirm
#
# ## 日志
#
# 设了 `FAULT_INJECT_LOG_DIR` 就把每个脚本的**完整日志**留在那个目录里（CI 上会整包
# 上传成 artifact）。没设就退回 `mktemp`，跑完即删。
# 为什么值得多这么一条路：job log 走 API 要 admin（403），而 check-run 的 annotation
# 只有 **10 条**额度 —— 一个失败脚本的头+尾就吃光了，根因根本读不到。
#
# 退出码：0 / 1 / 2，语义见上。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# ─────────────────────────────────────────────────────────────── 并发守卫
#
# 免服务模式里 **5 个脚本改同一个文件**（`designer-react/src/modals/GridReportModal.tsx`），
# 要服务模式 6 个脚本共用 18888。两个实例同时跑会互相读到对方的注入态，
# 甚至把对方的注入当成「原文」写回去 —— 结果全是垃圾，而且**有可能真的把
# 注入态提交进仓库**。（2026-10-08 差一点自己踩上。）
#
# 用 **PID 文件**而不是 `pgrep`：`pgrep -f fault-inject-all.sh` 会连**父 shell 的命令行**
# 一起命中（工具链里是 `zsh -c '… bash scripts/fault-inject-all.sh …'`），必然误报。
# PID 文件 + `kill -0` 既准确又能自愈：上一个被强杀留下的过期锁会被自动接管。
LOCK="${TMPDIR:-/tmp}/fault-inject-all.lock"
if [ -s "$LOCK" ]; then
  _prev="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$_prev" ] && kill -0 "$_prev" 2>/dev/null; then
    printf '\033[31m✗ 已经有实例在跑（pid %s）—— 注入脚本就地改源码再还原，并发跑结果全是垃圾。\033[0m\n' "$_prev" >&2
    printf '  等它跑完再来。锁文件：%s\n' "$LOCK" >&2
    exit 2
  fi
  printf '\033[33m（发现过期锁 pid=%s，它已经不在了 —— 接管。）\033[0m\n' "$_prev" >&2
fi
printf '%s\n' "$$" > "$LOCK"
# 退出时**清空**而不是删除：删要走 brokered 的 `rm`（那会把文件搬进废纸篓，
# 每跑一次就多一件垃圾）。清空之后 `[ -s ]` 为假，等价于「没有锁」。
trap ': > "$LOCK"' EXIT

# ─────────────────────────────────────────────────────────────── 清单（三组）
#
# ⚠️ **刻意写死，不用 glob** —— 理由有两层，第二层更重要：
#   1. glob 会把将来新增的、**要起服务**的脚本也吸进来 → CI 上红，而原因难查；
#   2. 写死之后「哪些被 CI 覆盖」才有唯一的事实来源。而为了不让它**漂**，
#      下面有 `check_classification()`：任何 `fault-inject-*.py` 只要不在这三张
#      清单里（或在里面出现两次），本脚本**当场红**。新增脚本时忘了分类 =
#      不可能静默漏掉。
#
# 格式：`脚本名|前置条件`。前置条件是 `+` 分隔的组合，元素 ∈ {none, cargo, designer, openprint}：
#   cargo    = PATH 里有 cargo（脚本跑 `cargo test` 或自己 `cargo build`）
#   designer = designer-react 装好了 vitest
#   openprint= openprint 装好了 vitest

# 第一组：免服务。只改源码文本 + 跑一条**已经在 CI 里**的闸。
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

# 第二组：要服务。每个脚本**自己起停 print-server**（占用 18888 / 18903 / 18905 / 18907），
# 所以前置条件就是「有 cargo（+ 跑 UI 侧门禁的那份 node_modules）」。
# 2026-10-12 从 EXCLUDED 迁出来 —— 迁出条件**不是**「我想跑」，而是逐个消掉了
# 三处本机写死：① 二进制路径改 `server_bin.resolve_server_bin()`（原来写死
# `~/.cargo/target/debug/print-server`，CI 上 cargo 用默认的 `print-server/target`）；
# ② `PY` 默认 `sys.executable`（原来写死本机 venv 绝对路径）；
# ③ conditional.py 的 NODE_OPTIONS 改仓库相对路径 + 补剥 ANSI（它按
#   `Tests N passed` 读 vitest 输出，与 save-confirm 2026-10-08 红掉的是同一个根因）。
# 判据见 `scripts/server_bin.py` 顶部与《架构体检》§13.8。
SERVICE_ABLE=(
  "fault-inject-image-probe.py|cargo"
  "fault-inject-chart-probe.py|cargo"
  "fault-inject-docx.py|cargo"
  "fault-inject-html-style.py|cargo"
  "fault-inject-conditional.py|designer+cargo"
  "fault-inject-barcode-probe.py|cargo"
  "fault-inject-report-paper.py|designer+openprint+cargo"
)

# 第三组：CI 化不了。格式：`脚本名|依据`。依据必须写**它到底要什么**，
# 不能写「太慢」之类 —— 这条纪律和「闸必须能失败」是同一条。
EXCLUDED=(
  "fault-inject-inline-probe.py|门禁 verify-inline-dataset.py 要一个**已经在跑**的服务；注入脚本自己不起服务（按需手跑）"
  "fault-inject-atomic-save.py|门禁含 verify-atomic-save.py（起服务 + RLIMIT_FSIZE/SIGXFSZ 造「写一半被杀」）"
  "fault-inject-optimistic-lock.py|L8–L13 门禁是 verify-optimistic-lock.py（要真服务，状态码只有真发请求才验得到）"
  "fault-inject-save-conflict.py|S1/S3/S4/S5/S6 门禁是 verify-save-conflict.py（要真服务）"
  "fault-inject-odbc-probe.py|要 cargo build --features odbc（unixODBC + sqliteodbc 原生驱动）"
)

ONLY=""; MODE="run"
for a in "$@"; do
  case "$a" in
    --list) MODE="list" ;;
    --service) MODE="service" ;;
    # 把本机也变成 CI 的输出格式（等价于 `CI=true bash …`）。凡是改过
    # 「解析测试输出」的代码，必须带着它再验一次（§13.7 那条链路）。
    --ci) export CI=true ;;
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
[ "$MODE" = "help" ] && { sed -n '2,/^# 退出码：0 \/ 1 \/ 2，语义见上。$/p' "$0"; exit 0; }

# 当前模式跑哪一组（`--list` 不走这条，它三组都打印）。
if [ "$MODE" = "service" ]; then
  ACTIVE=("${SERVICE_ABLE[@]}")
else
  ACTIVE=("${CI_ABLE[@]}")
fi

# ─────────────────────────────────────────────────────────────── 分类完整性
#
# **这是本脚本最重要的一段**：清单写死就有漂移风险，而漂移的方向恰好是最坏的那种
# ——新脚本既不在 CI_ABLE 也不在 EXCLUDED → 它**永远不跑**，而本脚本照样全绿。
# 那就是把「闸是绿的、但没有跑器」原样复制到这一层。所以：**必须当场红**。
check_classification() {
  local bad=0 f base e found
  for f in scripts/fault-inject-*.py; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    found=0
    for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"} \
             ${SERVICE_ABLE[@]+"${SERVICE_ABLE[@]}"} \
             ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
      [ "${e%%|*}" = "$base" ] && found=$((found + 1))
    done
    if [ "$found" = 0 ]; then
      printf '\033[31m✗ 新增脚本没有分类：%s\033[0m\n' "$base" >&2
      printf '  它不在 CI_ABLE / SERVICE_ABLE / EXCLUDED 任何一张里 ⇒ 永远不会被跑。\n' >&2
      printf '  请在本脚本顶部把它归入其中一组，并写明前置条件 / 不可 CI 化的依据。\n' >&2
      bad=1
    elif [ "$found" -gt 1 ]; then
      printf '\033[31m✗ 脚本被分了两次类：%s（%d 次）\033[0m\n' "$base" "$found" >&2
      printf '  在两个模式里各跑一遍 = 双倍耗时，且「唯一的事实来源」不再唯一。\n' >&2
      bad=1
    fi
  done
  # 反向：清单里写了但文件不在（改名/删除了），同样是漂移
  for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"} \
           ${SERVICE_ABLE[@]+"${SERVICE_ABLE[@]}"} \
           ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do
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
  printf '① 免服务（%d 个，串行）—— 默认模式跑这组：\n' "${#CI_ABLE[@]}"
  for e in ${CI_ABLE[@]+"${CI_ABLE[@]}"}; do printf '  ✓ %-38s [%s]\n' "${e%%|*}" "${e##*|}"; done
  printf '\n② 要服务（%d 个，串行）—— `--service` 跑这组；每个脚本自己起停 print-server：\n' "${#SERVICE_ABLE[@]}"
  for e in ${SERVICE_ABLE[@]+"${SERVICE_ABLE[@]}"}; do printf '  ✓ %-38s [%s]\n' "${e%%|*}" "${e##*|}"; done
  printf '\n③ 不跑（%d 个）—— 每个都写明了它到底要什么：\n' "${#EXCLUDED[@]}"
  for e in ${EXCLUDED[@]+"${EXCLUDED[@]}"}; do printf '  · %-38s %s\n' "${e%%|*}" "${e##*|}"; done
  printf '\n⚠️ ① 的绿 = 这 %d 个验过了；② 的绿 = 另外 %d 个验过了。\n' "${#CI_ABLE[@]}" "${#SERVICE_ABLE[@]}"
  printf '   两个都绿才是 %d/%d 有跑器 —— 任何单独一个都**不是**「全都验过了」。\n' \
    "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} ))" "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} + ${#EXCLUDED[@]} ))"
  exit 0
fi

# ─────────────────────────────────────────────────────────────── 前置条件
#
# 前置条件是 `+` 分隔的组合（如 `designer+cargo`）：逐项查，任何一项不满足就算没跑成。
prereq_ok() {
  local ok=0 t
  local -a need
  IFS='+' read -ra need <<< "$1"
  for t in "${need[@]}"; do
    case "$t" in
      none) ;;
      cargo) command -v cargo >/dev/null 2>&1 || ok=1 ;;
      designer) [ -x "$ROOT/designer-react/node_modules/.bin/vitest" ] || ok=1 ;;
      openprint) [ -e "$ROOT/openprint/node_modules/vitest/vitest.mjs" ] || ok=1 ;;
      *) ok=1 ;;
    esac
  done
  return $ok
}

prereq_why() {
  local why="" t
  local -a need
  IFS='+' read -ra need <<< "$1"
  for t in "${need[@]}"; do
    case "$t" in
      none) ;;
      cargo) command -v cargo >/dev/null 2>&1 || why="${why:+$why；}PATH 里没有 cargo" ;;
      designer) [ -x "$ROOT/designer-react/node_modules/.bin/vitest" ] \
        || why="${why:+$why；}designer-react 没装 node_modules（缺 vitest）" ;;
      openprint) [ -e "$ROOT/openprint/node_modules/vitest/vitest.mjs" ] \
        || why="${why:+$why；}openprint 没装 node_modules（缺 vitest）" ;;
      *) why="${why:+$why；}前置条件未知：$t" ;;
    esac
  done
  printf '%s' "$why"
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
#
# ⚠️ 指纹**只圈注入脚本真的会碰的路径**（2026-10-12 收窄）：三组注入逐条读过，
#    它们只改 `designer-react/src/`、`openprint/src/`、`print-server/src/` 下的源码。
#    整棵树的指纹会把「跑器在跑的时候顺手改了文档 / 别的脚本」也当成注入残留 ——
#    那是**误报**：停下列表明红，原因却指向错的方向（和这条守卫要防的恰好同款）。
#    别处的改动从此不拦；但这三处照旧无条件拦。
INJECT_SCOPE='(designer-react|openprint|print-server)/src/'
tree_fp() { git status --porcelain 2>/dev/null | grep -E "^.. $INJECT_SCOPE" | sort; }

printf '\033[1mfault-inject-all\033[0m（%s）\n' "$ROOT"
if [ "$MODE" = "service" ]; then
  printf '模式：串行；跑「要服务」的 %d/%d 个脚本（每个自己起停 print-server）\n' \
    "${#ACTIVE[@]}" "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} + ${#EXCLUDED[@]} ))"
else
  printf '模式：串行；跑「免服务」的 %d/%d 个脚本\n' \
    "${#ACTIVE[@]}" "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} + ${#EXCLUDED[@]} ))"
fi

BASE_FP="$(tree_fp)"
if [ -n "$BASE_FP" ]; then
  printf '\033[33m⚠ src/ 三处本来就有未提交改动（%d 个）。\n' "$(printf '%s\n' "$BASE_FP" | wc -l | tr -d ' ')"
  printf '  注入脚本改的是同一批文件；未提交的改动可能被当作「注入残留」。建议先 stash/commit。\033[0m\n'
fi

# ─────────────────────────────────────────────────────────────── 跑
passed=0; failed=0; skipped=0; worst=0
declare -a FAILED_NAMES=() SKIPPED_NAMES=() DETAIL=() FAIL_LOG=()
T_START=$SECONDS

for entry in ${ACTIVE[@]+"${ACTIVE[@]}"}; do
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

  if [ -n "${FAULT_INJECT_LOG_DIR:-}" ]; then
    mkdir -p "$FAULT_INJECT_LOG_DIR"
    log="$FAULT_INJECT_LOG_DIR/${name%.py}.log"
  else
    log="$(mktemp "${TMPDIR:-/tmp}/fi-all.XXXXXX")"
  fi
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
    printf '  （守卫只圈 designer-react/src · openprint/src · print-server/src —— \n'
    printf '    别处的改动不会误报；变的是这三处，一律按「注入残留」处理。）\n'
    [ "$worst" -lt 2 ] && worst=2
    break
  fi
done

# ─────────────────────────────────────────────────────────────── 汇总

printf '\n\033[1m══ 汇总 ══\033[0m\n'
printf '通过 %d · 失败 %d · 没跑成 %d\n' "$passed" "$failed" "$skipped"
[ "${#FAILED_NAMES[@]}" -gt 0 ]  && printf '失败：%s\n'   "${FAILED_NAMES[*]}"
[ "${#SKIPPED_NAMES[@]}" -gt 0 ] && printf '没跑成：%s\n' "${SKIPPED_NAMES[*]}"

if [ "$MODE" = "service" ]; then
  printf '\n（本模式（--service）覆盖 %d/%d 个；免服务模式另覆盖 %d 个；剩 %d 个要原生驱动或有状态门禁，见 --list。）\n' \
    "${#ACTIVE[@]}" "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} + ${#EXCLUDED[@]} ))" "${#CI_ABLE[@]}" "${#EXCLUDED[@]}"
else
  printf '\n（本模式覆盖 %d/%d 个；`--service` 另覆盖 %d 个；剩 %d 个要原生驱动或有状态门禁，见 --list。）\n' \
    "${#ACTIVE[@]}" "$(( ${#CI_ABLE[@]} + ${#SERVICE_ABLE[@]} + ${#EXCLUDED[@]} ))" "${#SERVICE_ABLE[@]}" "${#EXCLUDED[@]}"
fi
[ -n "${FAULT_INJECT_LOG_DIR:-}" ] && \
  printf '日志留档：%s（每个脚本一份完整输出）\n' "$FAULT_INJECT_LOG_DIR"

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

# 只有 `mktemp` 出来的临时日志才删。`FAULT_INJECT_LOG_DIR` 里的是**留档**，
# 要留着给 CI 上传 artifact —— 失败时那份日志才是唯一能读到的证据。
if [ -z "${FAULT_INJECT_LOG_DIR:-}" ]; then
  for _l in ${FAIL_LOG[@]+"${FAIL_LOG[@]}"}; do
    _p="${_l#*|}"; _p="${_p#*|}"
    [ -n "$_p" ] && rm -f "$_p"
  done
fi

exit $worst
