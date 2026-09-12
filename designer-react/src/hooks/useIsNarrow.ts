/**
 * useIsNarrow / useIsMobile —— 窄屏与移动端模式侦测
 *
 * P6.2 移动端适配：≤900px 时左右面板抽屉化（App.tsx）。
 * 修复（用户报障「鼠标移动到编辑会出现预览、不能操作」）：
 * 窄视口 + **鼠标** 的场景（小窗口 / 内嵌预览面板 / 高缩放）曾误入移动端模式，
 * 点选控件就弹属性抽屉 + 遮罩盖住画布，编辑被拦截。
 * 现在「移动端模式」必须同时满足：
 *   1) 视口 ≤ 900px（NARROW_QUERY）
 *   2) 主输入设备为触屏（pointer: coarse，与引擎长按/单指平移的判定同源）
 * 窄窗口 + 鼠标 → 保持桌面布局（与 Vue 版任意宽度下三栏常驻一致）。
 *
 * matchMedia 监听 change 事件；SSR/测试环境无 matchMedia 时安全返回 false。
 */
import { useEffect, useState } from 'react'

export const NARROW_QUERY = '(max-width: 900px)'
/** 主输入为触屏（与 CanvasDesigner 的 coarsePointer 判定一致） */
export const COARSE_QUERY = '(pointer: coarse)'

function useMediaMatches(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches)
    // 现代浏览器 addEventListener；旧实现降级 addListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [query])

  return matches
}

/** 窄视口（仅宽度判断；桌面小窗口也为 true） */
export function useIsNarrow(query: string = NARROW_QUERY): boolean {
  return useMediaMatches(query)
}

/**
 * 移动端模式：窄视口 **且** 主输入为触屏。
 * 鼠标用户的窄窗口不走抽屉化布局 —— 画布始终可直接点选/拖拽编辑。
 */
export function useIsMobile(): boolean {
  const narrow = useMediaMatches(NARROW_QUERY)
  const coarse = useMediaMatches(COARSE_QUERY)
  return narrow && coarse
}
