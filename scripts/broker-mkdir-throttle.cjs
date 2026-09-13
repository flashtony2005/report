/**
 * npm install 并发 mkdir 节流器（Node 预加载脚本）
 *
 * 用途：WorkBuddy 沙箱的 fs broker 对**并发** mkdir 有限流（实测阈值 ~120），
 * npm 的 reify 阶段用 Promise.allSettled 一次发几百个 mkdir，必然触发
 * `CODEBUDDY_BROKER_DENY: Brokered host mkdir requires an available runtime
 * file rule`。顺序 mkdir 400 个全部成功，所以**不是数量配额**。
 *
 * 用法：
 *   NODE_OPTIONS="--require $(pwd)/scripts/broker-mkdir-throttle.cjs $NODE_OPTIONS" npm install
 *
 * 实测：designer-react 597 包 33s、openprint 567 包 5s，零错误。
 */
'use strict';

const fs = require('fs');

/** 远低于实测上限 120，留足余量给其它并发调用 */
const LIMIT = 24;

let inflight = 0;
const waiters = [];

function acquire() {
  if (inflight < LIMIT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((res) => waiters.push(res));
}

function release() {
  inflight--;
  const next = waiters.shift();
  if (next) {
    inflight++;
    next();
  }
}

function throttle(obj, names) {
  for (const name of names) {
    const orig = obj[name];
    if (typeof orig !== 'function') continue;
    obj[name] = function (...args) {
      return acquire().then(
        () => orig.apply(obj, args).finally(release),
        (e) => {
          release();
          throw e;
        },
      );
    };
  }
}

// 这些是 npm reify 阶段会并发调用、且会撞上 broker 限流的
throttle(fs.promises, ['mkdir', 'rm', 'rename', 'rmdir', 'copyFile']);
