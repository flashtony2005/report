/**
 * history store —— undo/redo 命令栈（《实施指南》Phase 4）
 *
 * 命令模式：每次编辑操作（add/remove/update）记录 undo/redo 逆操作；
 * 撤销 = 回到上一个历史状态；重做 = 前进一步。
 *
 * 铁律（主任 2026-08-08）：
 * - 历史栈纯内存，不持久化（持久化只有手动"保存模板"一个入口）
 * - loadTemplate / restoreLastTemplate 时清空历史栈（全新工作会话）
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface HistoryCommand {
  /** 逆操作（撤销：回到操作前的状态） */
  undo: () => void
  /** 重做：回到操作后的状态 */
  redo: () => void
  /** 描述（调试/未来状态栏显示用） */
  description: string
}

export const useHistoryStore = defineStore('history', () => {
  const undoStack = ref<HistoryCommand[]>([])
  const redoStack = ref<HistoryCommand[]>([])
  const _enabled = ref(true)

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  /** 当前批次内合并模式（同一控件连续位置变更不撑爆栈） */
  let batch: HistoryCommand[] | null = null

  function push(cmd: HistoryCommand): void {
    if (!_enabled.value) return
    if (batch) {
      batch.push(cmd)
      return
    }
    undoStack.value.push(cmd)
    redoStack.value = []
    // 防止无限增长（保留最近 200 步）
    if (undoStack.value.length > 200) undoStack.value.shift()
  }

  /** 开启批处理：所有 push 合并为一步 undo（用于连续拖拽自动归并） */
  function beginBatch(): void {
    batch = []
  }

  function endBatch(description = '批量编辑'): void {
    if (!batch || batch.length === 0) {
      batch = null
      return
    }
    const cmds = batch
    undoStack.value.push({
      undo: () => cmds.slice().reverse().forEach((c) => c.undo()),
      redo: () => cmds.forEach((c) => c.redo()),
      description,
    })
    redoStack.value = []
    batch = null
  }

  function undo(): void {
    const cmd = undoStack.value.pop()
    if (!cmd) return
    _enabled.value = false
    try {
      cmd.undo()
      redoStack.value.push(cmd)
    } finally {
      _enabled.value = true
    }
  }

  function redo(): void {
    const cmd = redoStack.value.pop()
    if (!cmd) return
    _enabled.value = false
    try {
      cmd.redo()
      undoStack.value.push(cmd)
    } finally {
      _enabled.value = true
    }
  }

  function clear(): void {
    undoStack.value = []
    redoStack.value = []
    batch = null
  }

  return { undoStack, canUndo, canRedo, push, beginBatch, endBatch, undo, redo, clear }
})
