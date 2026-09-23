#!/bin/sh
# 前端类型检查（不依赖项目内的 node_modules）
#
# 背景：本环境里 npm 装不进项目目录（sandbox 拦 mkdir），所以项目长期没有 node_modules，
# 前端改动一直没法类型检查。但 tsc 可以借别的项目里的那份来跑，配合 --noResolve
# （不解析 import，因此不需要真实依赖）就能查出**本文件自己**的类型错误。
#
# 用法：
#   scripts/ts-check.sh                       # 检查 report 引擎 TS + 设计器
#   scripts/ts-check.sh openprint/src/report  # 只查某个目录
#
# 任何残留错误都会让脚本退出 1，可以直接挂 CI。
#
# 噪声说明（已被下面的 NOISE 过滤）：
#   TS2307 / TS2882         —— 找不到模块（--noResolve 的必然结果）
#   TS7006 / TS7016 / TS7031 —— 隐式 any，来自解析不到类型的第三方库（fabric / antd / vitest）
#   TS2339 Property 'x' does not exist on 'PrintZone' 之类 —— 基类解析不到
#   TS18046 / TS2571        —— spec 文件里 vitest 的期望值退化成 unknown
#   ImportMeta.env          —— 需要 vite/client 类型
# 第一次跑就靠它抓到了 DetailTemplateOptions 缺 page 字段的真 bug，别当摆设。
set -e

TSC=/Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc
# node 路径**不写死**：版本后缀随环境重发而变（2026-09-23 变过一次，
# 三个闸同时失效，且本脚本会把「找不到 node」当成类型错误报出来 → 假红）。
. "$(dirname "$0")/node-bin.sh"
NODE="$(require_node)"

if [ ! -f "$TSC" ]; then
  echo "找不到 tsc：$TSC" >&2
  echo "换一份 typescript 的路径，或在能装依赖的机器上跑 npm run type-check" >&2
  exit 2
fi

TARGETS=${*:-"openprint/src/report designer-react/src/modals"}

ALL=$(find $TARGETS -name '*.ts' -o -name '*.tsx' 2>/dev/null | sort)

if [ -z "$ALL" ]; then
  echo "没有匹配到文件：$TARGETS" >&2
  exit 2
fi

# 注意：macOS 的 BSD grep 在 BRE 下不支持 \| 做「或」，会把它当字面量，
# 导致过滤静默失效（第一版就栽在这，spec 文件其实一直没被排除）。用多个 -e。
SRC=$(printf '%s\n' "$ALL" | grep -v -e '\.spec\.' -e '__tests__' || true)
SPEC=$(printf '%s\n' "$ALL" | grep -e '\.spec\.' -e '__tests__' || true)

# --noResolve 的必然噪声 + 解析不到类型的第三方库
NOISE="TS2307|TS2882|TS7006|TS7016|TS7031|TS7053|TS18046|TS2571"
NOISE="$NOISE|ImportMeta|Cannot find name|Cannot find namespace"
NOISE="$NOISE|JSX\.IntrinsicElements|Cannot find global type|Cannot find lib definition"
# spec 文件额外一条：vitest 没解析，importOriginal<T>() 被当成无类型函数调用（TS2347）
NOISE_SPEC="$NOISE|TS2347"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

TSCFLAGS="--noEmit --skipLibCheck --strict --jsx preserve"
TSCFLAGS="$TSCFLAGS --target es2022 --lib es2022,dom,dom.iterable"
TSCFLAGS="$TSCFLAGS --module esnext --moduleResolution bundler --noResolve"
# --noUnusedLocals：借来的 tsc 只做「本文件」检查，不解析 import，
# 于是「import 了却没用」这类错误会被漏掉（加合并功能时就漏掉了两个没用的 import）。
# 全部目标文件跑下来是干净的，所以直接开成硬错误。
TSCFLAGS="$TSCFLAGS --noUnusedLocals"

NS=$(printf '%s\n' "$SRC" | grep -c . || true)
NE=$(printf '%s\n' "$SPEC" | grep -c . || true)
echo "检查 $((NS + NE)) 个文件（源码 $NS / 测试 $NE）：$TARGETS"

set +e
# shellcheck disable=SC2086
if [ "$NS" -gt 0 ]; then
  $NODE "$TSC" $TSCFLAGS $SRC 2>&1 | grep -vE "$NOISE" > "$TMP/src.err"
fi
if [ "$NE" -gt 0 ]; then
  $NODE "$TSC" $TSCFLAGS $SPEC 2>&1 | grep -vE "$NOISE_SPEC" > "$TMP/spec.err"
fi
set -e

TOTAL=0
for f in src spec; do
  [ -f "$TMP/$f.err" ] || continue
  [ -s "$TMP/$f.err" ] || continue
  echo "--- $f ---"
  cat "$TMP/$f.err"
  TOTAL=$((TOTAL + $(wc -l < "$TMP/$f.err" | tr -d ' ')))
done

if [ "$TOTAL" -gt 0 ]; then
  echo "类型错误 $TOTAL 处"
  exit 1
fi
echo "OK：无类型错误"
