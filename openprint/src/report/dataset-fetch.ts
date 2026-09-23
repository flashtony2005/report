/**
 * URL → 数据集（**浏览器直连**）。
 *
 * ## 为什么刻意不做「后端代取」
 *
 * 让服务端按 URL 去取数，等于给任何能打开设计器的人一个**任意 URL 请求原语**
 * （SSRF）：可以探内网、可以读云厂商的元数据端点
 * （`http://169.254.169.254/latest/meta-data/…`）。
 *
 * 本项目在图片那条已经做过**同样的取舍** —— 只收 data URI、不收文件路径，
 * 理由就是「模板可以分享，读本地文件 = 任意文件读取原语」。
 * 这里保持一致：**浏览器自己去取**，能不能取到由对方的 CORS 决定，服务端不参与。
 *
 * ## 代价必须如实告诉用户
 *
 * 对方没给 CORS 响应头时，`fetch` 只会抛一句 `TypeError: Failed to fetch` ——
 * **分不清是跨域、DNS 还是断网**（浏览器刻意不告诉 JS 细节）。
 * 所以错误文案里把这条讲清楚，并给出可行退路（改用文件导入）。
 * 绝不能让它退化成一张空表：空表看着像「接口返回了 0 行」。
 */

import {
  DatasetParseError,
  extensionForContentType,
  fileExtension,
  fileNameFromUrl,
  isKnownExtension,
  parseDatasetFileAsync,
  type ParsedTable,
} from './dataset-import'

/**
 * 给一个 URL 响应凑出「文件名」，供 `parseDatasetFileAsync` 判后缀。
 *
 * 顺序：**URL 后缀 → `Content-Type` → 报错**。
 * 两步都认不出时**报错**而不是猜一个格式：猜错会渲染出一张结构不对的表，
 * 而界面看着是「成功」的。这条判据是**可判定**的，所以报错才对。
 */
export function datasetFileNameFor(url: string, contentType: string): string {
  const fromUrl = fileNameFromUrl(url)
  if (isKnownExtension(fileExtension(fromUrl))) return fromUrl
  const ext = extensionForContentType(contentType)
  if (ext === null) {
    throw new DatasetParseError(
      `认不出数据格式：地址「${fromUrl}」没有可用后缀，响应也没有可识别的 Content-Type` +
        `（收到 ${contentType.trim() === '' ? '空' : contentType}）。` +
        `请让地址指向 .csv / .json / .xlsx，或让接口返回正确的 Content-Type。`,
    )
  }
  return `${fromUrl}.${ext}`
}

/** 取数的结果：行 + 实际用的文件名（给界面显示「数据从哪来」） */
export interface FetchedDataset extends ParsedTable {
  fileName: string
}

/**
 * 拉一个 URL 并解析成数据集。
 *
 * 失败**一律抛 `DatasetParseError`**（`message` 直接给用户看），
 * 不返回空表 —— 空表和「接口真的返回 0 行」在界面上长得一模一样。
 */
export async function fetchDatasetFromUrl(url: string): Promise<FetchedDataset> {
  const target = url.trim()
  if (target === '') throw new DatasetParseError('请先填地址')

  let res: Response
  try {
    res = await fetch(target)
  } catch (e) {
    throw new DatasetParseError(
      `取数失败：${e instanceof Error ? e.message : String(e)}。` +
        `这是浏览器直连（服务端不代取）—— 对方没给 CORS 响应头时，` +
        `浏览器只会说「Failed to fetch」，分不清是跨域还是网络；` +
        `若确实跨域，请改用文件导入，或让对方加上 CORS 头。`,
    )
  }

  if (!res.ok) {
    throw new DatasetParseError(
      `取数失败：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    )
  }

  // 先判文件名（可能抛「认不出格式」），再去读 body —— 早报错省一次下载
  const fileName = datasetFileNameFor(target, res.headers.get('content-type') ?? '')
  const blob = await res.blob()
  const parsed = await parseDatasetFileAsync(new File([blob], fileName))
  return { ...parsed, fileName }
}
