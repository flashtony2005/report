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
# 解决方案式配置：`openprint/tsconfig.json` 就是（`"files": []` + `references`）。
# `tsc -p` 对它**什么都不检查**却打印「OK」，是个**假绿**（本项目最讨厌的那类静默）。
# 所以这类项目**不走 `tsc -p`**，改走它自己的 type-check 工具 —— 本项目是
# `vue-tsc --build`（有 `.vue` 文件、extends `@vue/tsconfig`）。
#
# ⚠️ **别嫌麻烦就不用它**。2026-09-23 之前 openprint 的 `vue-tsc --build` 一直红着
# （108 条错，全在 `grid-report.spec.ts`），因为「反正一直是红的」，新错误混在里面
# 根本看不出来 —— **一条长期红着的闸 = 没有闸**。现已清零，它必须能被一键跑起来，
# 否则下次红了又没人管。
#
# 退出码：0 = 无类型错误；1 = 有；2 = 找不到编译器 / 配置不能被 -p 直接检查。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# node 路径**不写死**，解析顺序见 scripts/node-bin.sh（版本后缀会随环境重发而变）
. "$ROOT/scripts/node-bin.sh"
NODE="$(require_node)"
TARGET_DIR="${1:-designer-react}"
DONOR=/Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc

LOCAL="$ROOT/$TARGET_DIR/node_modules/typescript/bin/tsc"

if [ ! -f "$ROOT/$TARGET_DIR/tsconfig.json" ]; then
  echo "找不到 $TARGET_DIR/tsconfig.json" >&2
  exit 2
fi

# 解决方案式配置：改走 `vue-tsc --build`，别给 `tsc -p` 的假绿。
IS_SOLUTION=0
if grep -Eq '"files"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$ROOT/$TARGET_DIR/tsconfig.json"; then
  IS_SOLUTION=1
fi

if [ "$IS_SOLUTION" = "1" ]; then
  VUETSC="$ROOT/$TARGET_DIR/node_modules/.bin/vue-tsc"
  if [ ! -f "$VUETSC" ]; then
    echo "✗ $TARGET_DIR 是解决方案式配置，需要 \`vue-tsc\`，但 $VUETSC 不在" >&2
    echo "  先装依赖（openprint 目录下 npm i），别改用 \`tsc -p\` —— 那是个假绿。" >&2
    exit 2
  fi
  echo "解决方案式配置 → 用 \`vue-tsc --build\`（\`tsc -p\` 对它什么都不检查）"
  cd "$ROOT/$TARGET_DIR"
  # vite 工具链在沙箱里一律要挂这两个 preload，否则会卡死在 RUN / SIGKILL(137)。
  NODE_OPTIONS="--require $ROOT/scripts/vite-safe-delete-bypass.cjs --require $ROOT/scripts/broker-mkdir-throttle.cjs" \
    "$NODE" "$VUETSC" --build --force
  echo "OK：$TARGET_DIR（vue-tsc --build）无类型错误"
  exit 0
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
