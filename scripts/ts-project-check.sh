#!/bin/sh
# 前端「真闸」：整项目类型检查（`tsc -p`），会解析路径别名与跨文件类型。
#
# 与 `ts-check.sh` 的分工（**两个都要跑**，强弱不同）：
#   ts-check.sh   —— `--noResolve` 逐文件查**本文件自己**：跨文件错误结构上就看不见；快。
#   本脚本        —— `tsc -p tsconfig.json`：能查跨文件 / 别名 / JSX；慢（冷启几分钟，建议后台跑）。
#
# ⚠️ **必须用本仓自带的 tsc**（`<目标>/node_modules/typescript/bin/tsc`）。
#
# 原来一直借 `/Users/lushaohui/project/admin/demo/web/node_modules/typescript`，
# 但那份**已经漂到 6.0.3**，而 TS 6 把 `baseUrl` 判为 deprecated → 整条闸被一个
# **与代码无关的配置错误**堵死：
#     tsconfig.json(17,5): error TS5101: Option 'baseUrl' is deprecated ...   (真实退出码 2)
# 看着像「代码类型错了」，其实一行代码都没错 —— 很容易被误导去给 tsconfig 加
# `ignoreDeprecations`，那是拿配置去迁就借来的编译器。本项目 `package.json` 钉的是
# `typescript: ^5.9.3`，就用它。
# 自带那份不在时（换机器 / 没装依赖），退回借的那份并加 `--ignoreDeprecations 6.0`
# —— 只为绕开那条配置噪声，并在输出里**明说**正在用漂过的编译器。
#
# 用法：
#   scripts/ts-project-check.sh                # designer-react（默认）
#   scripts/ts-project-check.sh <目录>          # 该目录下要有「可被 -p 直接吃」的 tsconfig.json
#
# ⚠️ **本脚本只对 designer-react 有意义。**
# `openprint/tsconfig.json` 是**解决方案式**配置（`"files": []` + `references`）——
# `tsc -p` 对它**什么都不检查**却打印「OK」，是个**假绿**（本项目最讨厌的那类静默）。
# openprint 真正的闸是 `vue-tsc --build`（有 `.vue` 文件、extends `@vue/tsconfig`）。
# 所以下面**检测到 `"files": []` 就直接拒跑**，而不是给你一个假的 OK。
#
# 退出码：0 = 无类型错误；1 = 有；2 = 找不到编译器 / 配置不能被 -p 直接检查。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-/Users/lushaohui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node}"
TARGET_DIR="${1:-designer-react}"
DONOR=/Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc

LOCAL="$ROOT/$TARGET_DIR/node_modules/typescript/bin/tsc"

if [ ! -f "$ROOT/$TARGET_DIR/tsconfig.json" ]; then
  echo "找不到 $TARGET_DIR/tsconfig.json" >&2
  exit 2
fi

# 解决方案式配置：`tsc -p` 不检查任何文件却会打印 OK —— 拒跑，别给假绿。
if grep -Eq '"files"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$ROOT/$TARGET_DIR/tsconfig.json"; then
  echo "✗ $TARGET_DIR/tsconfig.json 是解决方案式配置（\"files\": [] + references）。" >&2
  echo "  \`tsc -p\` 对它**一个文件都不检查**却会报 OK（假绿），所以这里直接拒跑。" >&2
  echo "  它真正的闸在 package.json 的 type-check 脚本（本项目是 \`vue-tsc --build\`）。" >&2
  exit 2
fi

if [ -f "$LOCAL" ]; then
  TSC="$LOCAL"
  EXTRA=""
  echo "编译器：本仓自带 tsc $("$NODE" "$TSC" --version 2>/dev/null || echo '?')（$TARGET_DIR）"
elif [ -f "$DONOR" ]; then
  TSC="$DONOR"
  EXTRA="--ignoreDeprecations 6.0"
  echo "⚠️ 本仓没有自带 tsc，退回**借来的**那份：$("$NODE" "$TSC" --version 2>/dev/null)"
  echo "   它已漂到 TS 6，会给 tsconfig 的 baseUrl 报 TS5101（与代码无关）；已用 $EXTRA 绕开。"
  echo "   结论只在「代码本身没错」这一层可信 —— 想拿干净结果就装出 $TARGET_DIR/node_modules。"
else
  echo "找不到 tsc：$LOCAL 与 $DONOR 都不在" >&2
  exit 2
fi

cd "$ROOT/$TARGET_DIR"
# shellcheck disable=SC2086
"$NODE" "$TSC" -p tsconfig.json $EXTRA
echo "OK：$TARGET_DIR 无类型错误"
