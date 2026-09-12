/**
 * vitest 全局 setup（每个测试文件最先执行）
 *
 * 目的：杜绝「环境拆除后仍有异步任务触碰 window」导致的假失败。
 *
 * 背景：happy-dom 在每个测试文件结束后销毁 window，但 React/antd 的一些异步尾巴
 *（下拉菜单/抽屉的动效、防抖输入框、轮询）仍排在定时器队列里。它们被调度执行时
 * 全局 window 已消失，于是抛 `ReferenceError: window is not defined` —— 测试本身全部
 * 通过，但 vitest 把它记成 Unhandled Error 并让进程以非 0 退出（CI 判红）。
 *
 * 做法：记录测试期间登记的所有 timer / rAF，在每个用例的 afterEach 统一取消，
 * 保证「用例结束 → 不再有属于它的待执行任务」。只清理已结束用例的残留，
 * 不影响用例内部正常的 await / waitFor。
 */
import { afterEach } from 'vitest'

type TimerHandle = ReturnType<typeof setTimeout>

const pendingTimers = new Set<TimerHandle>()
const pendingIntervals = new Set<TimerHandle>()
const pendingFrames = new Set<number>()

const nativeSetTimeout = globalThis.setTimeout
const nativeSetInterval = globalThis.setInterval
const nativeClearTimeout = globalThis.clearTimeout
const nativeClearInterval = globalThis.clearInterval
const nativeRaf = globalThis.requestAnimationFrame
const nativeCaf = globalThis.cancelAnimationFrame

function track(fn: TimerHandle, bag: Set<TimerHandle>): TimerHandle {
  bag.add(fn)
  return fn
}

globalThis.setTimeout = (((fn: TimerArgs, ms?: number, ...rest: unknown[]) => {
  const id = nativeSetTimeout(
    ((...args: unknown[]) => {
      pendingTimers.delete(id as unknown as TimerHandle)
      ;(fn as (...a: unknown[]) => void)(...args)
    }) as TimerArgs,
    ms,
    ...rest,
  )
  return track(id as unknown as TimerHandle, pendingTimers)
}) as unknown) as typeof globalThis.setTimeout

globalThis.setInterval = (((fn: TimerArgs, ms?: number, ...rest: unknown[]) => {
  const id = nativeSetInterval(fn, ms, ...rest)
  return track(id as unknown as TimerHandle, pendingIntervals)
}) as unknown) as typeof globalThis.setInterval

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  const id = nativeRaf((t: number) => {
    pendingFrames.delete(id)
    cb(t)
  })
  pendingFrames.add(id)
  return id
}) as typeof globalThis.requestAnimationFrame

type TimerArgs = ((...a: unknown[]) => void) | string

afterEach(() => {
  for (const id of pendingTimers) nativeClearTimeout(id)
  for (const id of pendingIntervals) nativeClearInterval(id)
  for (const id of pendingFrames) nativeCaf(id)
  pendingTimers.clear()
  pendingIntervals.clear()
  pendingFrames.clear()
})
