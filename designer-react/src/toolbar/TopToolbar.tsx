/**
 * TopToolbar —— 顶部工具栏（React 版 / antd，56px）
 *
 * 从 Vue 版 `TopToolbar.vue` 迁移（P5.2）。
 * 共享逻辑（文件菜单 / 快捷键指南数据 / 打印状态灯）见
 * `@/design/toolbar/shared/toolbar-logic`（Vue/React 同源，防漂移）。
 *
 * 结构对齐 Vue 版：
 * 左：Logo / 产品名 / 版本(SVIP 开关) / 文件菜单 / 模板市场 / 流水标签 / 后端模式徽标
 * 中：模板名（可随时编辑）
 * 右：撤销重做 / 主题切换 / 边距参考线 / 预览 / 保存 / 导出 / 打印(状态灯) /
 *     JSON / 快捷键指南 / AI / 设置
 *
 * 尚未迁移的弹窗（模板管理 / 设置 / 市场 / 数据导入 / JSON / 打印 / 流水标签 /
 * AI 助手 / 预览 / 导出）以占位 Modal 呈现，P5.3+ 逐个替换。
 */
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'
import { Button, Dropdown, Input, Modal, Tooltip, message } from 'antd'
import type { MenuProps } from 'antd'
import logoUrl from '@/assets/logo.png'
import { useDesignerStore } from '../stores/designer'
import { useHistoryStore } from '../stores/history'
import { useUiStore, resolveEffectiveTheme } from '../stores/ui'
import { usePrinterProbeStore } from '../stores/printerProbe'
import {
  createDemoTemplate,
  DEMO_TEMPLATE_NAME,
} from '@/repository/mock/data/demo-template'
import { exportTemplateFile, importTemplateFile } from '@/design/utils/template-file'
import { validateTemplate } from '@/core/spec/validator'
import {
  buildShortcutGroups,
  FILE_MENU_ITEMS,
  isMacPlatform,
  modOf,
  printerDotClass,
  printerTooltip,
  type ShortcutPlatform,
} from '@/design/toolbar/shared/toolbar-logic'
import './top-toolbar.css'
import { ExportDialog } from './ExportDialog'
import { PreviewPanel } from '../preview/PreviewPanel'
import { TemplateModal } from '../modals/TemplateModal'
// Univer 体积大且只在打开报表时才需要，故懒加载：避免拖慢首屏，也避免测试环境被它污染
const GridReportModal = lazy(() => import('../modals/GridReportModal'))
import { DataImportModalInner } from '../modals/DataImportModal'
import { SettingsModal } from '../modals/SettingsModal'
import { AiAssistantModal } from '../modals/AiAssistantModal'
import { PrintDialog } from '../modals/PrintDialog'
import { TemplateMarket } from '../modals/TemplateMarket'
import { JsonViewerModal } from '../modals/JsonViewerModal'
import { FlowLabelModal } from '../modals/FlowLabelModal'
import { confirmDialog } from '../ui-confirm'

/** 待迁移弹窗的占位（P5.3+ 逐个替换为真实实现） */
function PlaceholderDialog({
  title,
  open,
  onClose,
}: {
  title: string
  open: boolean
  onClose: () => void
}): ReactElement {
  return (
    <Modal title={title} open={open} onCancel={onClose} footer={null} width={420}>
      <div className="toolbar-placeholder">「{title}」React 版迁移中（P5.3+）</div>
    </Modal>
  )
}

