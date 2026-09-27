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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# tsc 从哪来 —— **优先本仓自带的**，借别的项目那份只做兜底。
#
# 为什么「本仓优先」：
#   1. 借来的那份**已经漂到 TS 6**（`ts-project-check.sh` 顶部记过：TS 6 把 `baseUrl`
#      判为 deprecated，会用一条**与代码无关的**配置错误堵死整条闸）。本仓
#      `package.json` 钉的是 `typescript: ^5.9.3`，用它才是对的那份。
#   2. **CI（ubuntu）上那几个兄弟项目的路径根本不存在** → 旧写法会让整条闸直接
#      报「没跑成」。而 CI 上 `npm ci` 之后本仓一定有 `node_modules`。
#
# 顺序：`$TSC_BIN` → `designer-react` → `openprint` → 借来的（本机沙箱装不出依赖时的老办法）。
# 并且**把用的是哪一份打出来** —— 否则「到底哪个编译器跑的」是看不见的。
# （本文件是 `#!/bin/sh` + `set -e`，所以只用 POSIX 语法、不用 `local`，见 node-bin.sh 的说明。
#  判断一律写成 `if`，**不用 `[ … ] && …` 当独立语句** —— 后者在 `set -e` 下的行为要靠
#  「AND-OR 列表里非最后一条命令的失败被忽略」这条细则才成立，太容易看错。）
_rt_borrowed="/Users/lushaohui/project/admin/demo/web/node_modules/typescript/bin/tsc"

resolve_tsc() {
  _rt_hit=""
  if [ -n "${TSC_BIN:-}" ] && [ -f "${TSC_BIN}" ]; then
    _rt_hit="${TSC_BIN}"
  else
    for _rt_d in "$ROOT/designer-react" "$ROOT/openprint"; do
      if [ -f "$_rt_d/node_modules/typescript/bin/tsc" ]; then
        _rt_hit="$_rt_d/node_modules/typescript/bin/tsc"
        break
      fi
    done
  fi
  if [ -z "$_rt_hit" ] && [ -f "$_rt_borrowed" ]; then
    _rt_hit="$_rt_borrowed"
  fi
  if [ -z "$_rt_hit" ]; then
    return 1
  fi
  printf '%s' "$_rt_hit"
}

# node 路径**不写死**：版本后缀随环境重发而变（2026-09-23 变过一次，
# 三个闸同时失效，且本脚本会把「找不到 node」当成类型错误报出来 → 假红）。
. "$ROOT/scripts/node-bin.sh"
NODE="$(require_node)"

# `if !` 上下文会关掉 `set -e`，所以解析失败不会让脚本在赋值处就静默退出。
if ! TSC="$(resolve_tsc)"; then
  echo "找不到 tsc。试过：\$TSC_BIN、designer-react/node_modules、openprint/node_modules、借来的那份。" >&2
  echo "（本机沙箱装不出 node_modules；CI 上 npm ci 之后本仓自带那份就在。）" >&2
  exit 2
fi

TARGETS=${*:-"openprint/src/report designer-react/src/modals"}

# 用的是哪一份 tsc —— 打出来，别让它隐式（借来的那份已漂到 TS 6，结论不一样）。
# ⚠️ `${TSC}` 的花括号**不能省** —— `$VAR` 紧跟非 ASCII 字符时本机 bash 3.2 会**静默吃掉
# 变量的值 + 那个多字节字的第一个字节**（本文件下面那段说明就是记这个的，我第一版照样踩了：
# 打印成 `tsc：<乱码>Version 5.9.3）`，路径凭空不见而退出码一切正常）。
echo "tsc：${TSC}（$("$NODE" "$TSC" --version 2>/dev/null || echo '?')）"

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
# ⚠️ `${NE}）` 的花括号**不能省**。本机 bash 3.2.57（macOS 自带那份）在
# 「`$VAR` 紧跟一个非 ASCII 字符」时会**静默吃掉变量的值 + 多字节字的第一个字节** ——
# 这句原本打印成「测试 ）」，那个 `18` 凭空不见了，而退出码一切正常。
# 实测：`echo "[$V）]"` → `[\xbc\x89]`；`echo "[${V}）]"` → `[abc）]` 正确。
# `$(...)` 命令替换**不受影响**（只有简单变量会中招）。别顺手把花括号删掉。
echo "检查 $((NS + NE)) 个文件（源码 $NS / 测试 ${NE}）：$TARGETS"

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
