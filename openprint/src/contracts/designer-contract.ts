/**
 * 设计器状态层 · 跨框架契约
 * ==========================
 *
 * 目的：Vue(pinia) 与 React(zustand) 两端跑**同一份**操作序列，
 *      输出的 `TemplateData` 必须逐字段一致。这是迁移的安全网——
 *      只要契约全绿，就证明 React 版状态层与 Vue 版行为等价。
 *
 * 本文件是**纯 TS、零框架依赖**的单一数据源，两端各自实现 `DesignerDriver` 后
 * 调用 `runDesignerContract()` 即可。
 *
 * 使用方式：
 *   - Vue 端（录制）：  runDesignerContract(vueDriver)  → 写入 golden/designer-v1.json
 *   - React 端（验证）：runDesignerContract(reactDriver) → 与 golden 深比对
 */

/* ------------------------------------------------------------------ */
/* 契约类型（鸭子类型，两端结构兼容即可，不 import 任何框架/项目类型）      */
/* ------------------------------------------------------------------ */

export interface ContractControl {
  id: string
  type: string
  left: number
  top: number
  width: number
  height: number
  [k: string]: unknown
}

export interface ContractSection {
  type: string
  height?: number
  repeat?: boolean
  components: ContractControl[]
}

export interface ContractTemplate {
  version: string
  document: {
    type: string
    page: Record<string, unknown>
    sections: ContractSection[]
  }
}

export interface DesignerSnapshot {
  templateName: string
  /** body 区控件 id + 类型 + 几何（不比整个对象，避免无关字段噪音） */
  controls: Array<{ id: string; type: string; left: number; top: number; width: number; height: number }>
  zones: Array<{ id: string; type: string; zone?: string; childCount: number }>
  selectedIds: string[]
  dirty: boolean
  minPages: number
  canUndo: boolean
  canRedo: boolean
}

/** 各端需实现的驱动器 */
export interface DesignerDriver {
  /** 框架标识，仅用于报错信息 */
  name: string
  /** 重置到「刚新建空白模板」的初始状态，并清空历史栈 */
  reset(): void
  getSnapshot(): DesignerSnapshot
  addControlOfType(
    type: string,
    at: { leftMm: number; topMm: number },
    init?: Record<string, unknown>,
    zoneHostId?: string,
  ): void
  updateControl(id: string, patch: Record<string, unknown>): void
  removeControl(id: string): void
  moveControl(id: string, dir: 'up' | 'down'): void
  selectControl(id: string | null): void
  addZone(zone: 'header' | 'footer'): void
  addControlIntoLabelGrid(
    gridId: string,
    type: string,
    atAbsolute: { leftMm: number; topMm: number },
    init?: Record<string, unknown>,
  ): void
  removeLabelGridChild(gridId: string, childId: string): void
  setMinPages(n: number): void
  newBlankTemplate(): void
  undo(): void
  redo(): void
  buildTemplate(): ContractTemplate
}

export interface ScenarioResult {
  /** 场景结束时 buildTemplate() 的产物 */
  template: ContractTemplate
  /** 场景结束时状态快照 */
  snapshot: DesignerSnapshot
  /**
   * 关键步骤打点快照。
   * 必要性：undo/redo 这类场景只看终态会漏掉中间语义
   * （如「撤销到底」应为 0 个控件，但 redo 回来后终态又是 3 个）。
   */
  checkpoints: Record<string, DesignerSnapshot>
}

export type ContractResult = Record<string, ScenarioResult>

/* ------------------------------------------------------------------ */
/* 确定性 ID：genId() 内含 Date.now() + Math.random()，必须 stub         */
/* ------------------------------------------------------------------ */

const RAND_SEQUENCE = [
  0.1234567, 0.2345678, 0.3456789, 0.4567891, 0.5678912, 0.6789123, 0.7891234, 0.8912345, 0.9123456,
  0.1010101, 0.2020202, 0.3030303, 0.4040404, 0.5050505, 0.6060606, 0.7070707, 0.8080808, 0.9090909,
]

/**
 * 在 fn 执行期间把 Math.random / Date.now 固定成确定性序列，
 * 保证两端生成的控件 ID 完全一致（否则契约无法逐字段比对）。
 */
export function withDeterministicIds<T>(fn: () => T): T {
  const origRandom = Math.random
  const origNow = Date.now
  let i = 0
  Math.random = () => RAND_SEQUENCE[i++ % RAND_SEQUENCE.length]
  Date.now = () => 1_700_000_000_000
  try {
    return fn()
  } finally {
    Math.random = origRandom
    Date.now = origNow
  }
}