export default function TopToolbar(): ReactElement {
  /* ------------------------------ store 订阅 ------------------------------ */
  const templateName = useDesignerStore((s) => s.templateName)
  const backendMode = useDesignerStore((s) => s.backendMode)
  const canUndo = useHistoryStore((s) => s.undoStack.length > 0)
  const canRedo = useHistoryStore((s) => s.redoStack.length > 0)
  const themePreference = useUiStore((s) => s.themePreference)
  const systemDark = useUiStore((s) => s.systemDark)
  const showMarginGuides = useUiStore((s) => s.showMarginGuides)
  const printerState = usePrinterProbeStore((s) => s.state)
  const printerHealth = usePrinterProbeStore((s) => s.health)
  const printerCount = usePrinterProbeStore((s) => s.printers.length)
  const printerError = usePrinterProbeStore((s) => s.errorText)
  const printerBase = usePrinterProbeStore((s) => s.baseUrl)

  /* ------------------------------ 本地 UI 状态 ------------------------------ */
  const [showTplModal, setShowTplModal] = useState(false)
  const [showGridReport, setShowGridReport] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showMarket, setShowMarket] = useState(false)
  const [showDataImport, setShowDataImport] = useState(false)
  const [showJson, setShowJson] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [showFlowLabel, setShowFlowLabel] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showSaveAs, setShowSaveAs] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [showNewTemplate, setShowNewTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')

  /** 快捷键指南可手动切换的查看平台；默认跟随当前系统 */
  const [platform, setPlatform] = useState<ShortcutPlatform>(isMacPlatform() ? 'mac' : 'win')

  const isDark = resolveEffectiveTheme({ themePreference, systemDark }) !== 'light'
  const isSvip = resolveEffectiveTheme({ themePreference, systemDark }) === 'svip'
  const shortcutGroups = buildShortcutGroups(modOf(platform))

  /* ------------------------------ 副作用 ------------------------------ */

  // 按 ? 打开快捷键指南（输入框内不触发）
  useEffect(() => {
    const onHelpKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '?' && !typing) {
        e.preventDefault()
        setShowShortcuts(true)
      }
    }
    window.addEventListener('keydown', onHelpKey)
    return () => window.removeEventListener('keydown', onHelpKey)
  }, [])

  // 启动后静默自测一次打印机连接（失败不打扰用户）
  useEffect(() => {
    void usePrinterProbeStore.getState().probeIfStale()
  }, [])

  /* ------------------------------ 动作 ------------------------------ */

  const onSave = async (): Promise<void> => {
    // 唯一持久化入口（主任定：编辑纯本地，手动保存才写存储；无后端走 localStorage）
    const result = await useDesignerStore.getState().saveTemplate()
    const mode = useDesignerStore.getState().backendMode
    if (result.ok) {
      void message.success(mode === 'cloud' ? '模板已保存到云端' : '模板已保存到本地存储')
    } else {
      void message.error(`保存失败：${result.error}`)
    }
  }

  const onExportTemplate = (): void => {
    const s = useDesignerStore.getState()
    const data = s.buildTemplate()
    const res = validateTemplate(data)
    if (!res.valid) {
      void message.error(`模板校验未通过，无法导出：${res.issues.map((i) => i.message).join('；')}`)
      return
    }
    exportTemplateFile(data, s.templateName)
    void message.success(`已导出：${s.templateName}.json`)
  }

  const onImportTemplate = async (): Promise<void> => {
    const data = await importTemplateFile()
    if (!data) {
      void message.warning('未选择文件或文件读取失败')
      return
    }
    const res = validateTemplate(data)
    if (!res.valid) {
      void message.error(`文件不是有效的模板：${res.issues.map((i) => i.message).join('；')}`)
      return
    }
    const s = useDesignerStore.getState()
    if (s.dirty && !(await confirmDialog('导入将覆盖当前未保存的改动。确定继续？'))) return
    const name = (data as { name?: string }).name || s.templateName || '导入的模板'
    useDesignerStore.getState().loadTemplate({ id: `import-${Date.now()}`, name, data })
    void message.success(`已导入：${name}`)
  }

  const onFileSelect = async (key: string): Promise<void> => {
    const s = useDesignerStore.getState()
    if (key === 'new') {
      if (s.dirty && !(await confirmDialog('当前模板有未保存改动，新建将清空画布。确定继续？')))
        return
      setNewTemplateName('未命名模板')
      setShowNewTemplate(true)
    } else if (key === 'open') {
      setShowTplModal(true)
    } else if (key === 'save') {
      void onSave()
    } else if (key === 'saveAs') {
      setSaveAsName(`${s.templateName} 副本`)
      setShowSaveAs(true)
    } else if (key === 'demo') {
      if (s.dirty && !(await confirmDialog('载入示例模板将覆盖当前未保存的改动。确定继续？')))
        return
      useDesignerStore
        .getState()
        .loadTemplate({ id: 'demo', name: DEMO_TEMPLATE_NAME, data: createDemoTemplate() })
      void message.success(`已载入示例：${DEMO_TEMPLATE_NAME}`)
    } else if (key === 'importTpl') {
      void onImportTemplate()
    } else if (key === 'exportTpl') {
      onExportTemplate()
    } else if (key === 'importData') {
      setShowDataImport(true)
    }
  }

  const confirmNewTemplate = (): void => {
    const name = newTemplateName.trim()
    if (!name) {
      void message.warning('请输入模板名称')
      return
    }
    setShowNewTemplate(false)
    useDesignerStore.getState().newBlankTemplate()
    useDesignerStore.getState().renameTemplate(name, false)
    void message.success(`已新建：${name}`)
  }

  const confirmSaveAs = async (): Promise<void> => {
    const name = saveAsName.trim()
    if (!name) {
      void message.warning('请输入模板名称')
      return
    }
    setShowSaveAs(false)
    const result = await useDesignerStore.getState().saveTemplateAs(name)
    if (result.ok) void message.success(`已另存为：${name}`)
    else void message.error(`另存为失败：${result.error}`)
  }

  const onPrintClick = async (): Promise<void> => {
    setShowPrint(true)
    const ok = await usePrinterProbeStore.getState().probe()
    const st = usePrinterProbeStore.getState()
    if (ok) {
      void message.success(
        `打印客户端已连接：${st.health?.app ?? 'OpenPrint'} v${st.health?.version ?? '?'} · ${
          st.printers.length
        } 台打印机`,
      )
    } else {
      void message.warning(`打印客户端不可达：${st.errorText}`)
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const fileMenuItems: MenuProps['items'] = FILE_MENU_ITEMS.map((item) =>
    item.divider ? { type: 'divider', key: item.key } : { label: item.label, key: item.key },
  )

  return (
    <header className={`toolbar-root ${isDark ? 'dark' : 'light'}`}>
      {/* 左：品牌 + 文件菜单 + 后端模式徽标 */}
      <div className="toolbar-left">
        <div className="logo-circle">
          <img src={logoUrl} alt="OpenPrint" className="logo-img" />
        </div>
        <span className="product-name">OpenPrint</span>
        <Tooltip title={isSvip ? 'SVIP 黑金主题 · 点击退出' : '点击切换 SVIP 黑金主题'}>
          <span
            className={`version-tag${isSvip ? ' is-svip' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => useUiStore.getState().toggleSvip()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') useUiStore.getState().toggleSvip()
            }}
          >
            {isSvip ? 'SVIP' : 'v2.0.0'}
          </span>
        </Tooltip>

        <Dropdown menu={{ items: fileMenuItems, onClick: ({ key }) => void onFileSelect(key) }}>
          <span className="file-menu-trigger" data-testid="file-menu">
            <span>文件</span>
            <span className="file-menu-caret">▾</span>
          </span>
        </Dropdown>

        <Button
          size="small"
          variant="outlined"
          className="toolbar-ghost-btn"
          onClick={() => setShowMarket(true)}
        >
          模板市场
        </Button>

        <Button
          size="small"
          variant="outlined"
          className="toolbar-ghost-btn"
          data-testid="btn-grid-report"
          onClick={() => setShowGridReport(true)}
        >
          网格报表
        </Button>

        <Button
          size="small"
          variant="outlined"
          className="toolbar-ghost-btn"
          onClick={() => useUiStore.getState().setFlowLabelOpen(true)}
        >
          流水标签
        </Button>

        <Tooltip
          title={
            backendMode === 'cloud'
              ? '已接入后端接口（VITE_OPENPRINT_API_BASE）'
              : '未配置后端，使用本地存储 / 内置 Mock 数据源（主任铁律）'
          }
        >
          <span className={`backend-tag ${backendMode === 'cloud' ? 'is-cloud' : 'is-local'}`}>
            {backendMode === 'cloud' ? '云端' : '本地存储'}
          </span>
        </Tooltip>
      </div>

      {/* 中：模板名（可随时编辑） */}
      <div className="toolbar-center">
        <Input
          size="small"
          value={templateName}
          placeholder="请输入模板名称"
          variant="borderless"
          className="tpl-name-input"
          onChange={(e) => useDesignerStore.getState().renameTemplate(e.target.value)}
        />
      </div>

      {/* 右：操作区 */}
      <div className="toolbar-right">
        <Tooltip title="撤销（Ctrl+Z）">
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="撤销"
            disabled={!canUndo}
            onClick={() => useDesignerStore.getState().undo()}
          >
            ↶
          </Button>
        </Tooltip>
        <Tooltip title="重做（Ctrl+Shift+Z）">
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="重做"
            disabled={!canRedo}
            onClick={() => useDesignerStore.getState().redo()}
          >
            ↷
          </Button>
        </Tooltip>

        <div className="toolbar-sep" />

        <Tooltip
          title={isDark ? '当前深色，点击切浅色' : '当前浅色，点击切深色'}
        >
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="切换主题"
            onClick={() => useUiStore.getState().toggleTheme()}
          >
            {isDark ? '☀' : '☾'}
          </Button>
        </Tooltip>

        <div className="toolbar-sep" />

        <Tooltip title={`页边距参考线：${showMarginGuides ? '显示中' : '已隐藏'}`}>
          <Button
            type={showMarginGuides ? 'primary' : 'text'}
            size="small"
            className="toolbar-icon-btn"
            aria-label="页边距参考线"
            data-narrow-hide
            onClick={() => useUiStore.getState().toggleMarginGuides()}
          >
            ▦
          </Button>
        </Tooltip>

        <div className="toolbar-sep" />

        <Button size="small" variant="outlined" className="toolbar-ghost-btn" onClick={() => useUiStore.getState().setPreviewOpen(true)}>
          预览
        </Button>
        <Button size="small" type="primary" onClick={() => void onSave()}>
          保存
        </Button>
        <Button size="small" variant="outlined" className="toolbar-ghost-btn" onClick={() => useUiStore.getState().setExportOpen(true)}>
          导出
        </Button>

        <Tooltip title={printerTooltip(printerState, {
          app: printerHealth?.app,
          version: printerHealth?.version,
          printerCount,
          errorText: printerError,
          baseUrl: printerBase,
        })}>
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn printer-btn"
            aria-label="打印"
            onClick={() => void onPrintClick()}
          >
            ⎙
            <span className={`printer-dot ${printerDotClass(printerState)}`} />
          </Button>
        </Tooltip>

        <Tooltip title="查看画布 JSON">
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="查看画布 JSON"
            data-narrow-hide
            onClick={() => setShowJson(true)}
          >
            {'</>'}
          </Button>
        </Tooltip>

        <Tooltip title="快捷键指南（?）">
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="快捷键指南"
            data-narrow-hide
            onClick={() => setShowShortcuts(true)}
          >
            ⌨
          </Button>
        </Tooltip>

        <Tooltip title="AI 设计助手">
          <Button
            type="text"
            size="small"
            className="toolbar-icon-btn"
            aria-label="AI 设计助手"
            onClick={() => setShowAi(true)}
          >
            ✦
          </Button>
        </Tooltip>

        <div className="toolbar-sep" />

        <Button
          type="text"
          size="small"
          className="toolbar-icon-btn"
          aria-label="设置"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </Button>
      </div>

      {/* P5.5 真实现弹窗 */}
      <TemplateModal open={showTplModal} onClose={() => setShowTplModal(false)} />
      {showGridReport && (
        <Suspense fallback={null}>
          <GridReportModal open onClose={() => setShowGridReport(false)} />
        </Suspense>
      )}
      <TemplateMarket open={showMarket} onClose={() => setShowMarket(false)} />
      <JsonViewerModal open={showJson} onClose={() => setShowJson(false)} />

      {/* 预览 / 导出（P5.4 真实现） */}
      <PreviewPanel />
      <ExportDialog />

      {/* 其余待迁移弹窗占位（P5.5+ 替换） */}
      <SettingsModal show={showSettings} onClose={() => setShowSettings(false)} />
      <DataImportModalInner show={showDataImport} onClose={() => setShowDataImport(false)} />
      <PrintDialog show={showPrint} onClose={() => setShowPrint(false)} />
      {/* P5.8 真实现：流水标签批量打印（状态在 ui store，与预览/导出一致） */}
      <FlowLabelModal />
      <AiAssistantModal
        show={showAi}
        onClose={() => setShowAi(false)}
        onOpenSettings={() => {
          setShowAi(false)
          setShowSettings(true)
        }}
      />

      {/* 快捷键指南弹窗 */}
      <Modal
        title="快捷键指南"
        open={showShortcuts}
        onCancel={() => setShowShortcuts(false)}
        footer={null}
        width={560}
      >
        <div className="shortcuts-platform-toggle">
          <button
            type="button"
            className={`platform-tab${platform === 'mac' ? ' active' : ''}`}
            onClick={() => setPlatform('mac')}
          >
            macOS
          </button>
          <button
            type="button"
            className={`platform-tab${platform === 'win' ? ' active' : ''}`}
            onClick={() => setPlatform('win')}
          >
            Windows
          </button>
        </div>
        <div className="shortcuts-body">
          {shortcutGroups.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h4 className="shortcuts-group-title">{group.title}</h4>
              <ul className="shortcuts-list">
                {group.items.map((item, i) => (
                  <li key={i} className="shortcuts-row">
                    <span className="shortcuts-keys">
                      {item.keys.map((k, ki) => (
                        <span key={ki}>
                          <kbd className="kbd">{k}</kbd>
                          {ki < item.keys.length - 1 && <span className="kbd-plus">+</span>}
                        </span>
                      ))}
                    </span>
                    <span className="shortcuts-desc">
                      {item.desc}
                      {item.hint && <span className="shortcuts-hint">（{item.hint}）</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="shortcuts-foot">
            提示：在画布任意处按 <kbd className="kbd">?</kbd> 可随时唤起本指南。
          </p>
        </div>
      </Modal>

      {/* 另存为弹窗 */}
      <Modal
        title="另存为"
        open={showSaveAs}
        onCancel={() => setShowSaveAs(false)}
        width={420}
        footer={
          <div className="modal-footer">
            <Button size="small" onClick={() => setShowSaveAs(false)}>
              取消
            </Button>
            <Button size="small" type="primary" onClick={() => void confirmSaveAs()}>
              保存副本
            </Button>
          </div>
        }
      >
        <div className="modal-body">
          <div className="modal-hint">将以新名称保存一份独立副本。</div>
          <Input
            value={saveAsName}
            placeholder="请输入模板名称"
            onChange={(e) => setSaveAsName(e.target.value)}
            onPressEnter={() => void confirmSaveAs()}
          />
        </div>
      </Modal>

      {/* 新建模板弹窗 */}
      <Modal
        title="新建模板"
        open={showNewTemplate}
        onCancel={() => setShowNewTemplate(false)}
        width={420}
        footer={
          <div className="modal-footer">
            <Button size="small" onClick={() => setShowNewTemplate(false)}>
              取消
            </Button>
            <Button size="small" type="primary" onClick={confirmNewTemplate}>
              创建
            </Button>
          </div>
        }
      >
        <div className="modal-body">
          <div className="modal-hint">请输入模板名称，创建空白画布。</div>
          <Input
            value={newTemplateName}
            placeholder="请输入模板名称"
            onChange={(e) => setNewTemplateName(e.target.value)}
            onPressEnter={confirmNewTemplate}
          />
        </div>
      </Modal>
    </header>
  )
}
