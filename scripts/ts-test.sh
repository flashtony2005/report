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

# 借用的 node_modules：**只扫本仓**。仓库外的绝对路径一律不自动用。
#
# ⚠️ 2026-09-28：这里原本还有两条 `/Users/lushaohui/project/ontology*/...` 硬编码候选。
# 删掉它们的理由 —— 它们是**宿主相关**的依赖：本机存在，别人机器（含 CI）不存在。
# 实测本仓两条候选（designer-react / openprint）都装着 `vitest/vitest.mjs`，
# 所以那两条从来只是「本机恰好也能用」的冗余；而它们留在候选里，
# 会让脚本**静默挑一个别人机器上根本不存在的目录** ——
# 正是「本机绿、CI 红」那类问题的温床（同类问题本仓已踩两次）。
# 真需要借用外部依赖时，**显式**给 `BORROWED_MODULES`，别让它自己猜。
BORROWED="${BORROWED_MODULES:-}"
if [[ -z "$BORROWED" ]]; then
  for cand in \
    "$ROOT/designer-react/node_modules" \
    "$ROOT/openprint/node_modules"
  do
    if [[ -x "$cand/vitest/vitest.mjs" ]]; then BORROWED="$cand"; break; fi
  done
fi

if [[ -z "$BORROWED" || ! -x "$BORROWED/vitest/vitest.mjs" ]]; then
  cat >&2 <<'MSG'
找不到可用的 vitest。本脚本**只扫本仓**这两处：
  designer-react/node_modules · openprint/node_modules
都没有 → 说明依赖没装（CI 上 `npm ci` 之后本仓自带那份就在）。

**本机沙箱装不出 node_modules 时**，显式指一份现成的 —— 脚本不会自己去猜外部路径：
  BORROWED_MODULES=/绝对路径/node_modules bash scripts/ts-test.sh
MSG
  exit 2
fi

# ⚠️ 花括号不能省（`$VAR` 紧跟非 ASCII 字符时本机 bash 3.2 会静默吃掉变量值）。
echo "vitest：${BORROWED}"

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
#
# ⚠️ 这个文件**必须入版本控制**（`.gitignore` 里对它单独开了例外）。
# 2026-09-28 CI 首次跑红正是这个：`print-server/reports/` 整个目录被忽略，
# 干净检出里没有它 → 这里的 `cp` **静默失败** → 那条用例抛「找不到存盘报表样本」，
# 而报错只列「找过这些路径」，**看不出根因是文件压根没被提交**。
# 所以显式判存在并**大声失败**：退出码 2 = 没跑成（检出不全），不是「失败」。
SAMPLE="$ROOT/print-server/reports/sales-by-region.json"
if [[ ! -f "$SAMPLE" ]]; then
  echo "缺少存盘报表样本：$SAMPLE" >&2
  echo "（它是**入库**文件。没有它说明检出不全，或 .gitignore 里那条例外被改掉了。）" >&2
  exit 2
fi
mkdir -p "$WORK/reports"
cp "$SAMPLE" "$WORK/reports/"

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
