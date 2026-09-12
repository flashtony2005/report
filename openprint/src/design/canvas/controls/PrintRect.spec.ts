/**
 * PrintRect 四角独立圆角路径几何验证。
 *
 * 做法：用「路径录制桩」捕获 traceRoundRectPath 发出的绘制指令，直接按指令断言几何 ——
 * - 有半径的角：该角会发一次 arcTo，且控制点正是该角的直角顶点（顶点被圆弧切掉）
 * - 半径为 0 的角：不发 arcTo，直角顶点保留在路径上（仍是尖角）
 *
 * 坐标约定与 Fabric _render 一致：ctx 进入时已平移到对象中心，坐标范围 -w/2 ~ w/2。
 *
 * 为什么不用 node-canvas 光栅化后抽样像素：
 * - 免去一个需要原生编译的重量级依赖（cairo/pango），安装慢、CI 环境易碎
 * - 断言更直接：能精确验证「半径夹紧值」，像素抽样只能判断"圆没圆"，测不出夹紧到多少
 */
import { describe, expect, it } from 'vitest'
import { traceRoundRectPath } from './PrintRect'

interface ArcCall {
  /** arcTo 的控制点（即被切掉的直角顶点） */
  cx: number
  cy: number
  /** 该角的实际圆角半径（已夹紧） */
  r: number
}

interface RecordedPath {
  moveTo: Array<[number, number]>
  lineTo: Array<[number, number]>
  arcs: ArcCall[]
  closed: boolean
}

/** 录制一次 traceRoundRectPath 发出的全部路径指令 */
function recordPath(w: number, h: number, tl: number, tr: number, br: number, bl: number): RecordedPath {
  const path: RecordedPath = { moveTo: [], lineTo: [], arcs: [], closed: false }
  const ctx = {
    beginPath() {},
    moveTo(x: number, y: number) {
      path.moveTo.push([x, y])
    },
    lineTo(x: number, y: number) {
      path.lineTo.push([x, y])
    },
    // 只用前两个参数（控制点 = 被切掉的直角顶点）与半径
    arcTo(x1: number, y1: number, _x2: number, _y2: number, r: number) {
      path.arcs.push({ cx: x1, cy: y1, r })
    },
    closePath() {
      path.closed = true
    },
  }
  traceRoundRectPath(ctx as unknown as CanvasRenderingContext2D, w, h, tl, tr, br, bl)
  return path
}

type CornerKey = 'TL' | 'TR' | 'BR' | 'BL'

/** 四个直角顶点的坐标（对象中心为原点） */
function cornerVertices(w: number, h: number): Record<CornerKey, [number, number]> {
  const x = -w / 2
  const y = -h / 2
  return {
    TL: [x, y],
    TR: [x + w, y],
    BR: [x + w, y + h],
    BL: [x, y + h],
  }
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

/** 某角是否被圆角化：存在以该角直角顶点为控制点的 arcTo */
function isRounded(path: RecordedPath, vertex: [number, number]): boolean {
  return path.arcs.some((a) => near(a.cx, vertex[0]) && near(a.cy, vertex[1]))
}

/** 各角圆角化情况 */
function roundedMap(
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
): Record<CornerKey, boolean> {
  const path = recordPath(w, h, tl, tr, br, bl)
  const v = cornerVertices(w, h)
  return {
    TL: isRounded(path, v.TL),
    TR: isRounded(path, v.TR),
    BR: isRounded(path, v.BR),
    BL: isRounded(path, v.BL),
  }
}

describe('PrintRect —— 四角独立圆角路径几何', () => {
  const W = 160
  const H = 100

  it('仅左上角有半径时，只有 TL 被圆角化', () => {
    expect(roundedMap(W, H, 40, 0, 0, 0)).toEqual({
      TL: true,
      TR: false,
      BR: false,
      BL: false,
    })
  })

  it('四角全 0 时为标准直角矩形（无 arcTo，路径闭合）', () => {
    const path = recordPath(W, H, 0, 0, 0, 0)
    expect(path.arcs).toHaveLength(0)
    expect(path.closed).toBe(true)
    expect(roundedMap(W, H, 0, 0, 0, 0)).toEqual({
      TL: false,
      TR: false,
      BR: false,
      BL: false,
    })
  })

  it('四角均设半径时全部圆角化', () => {
    expect(roundedMap(W, H, 30, 30, 30, 30)).toEqual({
      TL: true,
      TR: true,
      BR: true,
      BL: true,
    })
  })

  it('半径上限被夹紧到短边一半，四角仍正常且夹紧值精确为 50', () => {
    // 短边 H=100 → 上限 50；传 999 应被 clamp 到 50 而非溢出
    const path = recordPath(W, H, 999, 999, 999, 999)
    expect(path.arcs).toHaveLength(4)
    for (const arc of path.arcs) {
      expect(arc.r).toBe(50)
    }
    expect(roundedMap(W, H, 999, 999, 999, 999)).toEqual({
      TL: true,
      TR: true,
      BR: true,
      BL: true,
    })
  })

  it('起笔点按左上圆角半径内缩，半径 0 时从左上角顶点起笔', () => {
    // moveTo(x + tl, y)：左上半径会让起笔点右移
    const zero = recordPath(W, H, 0, 0, 0, 0)
    expect(zero.moveTo).toEqual([[-W / 2, -H / 2]])

    const rounded = recordPath(W, H, 20, 0, 0, 0)
    expect(rounded.moveTo).toEqual([[-W / 2 + 20, -H / 2]])
  })
})
