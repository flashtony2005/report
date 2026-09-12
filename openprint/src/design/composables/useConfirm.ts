/**
 * useConfirm —— 统一的「确认」弹窗（应用内系统弹窗）
 *
 * 取代浏览器原生 window.confirm / window.alert：
 *   - 原生 confirm 是浏览器 Chrome 级别的 UI，与项目主题/设计语言割裂，且阻塞线程；
 *   - 本封装基于 naive-ui 的 NDialogProvider（App.vue 已挂载 <NDialogProvider>），
 *     弹窗随亮/暗主题自适应，文案与按钮可定制，体验一致。
 *
 * 用法（必须在组件 <script setup> 顶层调用，useDialog 依赖 inject 只能在此处取 provider）：
 *   const { confirm } = useConfirm()
 *   async function onUse() {
 *     if (store.dirty && !(await confirm('将覆盖未保存的改动，确定继续？'))) return
 *     ...
 *   }
 *
 * confirm() 返回 Promise<boolean>：点「确定」resolve(true)，点「取消」/关闭/点遮罩 resolve(false)。
 * Promise 的 resolve 幂等，重复触发不会翻转结果。
 */
import { useDialog } from 'naive-ui'

export interface ConfirmOptions {
  /** 弹窗标题，默认「确认操作」 */
  title?: string
  /** 确定按钮文案，默认「确定」 */
  positiveText?: string
  /** 取消按钮文案，默认「取消」 */
  negativeText?: string
}

export function useConfirm() {
  const dialog = useDialog()

  function confirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      dialog.warning({
        title: opts.title ?? '确认操作',
        content: message,
        positiveText: opts.positiveText ?? '确定',
        negativeText: opts.negativeText ?? '取消',
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onClose: () => resolve(false),
      })
    })
  }

  return { confirm }
}
