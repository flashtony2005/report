/**
 * history store —— undo/redo 命令栈（React 版 / Zustand）
 *
 * 从 Vue 版 `src/design/stores/history.ts` 1:1 迁移，行为必须完全一致：
 * - 命令模式，每次编辑记录 undo/redo 逆操作
 * - 历史栈纯内存，不持久化
 * - 栈上限 200 步
 * - beginBatch/endBatch 合并连续操作（拖拽自动归并）
 */
import { create } from 'zustand'

export interface HistoryCommand {
  /** 逆操作（撤销：回到操作前的状态） */
  undo: () => void
  /** 重做：回到操作后的状态 */
  redo: () => void
  /** 描述（调试/未来状态栏显示用） */
  description: string
}

interface HistoryState {
  undoStack: HistoryCommand[]
  redoStack: HistoryCommand[]
  _enabled: boolean
  /** 当前批次内合并模式（同一控件连续位置变更不撑爆栈） */
  batch: HistoryCommand[] | null

  push: (cmd: HistoryCommand) => void
  beginBatch: () => void
  endBatch: (description?: string) => void
  undo: () => void
  redo: () => void
  clear: () => void
}

const initial = {
  undoStack: [] as HistoryCommand[],
  redoStack: [] as HistoryCommand[],
  _enabled: true,
  batch: null as HistoryCommand[] | null,
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  ...initial,

  push: (cmd) => {
    const { _enabled, batch, undoStack } = get()
    if (!_enabled) return
    if (batch) {
      batch.push(cmd)
      return
    }
    const next = [...undoStack, cmd]
    // 防止无限增长（保留最近 200 步）
    if (next.length > 200) next.shift()
    set({ undoStack: next, redoStack: [] })
  },

  beginBatch: () => set({ batch: [] }),

  endBatch: (description = '批量编辑') => {
    const { batch, undoStack } = get()
    if (!batch || batch.length === 0) {
      set({ batch: null })
      return
    }
    const cmds = batch
    set({
      undoStack: [
        ...undoStack,
        {
          undo: () => cmds.slice().reverse().forEach((c) => c.undo()),
          redo: () => cmds.forEach((c) => c.redo()),
          description,
        },
      ],
      redoStack: [],
      batch: null,
    })
  },

  undo: () => {
    const { undoStack, redoStack } = get()
    if (undoStack.length === 0) return
    const cmd = undoStack[undoStack.length - 1]!
    set({ _enabled: false })
    try {
      cmd.undo()
      set({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, cmd],
      })
    } finally {
      set({ _enabled: true })
    }
  },

  redo: () => {
    const { undoStack, redoStack } = get()
    if (redoStack.length === 0) return
    const cmd = redoStack[redoStack.length - 1]!
    set({ _enabled: false })
    try {
      cmd.redo()
      set({
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, cmd],
      })
    } finally {
      set({ _enabled: true })
    }
  },

  clear: () => set({ undoStack: [], redoStack: [], batch: null }),
}))

/** 契约测试用：把 history store 复位到初始态 */
export function resetHistoryStore(): void {
  useHistoryStore.setState({ ...initial })
}
