/**
 * LongPressMenu —— 触屏长按控件弹出的上下文菜单（P6.4）
 *
 * 移动端无右键：长按控件 500ms（共享引擎 onLongPress）后弹出。
 * 菜单项：复制 / 删除 / 上移 / 下移。点击遮罩或执行动作后关闭。
 */
import { useCallback } from 'react'
import type { ReactElement } from 'react'
import { useDesignerStore } from '../stores/designer'
import './long-press-menu.css'

export interface LongPressMenuState {
  controlId: string
  x: number
  y: number
}

export function LongPressMenu({ state, onClose }: { state: LongPressMenuState; onClose: () => void }): ReactElement {
  const run = useCallback(
    (fn: (s: ReturnType<typeof useDesignerStore.getState>) => void) => {
      fn(useDesignerStore.getState())
      onClose()
    },
    [onClose],
  )

  const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
    {
      // 走 store 的 duplicateControl：换新 id + 右下偏移，并选中副本。
      // 此前用 addControlOfType(type, at, ctrl) 把整个控件当 init 传入，
      // init.id 会覆盖掉新建的 id → 副本与原控件同 id（画布上两个同 id 控件）。
      label: '复制',
      action: () => run((s) => s.duplicateControl(state.controlId)),
    },
    {
      label: '上移一层',
      action: () => run((s) => s.moveControl(state.controlId, 'up')),
    },
    {
      label: '下移一层',
      action: () => run((s) => s.moveControl(state.controlId, 'down')),
    },
    {
      label: '删除',
      danger: true,
      action: () => run((s) => s.removeControl(state.controlId)),
    },
  ]

  // 视口内夹取：菜单 120×约160，靠边翻转
  const left = Math.min(state.x, (typeof window !== 'undefined' ? window.innerWidth : 900) - 140)
  const top = Math.min(state.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200)

  return (
    <div className="lpm-mask" onPointerDown={onClose} data-testid="long-press-mask">
      <div
        className="lpm-menu"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="long-press-menu"
      >
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            className={`lpm-item${it.danger ? ' is-danger' : ''}`}
            onClick={it.action}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  )
}
