/**
 * 契约的 React 端实现（Zustand）
 *
 * 与 `openprint/src/design/stores/vue-driver.ts` 实现同一个 DesignerDriver 接口，
 * 跑同一份 `runDesignerContract()`，产出与 Vue 端 golden fixture 比对。
 */
import { useDesignerStore, resetDesignerStores } from './designer'
import { useHistoryStore } from './history'
import type {
  ContractTemplate,
  DesignerDriver,
  DesignerSnapshot,
} from '@contracts/designer-contract'

export function createReactDriver(): DesignerDriver {
  const st = () => useDesignerStore.getState()

  return {
    name: 'react-zustand',

    reset(): void {
      resetDesignerStores()
    },

    getSnapshot(): DesignerSnapshot {
      const s = st()
      const h = useHistoryStore.getState()
      return {
        templateName: s.templateName,
        controls: s.controls.map((c) => ({
          id: c.id,
          type: c.type,
          left: c.left ?? 0,
          top: c.top ?? 0,
          width: c.width ?? 0,
          height: c.height ?? 0,
        })),
        zones: s.zones.map((z) => ({
          id: z.id,
          type: z.type,
          zone: z.zone,
          childCount: z.children?.length ?? 0,
        })),
        selectedIds: [...s.selectedIds],
        dirty: s.dirty,
        minPages: s.minPages,
        canUndo: h.undoStack.length > 0,
        canRedo: h.redoStack.length > 0,
      }
    },

    addControlOfType(type, at, init, zoneHostId) {
      st().addControlOfType(type as never, at, init as never, zoneHostId)
    },

    updateControl(id, patch) {
      st().updateControl(id, patch as never)
    },

    removeControl(id) {
      st().removeControl(id)
    },

    moveControl(id, dir) {
      st().moveControl(id, dir)
    },

    selectControl(id) {
      st().selectControl(id)
    },

    addZone(zone) {
      st().addZone(zone)
    },

    addControlIntoLabelGrid(gridId, type, atAbsolute, init) {
      st().addControlIntoLabelGrid(gridId, type as never, atAbsolute, init as never)
    },

    removeLabelGridChild(gridId, childId) {
      st().removeLabelGridChild(gridId, childId)
    },

    setMinPages(n) {
      st().setMinPages(n)
    },

    newBlankTemplate() {
      st().newBlankTemplate()
    },

    undo() {
      st().undo()
    },

    redo() {
      st().redo()
    },

    buildTemplate(): ContractTemplate {
      return st().buildTemplate() as unknown as ContractTemplate
    },
  }
}
