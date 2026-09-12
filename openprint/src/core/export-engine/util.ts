/**
 * 浏览器侧小工具：Blob → dataURL、触发下载
 */

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('FileReader 读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 触发浏览器下载（单文件） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收，确保下载已触发
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}
