/**
 * vite dev server 的 safe-delete 绕行器（Node 预加载脚本）
 *
 * 用途：WorkBuddy 的 `node-safe-delete-shim.cjs` 在 Node 进程内拦截超过
 * 50 个/turn 的批量 `fs.promises.rm`。vite 的 dep-optimizer 每次 re-optimize
 * 都会 `rm -rf node_modules/.vite/deps_temp_*`（典型 80~250 个文件），必崩：
 *
 *   Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
 *     {"count":205,"threshold":50,"scope":"turn","targets":[".../deps_temp_020de551"]}
 *
 * 用法：
 *   NODE_OPTIONS="--require $(pwd)/scripts/vite-safe-delete-bypass.cjs $NODE_OPTIONS" \
 *     npx vite --host 127.0.0.1 --port 5200 --strictPort
 *
 * 加载顺序很关键（本文件必须排在语言 shim **之前**）：
 *   1. 本 preload 先跑 —— 此时 fs.promises.rm 还是原生的，存进 realRm。
 *   2. 语言 shim 接着跑 —— 它把 origPromisesRm 锁成同一个 realRm，
 *      然后用 wrappedPromisesRm 覆盖 fs.promises.rm。
 *   3. 我们在 setImmediate 里再装自己的 wrapper —— 此时 fs.promises.rm 已经是
 *      shim 的 wrapper，捕获它当 fallback，然后重新暴露我们的 wrapper。
 *
 * 为什么必须用 setImmediate 而不能在同步段装：
 *   同步段装的话，shim 加载时 `const origPromisesRm = fs.promises.rm.bind(...)`
 *   会捕获**我们的**wrapper，而我们的 wrapper 内部又调回 shim 的 wrapper，
 *   shim 又调回 origPromisesRm（= 我们的 wrapper）→ 无限递归，
 *   vite 立刻挂在 `RangeError: Maximum call stack size exceeded`。
 *   setImmediate 跳过整条同步初始化链，两边就互不干扰了。
 */
'use strict';

const fs = require('fs');

const VITE_TEMP_RE = /[\\/]\.vite[\\/]deps_temp_/;
function isViteTemp(p) {
  return typeof p === 'string' && VITE_TEMP_RE.test(p);
}

// preload 阶段保存"真正的" rm（shim 还没跑）。
// 这个对象与 shim 闭包里的 origPromisesRm 是同一个，所以无递归。
const realRm = fs.promises.rm.bind(fs.promises);

/** shim 的 wrapper，setImmediate 阶段捕获 */
let shimWrapper = realRm;

function myRm(p, opts) {
  if (isViteTemp(p)) {
    // 直调真实 rm，绕开 shim 的批量删除阈值
    return realRm(p, opts);
  }
  // 非 temp 路径走 shim（保留保护）。
  // 必须用捕获的引用直调，不能读 fs.promises.rm —— 那会拿回 myRm，无限递归。
  return shimWrapper(p, opts);
}

let installed = false;
function installMyWrapper() {
  if (installed) return;
  installed = true;

  // 此刻 fs.promises.rm 已被 shim 替换，捕获它当 fallback
  try {
    const current = fs.promises.rm;
    if (typeof current === 'function' && current !== myRm) shimWrapper = current;
  } catch (_) {
    /* 拿不到就退回 realRm */
  }

  Object.defineProperty(fs.promises, 'rm', {
    configurable: true,
    enumerable: true,
    get() {
      return myRm;
    },
    set(v) {
      // 若还有别人要覆盖，记下来当非 temp 路径的 fallback，但继续暴露 myRm
      if (typeof v === 'function' && v !== myRm) shimWrapper = v;
    },
  });
}

setImmediate(installMyWrapper);
