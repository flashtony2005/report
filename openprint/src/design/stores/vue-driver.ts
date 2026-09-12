/**
 * 契约的 Vue 端实现（Pinia）
 *
 * 把 `designer` / `history` 两个 store 包装成框架无关的 DesignerDriver，
 * 供 `runDesignerContract()` 驱动，产出与 React 端可比的 golden 结果。
 *
 * 注意：本 driver **不挂载画布**（不调用 attachCanvas），
 * designer store 内所有画布调用都是 `designer.value?.` 可选链，
 * 因此纯模型操作可在 happy-dom 环境下无副作用地跑通。
 */
import { createPinia, setActivePinia } from 'pinia'
import { useDesignerStore } from '@/design/stores/designer'
import type {
  ContractTemplate,
  DesignerDriver,
  DesignerSnapshot,
} from '@/contracts/designer-contract'

type DesignerStore = ReturnType<typeof useDesignerStore>

export function createVueDriver(): DesignerDriver {
  let store: DesignerStore | null = null

  const s = (): DesignerStore => {
    if (!store) throw new Error('[vue-driver] 请先调用 reset()')
    return store
  }

  return {
    name: 'vue-pinia',

    reset(): void {
      setActivePinia(createPinia())
      store = useDesignerStore()
    },

    getSnapshot(): DesignerSnapshot {
      const st = s()
      return {
        templateName: st.templateName,
        controls: st.controls.map((c) => ({
          id: c.id,
          type: c.type,
          left: c.left ?? 0,
          top: c.top ?? 0,
          width: c.width ?? 0,
          height: c.height ?? 0,
        })),
        zones: st.zones.map((z) => ({
          id: z.id,
          type: z.type,
          zone: z.zone,
          childCount: z.children?.length ?? 0,
        })),
        selectedIds: [...st.selectedIds],
        dirty: st.dirty,
        minPages: st.minPages,
        canUndo: st.canUndo,
        canRedo: st.canRedo,
      }
    },

    addControlOfType(type, at, init, zoneHostId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s().addControlOfType(type as never, at, init as never, zoneHostId)
    },

    updateControl(id, patch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s().updateControl(id, patch as never)
    },

    removeControl(id) {
      s().removeControl(id)
    },

    moveControl(id, dir) {
      s().moveControl(id, dir)
    },

    selectControl(id) {
      s().selectControl(id)
    },

    addZone(zone) {
      s().addZone(zone)
    },

    addControlIntoLabelGrid(gridId, type, atAbsolute, init) {
      s().addControlIntoLabelGrid(gridId, type as never, atAbsolute, init as never)
    },

    removeLabelGridChild(gridId, childId) {
      s().removeLabelGridChild(gridId, childId)
    },

    setMinPages(n) {
      s().setMinPages(n)
    },

    newBlankTemplate() {
      s().newBlankTemplate()
    },

    undo() {
      s().undo()
    },

    redo() {
      s().redo()
    },

    buildTemplate(): ContractTemplate {
      return s().buildTemplate() as unknown as ContractTemplate
    },
  }
}
