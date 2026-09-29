#!/usr/bin/env bash
#
# 前端 UI 单测（designer-react 自己的 vitest）。
#
# ## 为什么需要这个脚本
#
# `ts-test.sh` 只覆盖 `openprint/src/report/*.ts` —— 那是**纯函数层**
# （`environment: 'node'`、无 DOM、无 Univer）。而 `designer-react/src/**/*.spec.tsx`
# 这批要 **jsdom + antd + React**，只能用它自己装的那份 vitest 跑。
#
# 于是出现过**两次同一个真空**：一批 spec 文件没有任何脚本会跑它们。
#   · 2026-09-27：44 个 designer-react spec 里只有 12 个（`grid-report-*`）进了闸，
#     另外 **32 个**（canvas / panels / toolbar / stores / modals…）没有跑器 ——
#     而这件事被**写进了 `check-all.sh` 的注释当「已知覆盖缺口」**（理由「346s 太贵」）。
#   · 2026-09-29：去掉过滤，**44 个全跑**（44 文件 / 390 用例 / ~349s*，**全过**）。
# 教训：**写进注释 ≠ 处理了**。注释会让缺口看起来「已经权衡过」，于是没人再动它。
# 这正是本项目反复吃过的「**没有跑器的闸比红的闸更坏**」。
#
# ## ⚠️ `--no-file-parallelism` 不是性能选项，是**正确性**要求
#
# 默认（文件级并行）下这套 UI 用例会**互相抢 CPU**，实测（2026-09-27，当时 43 个文件）：
#
#   默认并行：43 文件 / 375 用例 → **16 失败 / 359 通过**（238s）
#   串行：    43 文件 / 375 用例 → **0 失败 / 375 通过**（346s）
#
# 现状（2026-09-29 实测，串行）：**44 文件 / 390 用例 → 0 失败 / 390 通过（349s*）**。
# （`*` = 带 WorkBuddy 会话 shim 的数，真实 **99s**，见下面「那个 349s 本身也是被污染的」。）
#
# 而且**同样的 4 个文件单独跑 4/4 全绿**（各 14~21s）——
# 失败全是 `Test timed out` / `expected '' to contain '标签网格'` 这类
# 「渲染还没跑完就被判死」的形态，不是真缺陷。
# 那些用例里有真实 `setTimeout`（`flow-label` 有 `setTimeout(900)`），
# 并行把它们饿死就变红。**别把这种红当回归去「修」。**
#
# 结论：本脚本**固定串行**。想快就用过滤参数只跑一部分（见下）。
#
# ## ⚠️ 量耗时别用「紧接着上一次跑」的结果当基准
#
# 同一条命令（`grid-report-` 过滤）实测过 **96s** 和 **161s** 两个数 ——
# 96s 那次是**紧跟在另一次 vitest 之后**跑的，vite 的 transform 缓存是热的。
# 冷一点就是 161s（check-all 里那道实测 162s，稳定复现）。
# 2026-09-27 又见过 **230s**（同机同时还在跑别的命令）→ 这个数**随负载浮动**，
# **别拿耗时当回归判据**（用例数才是）。**全量（44 文件）实测 349s**。
# 顺手排除过一个嫌疑：**加不加那两个 preload 都是 161s**，
# 所以 preload 不是拖慢的原因（留着是为了和 `fault-inject-*-ui.py` 一致）。
# 写进注释的数字一律取**偏保守**的那个。
#
# ## ⚠️ 但那个 349s 本身也是**被污染的**（2026-09-29 查明）
#
# WorkBuddy 会给 `NODE_OPTIONS` 注入一个 `--require` shim（`node-language-shim.cjs`，
# 给每个 node 进程打 fs 补丁）。vitest **每个测试文件起一个进程** ⇒ 成本 × 文件数。
#
#     带 shim：343s（本文件这条命令）      清掉：**99s**   ← 同一份代码、同一台机器
#
# **CI 上没有这个 shim** ⇒ 拿本机数和 CI 比会得出**反向**结论
# （CI 闸 7 = 173s，比真实本机的 99s **慢**）。见 `check-all.sh` 顶部与《架构体检》§11.6。
# 要真实本机耗时：`NODE_OPTIONS="" bash scripts/check-all.sh`。
#
# ## 用法
#
#   bash scripts/ts-test-designer.sh                # **全部** spec（44 文件 / 390 用例；~349s*）← 闸 7 用的就是这条
#   bash scripts/ts-test-designer.sh grid-report-   # 按文件名过滤（12 文件 / 151 用例；~185s）—— 日常改弹窗的快通道
#   bash scripts/ts-test-designer.sh grid-report-issues -t '看得见'   # 再按用例名过滤（参数透传）
#
# 退出码：0 通过 / 2 **没跑成**（designer-react 没装 node_modules）/ 其它 失败。
# 三态的理由见 `check-all.sh` 顶部：把「没检查」报成「失败」是假红。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESIGNER="$ROOT/designer-react"

# node 路径**不写死**，解析顺序见 scripts/node-bin.sh
. "$ROOT/scripts/node-bin.sh"
NODE_BIN="$(require_node)"

if [[ ! -x "$DESIGNER/node_modules/.bin/vitest" ]]; then
  echo "designer-react 里没有 vitest：$DESIGNER/node_modules/.bin/vitest" >&2
  echo "（本仓库在沙箱里装不出 node_modules。缺了就是「没跑成」，不是「失败」。）" >&2
  exit 2
fi

# vitest 走 vite 工具链，不挂这两个 preload 会被 broker 拦（见 skill sandbox-broker-workarounds）。
# 实测不加也能跑，但加上与 fault-inject-*-ui.py 保持一致，少一个「只有某些机器才复现」的变量。
PRELOADS=(
  "$ROOT/scripts/vite-safe-delete-bypass.cjs"
  "$ROOT/scripts/broker-mkdir-throttle.cjs"
)
for p in "${PRELOADS[@]}"; do
  [[ -f "$p" ]] || { echo "缺少 preload：$p" >&2; exit 2; }
done
NODE_OPTIONS_EXTRA=""
for p in "${PRELOADS[@]}"; do
  NODE_OPTIONS_EXTRA="$NODE_OPTIONS_EXTRA --require $p"
done
# shellcheck disable=SC2086
export NODE_OPTIONS="${NODE_OPTIONS:-}${NODE_OPTIONS_EXTRA}"

cd "$DESIGNER" || exit 2

# `--exclude ../openprint/src/**`：那批现在由**闸 8 `ts-test-openprint.sh`** 跑
# （openprint 自己的 vitest，全部 70 个 spec）—— 这里再来一遍是重复劳动
# （而且那份的 import 图更重）。
#
# ⚠️ 2026-09-28 更正：这里原本写的是「那批由 ts-test.sh 用纯 node 环境跑」——
# **那句话是错的。** `ts-test.sh` 只覆盖 `openprint/src/report/`（**3 个**文件），
# 于是 openprint 的 **67 个 spec / 约 676 条用例一条闸都不跑**，
# 而 `check-all.sh` 照样全绿。一个「**闸是绿的、但没有跑器**」被一句错注释掩护了很久。
# 教训：**在注释里给别的闸派活时，先去核那个闸的真实覆盖范围**，别凭印象。
# 位置参数是 vitest 的**文件名过滤**，空着就是全部。
"$NODE_BIN" node_modules/.bin/vitest run \
  --exclude '../openprint/src/**' \
  --no-file-parallelism \
  "$@"
