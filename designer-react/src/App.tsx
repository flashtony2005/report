/**
 * App —— 顶层三栏布局壳（React 版，对齐 Vue 版 App.vue）
 *
 * TopToolbar / 左栏 250px（组件库/数据源/图层） / 中央画布 / 右栏 300px（属性面板）
 * + 手写签名弹窗。主题：亮 / 暗 / SVIP 三态（html.dark/.svip 类由 ui store 同步，
 * antd 侧用 algorithm 切换亮暗基座）。
 *
 * P6.2 移动端适配：≤900px 时左右面板收进 antd Drawer，画布区两侧浮动按钮唤起；
 * 桌面（>900px）行为与 P6.1 完全一致。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { ConfigProvider, Drawer, theme as antdTheme } from 'antd'
import TopToolbar from './toolbar/TopToolbar'
import LeftPanel from './panels/LeftPanel'
import CanvasStage from './canvas/CanvasStage'
import RightPanel from './panels/RightPanel'
import SignaturePadModal from './panels/SignaturePadModal'
import StatusBar from './statusbar/StatusBar'
import { useUiStore, resolveEffectiveTheme } from './stores/ui'
import { useDesignerStore } from './stores/designer'
import { connectPrinterToDataSource } from './stores/bridge'
import { useIsMobile } from './hooks/useIsNarrow'
// 主题语义变量：直接复用 Vue 项目的 brand.css（经 @ alias，单一来源不复制）
import '@/theme/brand.css'
import 'antd/dist/reset.css'
import './app.css'

export default function App(): ReactElement {
  const themePreference = useUiStore((s) => s.themePreference)
  const systemDark = useUiStore((s) => s.systemDark)
  const rightPanelVisible = useUiStore((s) => s.rightPanelVisible)
  /* 修复（用户报障）：移动端模式 = 窄屏 + 触屏（pointer:coarse）。
     窄窗口 + 鼠标保持桌面三栏布局，画布始终可直接编辑 ——
     此前仅按宽度判断，小窗口/内嵌预览里点控件就弹属性抽屉盖住画布。 */
  const isMobile = useIsMobile()
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false)
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  const effective = resolveEffectiveTheme({ themePreference, systemDark })
  const isDark = effective !== 'light'

  /* P6.4 移动端属性编辑体验：窄屏下选中控件 → 自动弹出属性抽屉；
     取消选中（点空白）→ 自动收起，画布回归全屏可操作。 */
  const selectedCount = useDesignerStore((s) => s.selectedIds.length)
  useEffect(() => {
    if (!isMobile) return
    setRightDrawerOpen(selectedCount > 0)
  }, [isMobile, selectedCount])

  /* P5.1b：打印客户端连接状态 → 数据源 store。
     等价 Vue 版数据源 store 内的 watch(probe.state)：顶栏/弹窗任何一次探测
     的结果都会同步 dbAvailable，决定「启用数据库数据源」开关是否可用。 */
  useEffect(() => connectPrinterToDataSource(), [])

  /* 属性抽屉宽度：小屏按视口比例，避免盖满整屏 */
  const rightDrawerWidth = Math.min(340, Math.max(260, Math.round((typeof window !== 'undefined' ? window.innerWidth : 900) * 0.86)))

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff' },
      }}
    >
      <div className={`app-shell ${effective}${isMobile ? ' is-narrow' : ''}`}>
        <TopToolbar />
        <div className="app-main">
          {/* 桌面：左侧组件库面板常驻；窄屏：抽屉 + 浮动唤起按钮 */}
          {!isMobile && (
            <aside className="app-left">
              <LeftPanel />
            </aside>
          )}
          {/* 中央画布 */}
          <main className="app-canvas">
            <CanvasStage />
            {isMobile && (
              <>
                <button
                  type="button"
                  className="app-fab app-fab-left"
                  aria-label="打开组件面板"
                  data-testid="fab-left"
                  onClick={() => setLeftDrawerOpen(true)}
                >
                  组件
                </button>
                <button
                  type="button"
                  className="app-fab app-fab-right"
                  aria-label="打开属性面板"
                  data-testid="fab-right"
                  onClick={() => setRightDrawerOpen(true)}
                >
                  属性
                </button>
              </>
            )}
          </main>
          {/* 右侧属性面板（桌面常驻，受显示开关控制） */}
          {!isMobile && rightPanelVisible && (
            <aside className="app-right">
              <RightPanel />
            </aside>
          )}
        </div>
        {/* 底部状态栏：模板/选中/页数/网格/边距线/缩放 */}
        <StatusBar />
        {/* 窄屏抽屉（P6.2）：左=组件库，右=属性面板 */}
        {isMobile && (
          <>
            <Drawer
              placement="left"
              open={leftDrawerOpen}
              onClose={() => setLeftDrawerOpen(false)}
              classNames={{ body: 'app-drawer-body', root: 'app-left-drawer' }}
              closeIcon={false}
            >
              <LeftPanel />
            </Drawer>
            <Drawer
              placement="right"
              open={rightDrawerOpen}
              onClose={() => setRightDrawerOpen(false)}
              classNames={{ body: 'app-drawer-body', root: 'app-right-drawer' }}
              closeIcon={false}
              size={rightDrawerWidth}
            >
              <RightPanel />
            </Drawer>
          </>
        )}
        {/* 弹出式手写签名画板（WPS 式） */}
        <SignaturePadModal />
      </div>
    </ConfigProvider>
  )
}