/* ------------------------------------------------------------------ */
/* 操作序列                                                            */
/* ------------------------------------------------------------------ */

/** 覆盖全部控件类型，作为默认工厂的黄金基线 */
const ALL_CONTROL_TYPES = [
  'text',
  'richtext',
  'image',
  'rect',
  'line',
  'table',
  'barcode',
  'qrcode',
  'chart',
  'math',
  'signature',
  'labelgrid',
] as const

export function runDesignerContract(driver: DesignerDriver): ContractResult {
  return withDeterministicIds(() => {
    const out: ContractResult = {}

    /** 跑一个场景：reset → 执行 → 收集 template + snapshot + checkpoints */
    const scenario = (
      name: string,
      body: (d: DesignerDriver, mark: (label: string) => void) => void,
    ): void => {
      driver.reset()
      const checkpoints: Record<string, DesignerSnapshot> = {}
      const mark = (label: string): void => {
        checkpoints[label] = driver.getSnapshot()
      }
      body(driver, mark)
      out[name] = {
        template: driver.buildTemplate(),
        snapshot: driver.getSnapshot(),
        checkpoints,
      }
    }

    /* ---------- 1. 空白模板基线 ---------- */
    scenario('01-blank', () => {
      // 什么都不做，验证默认页面设置与空 sections
    })

    /* ---------- 2. 全部控件类型的默认工厂 ---------- */
    scenario('02-all-control-types', (d) => {
      ALL_CONTROL_TYPES.forEach((type, i) => {
        d.addControlOfType(type, { leftMm: 10 + i * 2, topMm: 10 + i * 3 })
      })
    })

    /* ---------- 3. 属性编辑 + 撤销/重做 ---------- */
    scenario('03-update-then-undo-redo', (d, mark) => {
      d.addControlOfType('text', { leftMm: 20, topMm: 20 })
      mark('after-add')
      const id = d.getSnapshot().controls[0].id
      // 两次 update 都改几何，保证撤销的每一档在快照里可区分
      d.updateControl(id, { value: 'hello', fontSize: 18, bold: true, left: 11.1, width: 66 })
      d.updateControl(id, { left: 35.5, top: 42.3, width: 90, height: 20 })
      mark('after-2-updates')
      d.undo()
      mark('after-undo-1')
      d.undo()
      mark('after-undo-2')
      d.redo()
      mark('after-redo-1')
    })

    /* ---------- 4. 层级移动与删除 ---------- */
    scenario('04-move-and-remove', (d, mark) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      d.addControlOfType('rect', { leftMm: 10, topMm: 40 })
      d.addControlOfType('line', { leftMm: 10, topMm: 70 })
      const ids = d.getSnapshot().controls.map((c) => c.id)
      mark('before-move')
      // 移动**中间/首个**控件且不被后续删除抵消，否则方向写反也看不出来
      d.moveControl(ids[0], 'up') // [text,rect,line] → [rect,text,line]
      mark('after-move-up')
      d.moveControl(ids[0], 'down') // → [text,rect,line]
      mark('after-move-down')
      d.removeControl(ids[2]) // 删 line
      d.selectControl(ids[0])
    })

    /* ---------- 5. 撤销到底 / 重做到底 ---------- */
    scenario('05-undo-to-empty', (d, mark) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      d.addControlOfType('rect', { leftMm: 10, topMm: 30 })
      d.addControlOfType('line', { leftMm: 10, topMm: 50 })
      mark('after-add-3')
      d.undo()
      d.undo()
      d.undo()
      mark('after-undo-all')
      d.undo() // 空栈再撤一次，应无副作用
      mark('after-undo-overflow')
      d.redo()
      d.redo()
      d.redo()
      mark('after-redo-all')
      d.redo() // 空栈再重做一次，应无副作用
      mark('after-redo-overflow')
    })

    /* ---------- 6. 页眉 / 页脚 zone ---------- */
    scenario('06-zones', (d) => {
      d.addZone('header')
      d.addZone('footer')
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      const zones = d.getSnapshot().zones
      // 往页眉里塞一个子控件
      d.addControlOfType('text', { leftMm: 12, topMm: 4 }, { value: '页眉标题' }, zones[0].id)
      // 往页脚里塞一个子控件
      d.addControlOfType('line', { leftMm: 12, topMm: 6 }, undefined, zones[1].id)
    })

    /* ---------- 7. 页眉高度变更 → 正文重排 ---------- */
    scenario('07-zone-height-reflow', (d) => {
      d.addZone('header')
      d.addControlOfType('text', { leftMm: 10, topMm: 40 })
      const header = d.getSnapshot().zones[0]
      d.updateControl(header.id, { zoneHeight: 45 })
    })

    /* ---------- 8. 标签网格：首卡子控件增删 ---------- */
    scenario('08-labelgrid', (d) => {
      d.addControlOfType('labelgrid', { leftMm: 10, topMm: 10 })
      const grid = d.getSnapshot().controls[0]
      d.addControlIntoLabelGrid(grid.id, 'text', { leftMm: 14, topMm: 14 }, { value: '品名' })
      d.addControlIntoLabelGrid(grid.id, 'barcode', { leftMm: 14, topMm: 22 })
      const withChildren = d.getSnapshot().controls[0]
      d.removeLabelGridChild(withChildren.id, 'FOR_REMOVE')
    })

    /* ---------- 9. 手动分页 ---------- */
    scenario('09-min-pages', (d) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      d.setMinPages(3)
      d.setMinPages(-5) // 负数应收敛到 0
      d.setMinPages(2.7) // 小数应向下取整
    })

    /* ---------- 10. 新建模板后历史栈清空 ---------- */
    scenario('10-new-blank-clears-history', (d, mark) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      d.addControlOfType('rect', { leftMm: 10, topMm: 30 })
      mark('before-new-blank')
      d.newBlankTemplate()
      mark('after-new-blank')
      d.addControlOfType('line', { leftMm: 5, topMm: 5 })
    })

    /* ---------- 11. 选中态与删除联动 ---------- */
    scenario('11-select-and-remove', (d) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      d.addControlOfType('rect', { leftMm: 10, topMm: 30 })
      const ids = d.getSnapshot().controls.map((c) => c.id)
      d.selectControl(ids[1])
      d.removeControl(ids[1])
      d.selectControl(null)
    })

    /* ---------- 12. 坐标 snap 到 0.1mm（NaN / 负数兜底） ---------- */
    scenario('12-coordinate-snap', (d) => {
      d.addControlOfType('text', { leftMm: 139.82, topMm: -12 })
      d.addControlOfType('rect', { leftMm: Number.NaN, topMm: Number.NaN })
      d.addControlOfType('line', { leftMm: 33.333, topMm: 0 })
    })

    /* ---------- 13. 嵌套对象（style）的历史 —— 深拷贝回归 ---------- */
    // 保护意图：若 undo 记录的旧值是浅拷贝，一旦将来有人把更新改成
    // 「直接改 current.style.fontSize」的可变写法，撤销就会读到被污染的对象。
    // 该场景把 style 全量记进 golden，任何污染都会导致两端不一致。
    scenario('13-nested-style-history', (d, mark) => {
      d.addControlOfType('text', { leftMm: 10, topMm: 10 })
      const id = d.getSnapshot().controls[0].id
      d.updateControl(id, { style: { fontSize: 24, bold: true } })
      mark('after-style-1')
      d.updateControl(id, { style: { fontSize: 9 } })
      mark('after-style-2')
      d.undo() // 应回到 fontSize 24 + bold
    })

    return out
  })
}

