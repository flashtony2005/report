/**
 * useHotkey —— 全局快捷键（React 侧）
 *
 * 安装在 CanvasStage（与 Vue 版一致：画布可见时才生效）。
 * 键位解析、输入框守卫等纯逻辑复用框架无关的 `design/hooks/hotkey-logic.ts`
 * （经 `@` alias 零复制引用 Vue 工程源码），与 Vue 端同一份，避免两端键位漂移。
 *
 * 覆盖：Delete / Backspace 删除选中控件、mod+Z 撤销、mod+Shift+Z（或 mod+Y）重做、
 * mod+D 复制选中控件、Escape 取消选中 —— 与「快捷键指南」弹窗宣传的键位一致。
 */
import { useEffect } from 'react'
import { runHotkey, type HotkeyAdapter } from '@/design/hooks/hotkey-logic'
import { useDesignerStore } from '../stores/designer'

export function useHotkey(): void {
  useEffect(() => {
    const adapter: HotkeyAdapter = {
      selectedIds: () => useDesignerStore.getState().selectedIds,
      undo: () => useDesignerStore.getState().undo(),
      redo: () => useDesignerStore.getState().redo(),
      remove: (id) => useDesignerStore.getState().removeControl(id),
      duplicate: (id) => useDesignerStore.getState().duplicateControl(id),
      deselect: () => useDesignerStore.getState().selectControl(null),
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      runHotkey(e, adapter)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
