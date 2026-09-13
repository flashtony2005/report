#!/usr/bin/env bash
#
# 前端单测：借别的仓库里现成的 vitest 来跑。
#
# 为什么不能直接 `npx vitest`：本仓库装不出 node_modules（见 ts-check.sh 同样的困境），
# 所以这里从别的项目**借用**一份 vitest + vite。纯只读借用，不往人家目录里写东西。
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
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NODE_BIN="${NODE_BIN:-/Users/lushaohui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node}"

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
FILES=(grid-report.ts grid-report.spec.ts)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for f in "${FILES[@]}"; do
  if [[ ! -f "$SRC_DIR/$f" ]]; then
    echo "缺少源文件：$SRC_DIR/$f" >&2
    exit 2
  fi
  cp "$SRC_DIR/$f" "$WORK/"
done

# 临时目录里没有 tsconfig，故这里只给最朴素的配置
cat > "$WORK/vitest.config.mjs" <<'EOF'
export default {
  test: {
    include: ['grid-report.spec.ts'],
    environment: 'node',
    reporters: ['default'],
  },
}
EOF

# 让 `import ... from 'vitest'` 解析得到
ln -sfn "$BORROWED" "$WORK/node_modules"

cd "$WORK"
"$NODE_BIN" "$BORROWED/vitest/vitest.mjs" run "$@"
