/**
 * P5.1b 测试：数据库探索器接入 + probe → dataSource 桥
 *
 * 探索器本身不发起真实网络请求（打印客户端接口整体 mock），
 * 只验证：开关可用性、拉库、选库建表树、点表展开列（PK/UNIQUE 标记）、
 * 绑定信息区，以及连接状态桥接。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* 打印客户端接口 mock：存储层调的 listClient* / fetchClientRows 全部就地返回假数据 */
vi.mock('@/core/print-client', async () => {
  const actual = await vi.importActual<typeof import('@/core/print-client')>('@/core/print-client')
  return {
    ...actual,
    listClientDatabases: vi.fn(async () => [
      { name: 'F:/data/demo.db', label: 'demo', engine: 'sqlite' as const },
    ]),
    listClientTables: vi.fn(async () => [{ name: 'orders' }, { name: 'customers' }]),
    listClientColumns: vi.fn(async () => [
      { name: 'id', type: 'INTEGER', key: 'PRI', primary: true },
      { name: 'order_no', type: 'TEXT', key: 'UNI' },
      { name: 'amount', type: 'REAL' },
    ]),
    fetchClientRows: vi.fn(async () => ({
      ok: true,
      rows: [{ id: 1, order_no: 'SO20260910001', amount: 1250.5 }],
      total: 1,
    })),
  }
})

import { useDataSourceStore } from './stores/dataSource'
import { usePrinterProbeStore } from './stores/printerProbe'
import { connectPrinterToDataSource } from './stores/bridge'
import DatabaseExplorer from './panels/DatabaseExplorer'

const body = () => document.body

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }
}

describe('DatabaseExplorer（P5.1b 接入）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDataSourceStore.getState().$reset()
    // 进入数据库模式 + 已连接客户端；开关仍保持关闭（= 真实默认状态）
    useDataSourceStore.setState({ kind: 'database', dbAvailable: true, dbEnabled: false })
  })

  it('开关关闭时不请求数据，只显示开关行', () => {
    act(() => {
      root.render(createElement(DatabaseExplorer))
    })
    const text = body().textContent!
    expect(text).toContain('启用数据库数据源')
    expect(text).toContain('需手动开启')
    // 关着时不该出现取数区
    expect(text).not.toContain('选择数据库')
  })

  it('打开开关 → 拉库列表 → 选库出表 → 点表展开列（PK/UNIQUE 标记）', async () => {
    act(() => {
      root.render(createElement(DatabaseExplorer))
    })

    // 打开开关（手动授权，才发起 /api/data 请求）
    const sw = body().querySelector<HTMLButtonElement>('.db-explorer-switch .ant-switch')!
    expect(sw, '开关存在').toBeTruthy()
    expect(sw.disabled).toBe(false)
    await act(async () => {
      sw.click()
    })
    await waitFor(() => body().textContent!.includes('选择数据库'))
    expect(useDataSourceStore.getState().dbEnabled).toBe(true)
    expect(useDataSourceStore.getState().dbDatabases.length).toBe(1)

    // 选库 → 拉到表
    await act(async () => {
      await useDataSourceStore.getState().selectDatabase('F:/data/demo.db')
    })
    await waitFor(() => body().textContent!.includes('orders'))
    expect(body().textContent).toContain('customers')

    // 点表 → 展开列（loadData → selectTable → 拉列+行）
    const title = [...body().querySelectorAll<HTMLElement>('.ant-tree-title')].find(
      (n) => n.textContent === 'orders',
    )!
    expect(title, '表节点存在').toBeTruthy()
    await act(async () => {
      title.click()
    })
    await waitFor(() => body().textContent!.includes('id ·PK'))
    expect(body().textContent).toContain('order_no ·UNIQUE')
    expect(body().textContent).toContain('amount')

    // 绑定信息区：字段数 / 行数
    await waitFor(() => body().textContent!.includes('3 个字段'))
    expect(body().textContent).toContain('重新取数')
    expect(useDataSourceStore.getState().dbColumns.length).toBe(3)
    expect(useDataSourceStore.getState().dbRows.length).toBe(1)
  })

  it('展开后的列节点可直接拖到画布（dragstart 写出 items[].列名）', async () => {
    act(() => {
      root.render(createElement(DatabaseExplorer))
    })
    const sw = body().querySelector<HTMLButtonElement>('.db-explorer-switch .ant-switch')!
    await act(async () => {
      sw.click()
    })
    await waitFor(() => body().textContent!.includes('选择数据库'))
    await act(async () => {
      await useDataSourceStore.getState().selectDatabase('F:/data/demo.db')
    })
    await waitFor(() => body().textContent!.includes('orders'))
    const title = [...body().querySelectorAll<HTMLElement>('.ant-tree-title')].find(
      (n) => n.textContent === 'orders',
    )!
    await act(async () => {
      title.click()
    })
    await waitFor(() => body().textContent!.includes('amount'))

    // 列节点本身可拖：提示语写着「点击表展开字段」，用户会直接拖列名去画布。
    // 早先树节点没有 dragstart，拖了写不进 dataTransfer → 画布收不到 drop（「拖不动」）。
    const col = [...body().querySelectorAll<HTMLElement>('.db-explorer-col')].find(
      (n) => n.textContent === 'amount',
    )
    expect(col, '列节点带 db-explorer-col 标记').toBeTruthy()
    expect(col!.getAttribute('draggable')).toBe('true')
    expect(col!.getAttribute('title')).toContain('items[].amount')

    const written: Record<string, string> = {}
    const dt = {
      types: [] as string[],
      setData(t: string, v: string) {
        written[t] = v
        if (!this.types.includes(t)) this.types.push(t)
      },
      getData: (t: string) => written[t] ?? '',
    }
    const evt = new Event('dragstart', { bubbles: true, cancelable: true })
    ;(evt as Event & { dataTransfer: unknown }).dataTransfer = dt
    await act(async () => {
      col!.dispatchEvent(evt)
    })
    expect(written['application/x-openprint-binding']).toBe('items[].amount')
  })

  it('未连接客户端 → 提示 + 开关禁用', () => {
    useDataSourceStore.setState({ dbAvailable: false })
    act(() => {
      root.render(createElement(DatabaseExplorer))
    })
    expect(body().textContent).toContain('未连接本地打印客户端')
    const sw = body().querySelector<HTMLButtonElement>('.db-explorer-switch .ant-switch')!
    expect(sw.disabled).toBe(true)
  })
})

describe('probe → dataSource 桥', () => {
  beforeEach(() => {
    usePrinterProbeStore.getState().$reset()
    useDataSourceStore.getState().$reset()
    // 固定为示例数据 + 开关关闭：桥触发时不会发起取数请求
    useDataSourceStore.setState({ kind: 'sample', dbEnabled: false })
  })

  it('客户端连接/断开实时同步 dbAvailable', () => {
    const off = connectPrinterToDataSource()
    expect(useDataSourceStore.getState().dbAvailable).toBe(false)

    act(() => {
      usePrinterProbeStore.setState({ state: 'connected' })
    })
    expect(useDataSourceStore.getState().dbAvailable).toBe(true)

    act(() => {
      usePrinterProbeStore.setState({ state: 'disconnected' })
    })
    expect(useDataSourceStore.getState().dbAvailable).toBe(false)

    off()
    act(() => {
      usePrinterProbeStore.setState({ state: 'connected' })
    })
    // 取消订阅后不再联动
    expect(useDataSourceStore.getState().dbAvailable).toBe(false)
  })
})
