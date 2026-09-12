/**
 * useHotkey —— 全局快捷键（删除 / 复制 / 撤销 / 重做 / 取消选中）
 * 安装在 CanvasStage，仅在画布可见时生效。
 *
 * 键位解析、输入框守卫等纯逻辑在框架无关的 `hotkey-logic.ts`，
 * React 端（designer-react/src/hooks/useHotkey.ts）共用同一份，避免两端键位漂移。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { runHotkey, type HotkeyAdapter } from '@/design/hooks/hotkey-logic'

export function useHotkey(): void {
  const store = useDesignerStore()

  const adapter: HotkeyAdapter = {
    selectedIds: () => store.selectedIds,
    undo: () => store.undo(),
    redo: () => store.redo(),
    remove: (id) => store.removeControl(id),
    deselect: () => store.selectControl(null),
    /** 复制：换新 id + 右下偏移 10mm、同宿主、记历史（实现见 store.duplicateControl） */
    duplicate: (id) => store.duplicateControl(id),
  }

  function onKeyDown(e: KeyboardEvent): void {
    runHotkey(e, adapter)
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
