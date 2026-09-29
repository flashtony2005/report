#!/usr/bin/env bash
#
# 引擎层单测：用 openprint **自己装的那份 vitest**（等价于 `cd openprint && npm test`）。
#
# ## 为什么需要这个脚本（2026-09-28 补）
#
# 在它出现之前，`check-all.sh` 里**没有任何一道闸**跑 openprint 的引擎层 spec：
#
#   闸 3 `ts-test.sh`          → 只覆盖 `openprint/src/report/`（**3 个** spec 文件）
#   闸 7 `ts-test-designer.sh` → 显式 `--exclude '../openprint/src/**'`
#
# 而 `ts-test-designer.sh` 当时给的理由是「那批由 ts-test.sh 用纯 node 环境跑」——
# **那句话是错的**：`ts-test.sh` 只覆盖 `report/` 这一个子目录。
# 于是 openprint 的 **70 个 spec 里有 67 个（约 676 条用例）一条闸都不跑**，
# 而 `check-all.sh` 照样全绿。又一个「**闸是绿的、但没有跑器**」。
#
# 引擎层的闸本来就该长在引擎包里 —— 所以这里跑 openprint **自己的**配置
# （`openprint/vitest.config.ts`，`include: ['src/**/*.spec.ts']`），
# 而不是继续借 `designer-react` 的配置。
#
# ## 只读保证
#
# 这一批 spec **不写仓库**。唯一的写入口是 `designer-contract.spec.ts` 的 golden 录制，
# 而它现在**默认关闭**（golden 缺失直接失败），只有显式 `DESIGNER_CONTRACT_RECORD=1` 才写。
# 即「跑一次测试」不会改工作区。
#
# 用法：
#   bash scripts/ts-test-openprint.sh                 # 全部（70 文件 / 915 用例）
#                                                      # ⚠️ 本机耗时**带 WorkBuddy 会话 shim**：
#                                                      #   实测 145s（check-all 里顺跑）/ 240s（独立跑）
#                                                      #   真实值 **5s**（2026-09-29 实测 `NODE_OPTIONS=""`）
#                                                      #   —— **8 道闸里被 shim 影响最大的一道**（26×）
#                                                      # 耗时随负载浮动 → 别拿它当回归判据
#   bash scripts/ts-test-openprint.sh src/report      # 按路径过滤（参数透传给 vitest）
#
# 退出码：0 通过 / 2 **没跑成**（openprint 没装 node_modules）/ 其它 失败。
# 三态的理由见 `check-all.sh` 顶部：把「没检查」报成「失败」是假红。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENPRINT="$ROOT/openprint"

# node 路径**不写死**，解析顺序见 scripts/node-bin.sh
. "$ROOT/scripts/node-bin.sh"
NODE_BIN="$(require_node)"

if [[ ! -x "$OPENPRINT/node_modules/.bin/vitest" ]]; then
  echo "openprint 里没有 vitest：$OPENPRINT/node_modules/.bin/vitest" >&2
  echo "（缺了就是「没跑成」，不是「失败」。CI 上 npm ci 之后本仓自带那份就在。）" >&2
  exit 2
fi

cd "$OPENPRINT" || exit 2

# ⚠️ 必须在 openprint/ 目录下跑：契约录制器的 GOLDEN 按 `process.cwd()` 解析，
#    从别的目录跑会去写/读另一个位置（副本），并让断言退化成「自比自」。
# 位置参数是 vitest 的**路径过滤**，空着就是全部。
"$NODE_BIN" node_modules/.bin/vitest run "$@"
