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
# 于是出现过一个真空：**43 个 designer-react spec 文件，没有任何脚本会跑它们**。
# 改一次 `GridReportModal`，`check-all.sh` 依然全绿 —— 因为根本没有闸在管这个文件。
# 这正是本项目反复吃过的「**没有跑器的闸比红的闸更坏**」。
#
# ## ⚠️ `--no-file-parallelism` 不是性能选项，是**正确性**要求
#
# 默认（文件级并行）下这套 UI 用例会**互相抢 CPU**，实测：
#
#   默认并行：43 文件 / 375 用例 → **16 失败 / 359 通过**（238s）
#   串行：    43 文件 / 375 用例 → **0 失败 / 375 通过**（346s）
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
# 顺手排除过一个嫌疑：**加不加那两个 preload 都是 161s**，
# 所以 preload 不是拖慢的原因（留着是为了和 `fault-inject-*-ui.py` 一致）。
# 写进注释的数字一律取**偏保守**的那个。
#
# ## 用法
#
#   bash scripts/ts-test-designer.sh                  # 全部 designer-react spec（~346s）
#   bash scripts/ts-test-designer.sh grid-report-     # 按文件名过滤（~160s，11 文件 / 136 用例）
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

# `--exclude ../openprint/src/**`：那批由 ts-test.sh 用纯 node 环境跑，
# 这里再来一遍是重复劳动（而且那份的 import 图更重）。
# 位置参数是 vitest 的**文件名过滤**，空着就是全部。
"$NODE_BIN" node_modules/.bin/vitest run \
  --exclude '../openprint/src/**' \
  --no-file-parallelism \
  "$@"
