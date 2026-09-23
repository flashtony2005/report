#!/usr/bin/env bash
#
# 前端单测：借别的仓库里现成的 vitest 来跑。
#
# 为什么不能直接 `npx vitest`：本仓库装不出 node_modules（见 ts-check.sh 同样的困境），
# 所以这里从别的项目**借用**一份 vitest + vite。纯只读借用，不往人家目录里写东西。
#
# 这套「借依赖」的办法已抽成通用 skill（sandbox-ts-verify），含自动找 DONOR 的版本；
# 本脚本是钉死路径、贴合本仓库的那份。
#
# 为什么要把源码**拷到临时目录**再跑（这一步看着莫名其妙，但少一行就报错）：
# vite 会从被测文件所在目录逐级向上找 tsconfig.json，找到 openprint/tsconfig.json 后
# 顺着它的 project references 去解析 openprint/tsconfig.node.json，而后者
# `extends: "@tsconfig/node24/tsconfig.json"` —— 这个包没装，于是
# `TSConfckParseError: failed to resolve "extends"` 直接失败。
# 拷到没有 tsconfig 的临时目录就绕开了整条链路。
#
# 用法：
#   bash scripts/ts-test.sh                 # 跑全部前端单测
#   bash scripts/ts-test.sh -t '合并'        # 按用例名过滤（参数透传给 vitest）
#
# ⚠️ 拷的是 `openprint/src/report/*.ts` **整个目录**，`include` 也是通配。
# 早先这两处都写死成 `grid-report.ts` / `grid-report.spec.ts`，
# 于是新增的 spec 文件**根本不会被跑到**，而脚本退出码仍然是 0 ——
# 又一种「看着绿、其实没跑」的假绿。新增 spec 不需要再改本脚本。
# （该目录下的 .ts 都是自包含的：`grid-report.ts` 连一个 import 都没有。）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# node 路径**不写死**，解析顺序见 scripts/node-bin.sh（版本后缀会随环境重发而变）
. "$ROOT/scripts/node-bin.sh"
NODE_BIN="$(require_node)"

# 借用的 node_modules：挑第一个真的装着 vitest 的
BORROWED="${BORROWED_MODULES:-}"
if [[ -z "$BORROWED" ]]; then
  for cand in \
    /Users/lushaohui/project/ontology/web/node_modules \
    /Users/lushaohui/project/ontology2/ui/node_modules
  do
    if [[ -x "$cand/vitest/vitest.mjs" ]]; then BORROWED="$cand"; break; fi
  done
fi

if [[ -z "$BORROWED" || ! -x "$BORROWED/vitest/vitest.mjs" ]]; then
  echo "找不到可借用的 vitest。设 BORROWED_MODULES=<含 vitest 的 node_modules 绝对路径> 后重试。" >&2
  echo "（本仓库装不出 node_modules，只能借。）" >&2
  exit 2
fi

# 被测文件：openprint 的纯函数层（无 DOM / 无 Univer 依赖）
SRC_DIR="$ROOT/openprint/src/report"
if [[ ! -d "$SRC_DIR" ]]; then
  echo "缺少源目录：$SRC_DIR" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 整个目录一起拷（含 spec），不做白名单 —— 白名单就是上次漏跑新 spec 的原因
copied=0
for f in "$SRC_DIR"/*.ts; do
  [[ -e "$f" ]] || continue
  cp "$f" "$WORK/"
  copied=$((copied + 1))
done
if [[ "$copied" -eq 0 ]]; then
  echo "源目录里一个 .ts 都没有：$SRC_DIR" >&2
  exit 2
fi

# 存盘报表样本：`真实存盘报表的每一格经 = 方言往返` 那条用例要读真实文件。
# 拷到 $WORK/reports/ 下 —— spec 的 findSavedReport() 会去 spec 同级的 reports/ 找，
# 因为临时目录不在仓库里，靠 `import.meta.dirname` 上溯是找不到的。
mkdir -p "$WORK/reports"
cp "$ROOT/print-server/reports/sales-by-region.json" "$WORK/reports/"

# 临时目录里没有 tsconfig，故这里只给最朴素的配置
cat > "$WORK/vitest.config.mjs" <<'EOF'
export default {
  test: {
    include: ['*.spec.ts'],
    environment: 'node',
    reporters: ['default'],
  },
}
EOF

# 让 `import ... from 'vitest'` 解析得到
ln -sfn "$BORROWED" "$WORK/node_modules"

cd "$WORK"
"$NODE_BIN" "$BORROWED/vitest/vitest.mjs" run "$@"
