/**
 * RulerOverlay —— SVG 标尺覆盖层（React 版）
 *
 * 与 Vue 版 `canvas/rulers/RulerOverlay.vue` 行为一致：
 * 水平（顶）+ 垂直（左）标尺，mm 刻度自适应缩放密度；
 * 监听 designer store 的 viewport 驱动重绘；
 * 选中/拖拽元素的高亮带来自框架无关的 rulerHighlight 共享状态。
 *
 * 刻度换算已抽成纯函数 `ruler-geometry.ts`（有独立单测），本组件只做渲染。
 */
import { useSyncExternalStore } from 'react'
import { useDesignerStore } from '../stores/designer'
import { useUiStore, resolveEffectiveTheme } from '../stores/ui'
import {
  RULER_THICK,
  RULER_PALETTE_LIGHT,
  RULER_PALETTE_DARK,
} from '@/utils/constants'
import { computeBand, computeTicks } from './ruler-geometry'
import { getRulerBand, onRulerBandChange } from '@/design/canvas/rulers/rulerHighlight'

const PALETTES = {
  light: RULER_PALETTE_LIGHT,
  dark: RULER_PALETTE_DARK,
} as const

interface RulerOverlayProps {
  stageWidth: number
  stageHeight: number
}

export default function RulerOverlay({ stageWidth, stageHeight }: RulerOverlayProps) {
  const viewport = useDesignerStore((s) => s.viewport)
  const themePreference = useUiStore((s) => s.themePreference)
  const systemDark = useUiStore((s) => s.systemDark)
  const effective = resolveEffectiveTheme({ themePreference, systemDark })
  const palette = PALETTES[effective === 'dark' ? 'dark' : 'light']

  // rulerBand 是框架无关共享状态，用 useSyncExternalStore 接入 React 渲染
  const band = useSyncExternalStore(onRulerBandChange, getRulerBand, () => null)

  const hTicks = computeTicks({ zoom: viewport.zoom, offset: viewport.offsetX, size: stageWidth })
  const vTicks = computeTicks({ zoom: viewport.zoom, offset: viewport.offsetY, size: stageHeight })
  const bandGeom = computeBand(band, viewport)

  return (
    <div
      className="pointer-events-none absolute inset-0 select-none"
      style={{ zIndex: 10 }}
    >
      <svg width={stageWidth} height={stageHeight} className="block">
        {/* 水平标尺背景 */}
        <rect x={0} y={0} width={stageWidth} height={RULER_THICK} fill={palette.bgColor} />
        {/* 水平刻度线 */}
        {hTicks.map((t) => (
          <line
            key={`h${t.coord}`}
            x1={t.coord}
            y1={t.coord % 2 === 0 ? 10 : 14}
            x2={t.coord}
            y2={RULER_THICK}
            stroke={palette.tickColor}
            strokeWidth={1}
          />
        ))}
        {/* 水平刻度文字 */}
        {hTicks
          .filter((t) => t.label !== null)
          .map((t) => (
            <text
              key={`ht${t.coord}`}
              x={t.coord + 2}
              y={RULER_THICK - 5}
              fill={palette.labelColor}
              fontSize={10}
              fontFamily="Inter, PingFang SC, sans-serif"
            >
              {t.label}
            </text>
          ))}

        {/* 垂直标尺背景 */}
        <rect x={0} y={0} width={RULER_THICK} height={stageHeight} fill={palette.bgColor} />
        {/* 垂直刻度线 */}
        {vTicks.map((t) => (
          <line
            key={`v${t.coord}`}
            x1={t.coord % 2 === 0 ? 10 : 14}
            y1={t.coord}
            x2={RULER_THICK}
            y2={t.coord}
            stroke={palette.tickColor}
            strokeWidth={1}
          />
        ))}
        {/* 垂直刻度文字 */}
        {vTicks
          .filter((t) => t.label !== null)
          .map((t) => (
            <text
              key={`vt${t.coord}`}
              x={3}
              y={t.coord + 8}
              fill={palette.labelColor}
              fontSize={9}
              fontFamily="Inter, PingFang SC, sans-serif"
            >
              {t.label}
            </text>
          ))}

        {/* 选中/拖拽元素高亮带：顶带=宽度，左带=高度 */}
        {bandGeom && (
          <>
            <rect
              x={bandGeom.x1}
              y={0}
              width={Math.max(0, bandGeom.wPx)}
              height={RULER_THICK}
              fill={palette.bandColor}
              stroke={palette.bandBorder}
              strokeWidth={1}
            />
            <rect
              x={0}
              y={bandGeom.y1}
              width={RULER_THICK}
              height={Math.max(0, bandGeom.hPx)}
              fill={palette.bandColor}
              stroke={palette.bandBorder}
              strokeWidth={1}
            />
            {/* 宽度标签（px 足够宽才显示） */}
            {bandGeom.wPx >= 26 && (
              <text
                x={(bandGeom.x1 + bandGeom.x2) / 2}
                y={RULER_THICK - 6}
                fill={palette.bandText}
                fontSize={10}
                textAnchor="middle"
                fontFamily="Inter, PingFang SC, sans-serif"
              >
                {bandGeom.widthMm.toFixed(1)}
              </text>
            )}
            {/* 高度标签（竖排；px 足够高才显示） */}
            {bandGeom.hPx >= 26 && (
              <text
                x={RULER_THICK / 2}
                y={bandGeom.hLabelCy}
                fill={palette.bandText}
                fontSize={10}
                textAnchor="middle"
                fontFamily="Inter, PingFang SC, sans-serif"
                transform={`rotate(-90 ${RULER_THICK / 2} ${bandGeom.hLabelCy})`}
              >
                {bandGeom.heightMm.toFixed(1)}
              </text>
            )}
          </>
        )}

        {/* 角标（标尺交叉的方角） */}
        <rect x={0} y={0} width={RULER_THICK} height={RULER_THICK} fill={palette.bgColor} />
      </svg>
    </div>
  )
}
