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
# 噪声说明（已被下面的 grep 过滤）：
#   TS2307 / TS2882         —— 找不到模块（--noResolve 的必然结果）
#   TS7006 / TS7016 / TS7031 —— 隐式 any，来自解析不到类型的第三方库（fabric / antd / vitest）
#   TS2339 Property 'x' does not exist on 'PrintZone' 之类 —— 基类解析不到
#   TS18046 / TS2571        —— spec 文件里 vitest 的期望值退化成 unknown
#   ImportMeta.env          —— 需要 vite/client 类型
# 第一次跑就靠它抓到了 DetailTemplateOptions 缺 page 字段的真 bug，别当摆设。
set -e

TSC=/Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc
NODE=/Users/lushaohui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node

if [ ! -f "$TSC" ]; then
  echo "找不到 tsc：$TSC" >&2
  echo "换一份 typescript 的路径，或在能装依赖的机器上跑 npm run type-check" >&2
  exit 2
fi

TARGETS=${*:-"openprint/src/report designer-react/src/modals"}

FILES=$(find $TARGETS -name '*.ts' -o -name '*.tsx' 2>/dev/null | grep -v '\.spec\.\|__tests__' | sort)

if [ -z "$FILES" ]; then
  echo "没有匹配到文件：$TARGETS" >&2
  exit 2
fi

echo "检查 $(echo "$FILES" | wc -l | tr -d ' ') 个文件：$TARGETS"

# shellcheck disable=SC2086
$NODE "$TSC" \
  --noEmit --skipLibCheck --strict --jsx preserve \
  --target es2022 --lib es2022,dom,dom.iterable \
  --module esnext --moduleResolution bundler --noResolve \
  $FILES 2>&1 | grep -vE \
  "TS2307|TS2882|TS7006|TS7016|TS7031|TS7053|TS18046|TS2571|ImportMeta|Cannot find name|Cannot find namespace|JSX\.IntrinsicElements|Cannot find global type|Cannot find lib definition" \
  || true
