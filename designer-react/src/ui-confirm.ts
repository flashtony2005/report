/**
 * ui-confirm —— 应用内确认弹窗（等价 Vue 版 useConfirm）
 *
 * antd Modal.confirm 的 Promise 化封装：确定 → true；取消/关闭 → false。
 * Vue 端 useConfirm 由 naive-ui useDialog 实现，语义一致。
 */
import { Modal } from 'antd'

/** 应用内消息提示（等价 Vue 版 useMessage）——统一从这里引，方便日后换 App.useMessage 上下文形态 */
export { message as antdMessage } from 'antd'

export function confirmDialog(content: string, title = '确认操作'): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText: '确定',
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