/** 深比对：返回差异路径数组，空数组表示一致 */
export function diffContract(a: unknown, b: unknown, path = ''): string[] {
  // 归一化：JSON 往返一次。
  // 必须做——对象里 `minPages: undefined` 与 `{}` 语义等价，
  // 但 Object.keys() 能看见前者、JSON.stringify 会丢掉后者。
  // golden 走的是「序列化落盘 → 反序列化」链路，比对前必须让两边同构。
  return diffNormalized(jsonRoundTrip(a), jsonRoundTrip(b), path)
}

function jsonRoundTrip(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null))
}

function diffNormalized(a: unknown, b: unknown, path = ''): string[] {
  const diffs: string[] = []
  if (a === b) return diffs
  if (typeof a !== typeof b || a === null || b === null) {
    diffs.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
    return diffs
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) diffs.push(`${path}.length: ${a.length} !== ${b.length}`)
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) diffs.push(...diffNormalized(a[i], b[i], `${path}[${i}]`))
    return diffs
  }
  if (typeof a === 'object') {
    // a = 基准（golden），b = 当前
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    const all = new Set([...ka, ...kb])
    for (const k of all) {
      if (!kb.includes(k)) diffs.push(`${path}.${k}: 仅存在于基准`)
      else if (!ka.includes(k)) diffs.push(`${path}.${k}: 仅存在于当前`)
      else diffs.push(...diffNormalized((a as never)[k], (b as never)[k], `${path}.${k}`))
    }
    return diffs
  }
  diffs.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
  return diffs
}
