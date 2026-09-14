/**
 * 把「被当成公式吞进 `f` 字段」的 `=` 文本捞回 `v` 字段。
 *
 * 背景（这段是实测出来的，别凭直觉改）：
 * `sheets-ui` 的 `getCellDataByInput`（`sheets-ui/lib/es/index.js` 搜这个函数名）
 * 在单元编辑器提交时硬编码：
 *
 *     else if (isFormulaString(newDataStream)) { cellData.f = ...; cellData.v = null }
 *
 * 于是用户键入 `=ds1.city` 之后，格子里躺的是 `{f: '=ds1.city', v: null}` ——
 * 单元格看起来是空的，回读也是空的。**这一段在 sheets-ui 里，跟有没有装
 * 公式引擎无关**，所以剥掉 `engine-formula` 并不会让 `=` 变好用。
 *
 * 对策是在 mutation 落地**之前**把 `{f, v: null}` 掰回 `{v: f, f: null, t: 4}`。
 * 之所以选「改 mutation 参数」而不是「改完再写一个新值」：前者不会闪现空值，
 * 也不会触发第二次事件（没有自激循环的风险）。
 *
 * 之所以从 `f` 而不是别处还原：`f` 里存的就是用户原样输入的流，没被
 * `normalizeString` / 括号补全之外的东西动过。
 */

/** Univer `CellValueType.FORCE_STRING`：强制把单元格当字符串，别再识别成公式 */
export const FORCE_STRING = 4

/** `=` 开头且长度 > 1 —— 与 Univer `isFormulaString` 的判定保持一致 */
export function isFormulaLike(f: unknown): f is string {
  return typeof f === 'string' && f.length > 1 && f.charCodeAt(0) === 0x3d
}

/**
 * 就地改写 `SetRangeValuesMutation` 的 `cellValue`（`{ [row]: { [col]: ICellData } }`）。
 *
 * 返回被捞回来的格数。返回 0 既可能是「没有 `=` 文本」，也可能是「参数形状不对」，
 * 所以调用方**不要**拿 0 当错误信号——形状不对要另外判（见 `looksLikeCellValue`）。
 */
export function rescueFormulaStringCells(cellValue: unknown): number {
  if (!cellValue || typeof cellValue !== 'object') return 0
  let n = 0
  for (const row of Object.values(cellValue as Record<string, unknown>)) {
    if (!row || typeof row !== 'object') continue
    for (const cell of Object.values(row as Record<string, unknown>)) {
      if (!cell || typeof cell !== 'object') continue
      const c = cell as { f?: unknown; v?: unknown; t?: number }
      // v 已经有值的不能动：那说明这一格本来就有内容，不是被吞掉的
      if (!isFormulaLike(c.f) || (c.v !== null && c.v !== undefined)) continue
      c.v = c.f
      c.f = null
      c.t = FORCE_STRING
      n += 1
    }
  }
  return n
}

/**
 * 粗判一下 `cellValue` 是不是「行 → 列 → 格」的对象矩阵。
 *
 * 用来把「Univer 换了参数结构，我们的拦截器已经失效」这种**静默退化**变成
 * 能看出来的信号：形状不对就报警，而不是继续装作一切正常。
 */
export function looksLikeCellValue(cellValue: unknown): boolean {
  if (!cellValue || typeof cellValue !== 'object') return false
  const rows = Object.values(cellValue as Record<string, unknown>)
  if (rows.length === 0) return false
  const row = rows[0]
  if (!row || typeof row !== 'object') return false
  const cells = Object.values(row as Record<string, unknown>)
  if (cells.length === 0) return false
  const cell = cells[0]
  return !!cell && typeof cell === 'object'
}
