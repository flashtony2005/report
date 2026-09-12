/** 控件 / 模板 ID 生成 */

let counter = 0

/**
 * 生成短唯一 ID：`{prefix}_{时间戳36进制}{自增36进制}{随机4位}`
 * 例：ctl_lx3k9a1f2x8q
 */
export function genId(prefix = 'ctl'): string {
  counter = (counter + 1) % 1296 // 36^2
  const time = Date.now().toString(36)
  const seq = counter.toString(36).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}_${time}${seq}${rand}`
}
