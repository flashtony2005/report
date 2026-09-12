/**
 * 模板文件导入 / 导出（B 功能，纯前端、零后端）。
 * - 导出：把模板 JSON 序列化成 .json 文件下载到本地。
 * - 导入：弹出文件选择框，读取并解析 .json 为 TemplateData（校验由调用方做）。
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

/** 导出模板为 .json 文件并触发浏览器下载 */
export function exportTemplateFile(data: TemplateData<AnyControl>, name: string): void {
  const safe = (name || 'template').replace(/[\\/:*?"<>|]/g, '_').trim() || 'template'
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 释放对象 URL（延迟一帧，确保下载已开始）
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 打开文件选择框，读取用户选择的 .json 模板，解析为 TemplateData。取消 / 解析失败返回 null。 */
export function importTemplateFile(): Promise<TemplateData<AnyControl> | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    const cleanup = () => {
      input.removeEventListener('change', onChange)
      window.removeEventListener('blur', onBlur)
      if (input.parentNode) input.parentNode.removeChild(input)
    }
    const onChange = async () => {
      const file = input.files?.[0]
      cleanup()
      if (!file) return resolve(null)
      try {
        const text = await file.text()
        const data = JSON.parse(text) as TemplateData<AnyControl>
        resolve(data)
      } catch {
        resolve(null)
      }
    }
    // 用户取消选择（blur 且未触发 change）时兜底 reject，避免悬挂
    const onBlur = () => {
      // 延迟一点，确保 change 先触发
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup()
          resolve(null)
        }
      }, 150)
    }
    input.addEventListener('change', onChange)
    window.addEventListener('blur', onBlur, { once: true })
    document.body.appendChild(input)
    input.click()
  })
}
