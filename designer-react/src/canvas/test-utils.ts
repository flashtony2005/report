/**
 * 测试辅助：把 React 端 dataSource store 推进到「字段已加载」状态。
 *
 * 单独成文件的原因：多个 spec 都需要这个前置状态，而 `fetchSources/fetchFields`
 * 依赖模块级 fieldCache，重复调用是幂等的（有 CACHE_TTL 缓存）。
 */
import { vi } from 'vitest'
import { useDataSourceStore } from '../stores/dataSource'

let ready: Promise<void> | null = null

/** 幂等地把 dataSource store 推进到字段就绪态 */
export function useReactDataSourceStoreReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const s = useDataSourceStore.getState()
      await s.fetchSources()
      await useDataSourceStore.getState().fetchFields(true)
    })()
  }
  return ready
}

/**
 * happy-dom 万能 2D 上下文 stub（Fabric 初始化与签名画板共用）。
 * happy-dom 的 canvas.getContext 返回 null，Fabric new Canvas 时会崩。
 * 用 Proxy 兜底：已设属性原样返回，其余任意属性访问都给 no-op 函数
 * （Fabric 渲染会碰到 setLineDash / createLinearGradient 等长尾方法）。
 */
export function stubCanvas2d(): void {
  const makeCtx = (): CanvasRenderingContext2D => {
    const target: Record<PropertyKey, unknown> = {
      measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => ({}),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      canvas: null,
    }
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop]
        return () => {}
      },
      set(t, prop, value) {
        t[prop] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
  }
  let ctx: CanvasRenderingContext2D | null = null
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (!ctx) ctx = makeCtx()
    return ctx
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')
}
