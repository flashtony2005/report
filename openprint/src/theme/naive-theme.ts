/**
 * Naive UI 主题覆盖 —— 亮/暗双模式统一品牌色
 *
 * 设计原则：
 * 1. 品牌蓝 #1677FF → 衍生 5/3/1 个色阶（primary/primaryHover/primaryPressed…）
 * 2. 信息色在暗色下提高明度 & 不透明度，保证对比度
 * 3. 顶栏（56px Toolbar）在亮色下也用"深导航"配色，保证与 App 视觉一致；
 *    同时 Naive UI 内部组件（Dropdown/Modal/Select/Popover）随 NConfigProvider 主题生效
 * 4. common 字段 7 色阶 + 字体大小/圆角统一，其他组件按需要微调
 */
import type { GlobalThemeOverrides } from 'naive-ui'

/* ============================= 品牌色常量 ============================= */

const PRIMARY = '#1677FF'
const PRIMARY_HOVER = '#4096FF'
const PRIMARY_PRESSED = '#0958D9'
const PRIMARY_SUPPL = '#69B1FF'
const PRIMARY_FADE = '#E6F4FF'
const PRIMARY_FADE_HOVER = '#BAE0FF'

/* ------------------------- 浅色背景 · 文字 --------------------------- */

const LIGHT_BG = '#F5F7FA'        // 画布外围背景
const LIGHT_SURFACE = '#FFFFFF'   // 面板表面
const LIGHT_BORDER = '#E5E7EB'    // 分隔线
const LIGHT_TEXT_1 = '#1F2329'
const LIGHT_TEXT_2 = '#4B5563'
const LIGHT_TEXT_3 = '#86909C'
const LIGHT_PLACEHOLDER = '#A0A7B1'
const LIGHT_DISABLED = '#C9CDD4'
const LIGHT_INFO = '#374151'      // 灰-600，用于 quaternary 按钮在深色顶栏上

/* ------------------------- 深色背景 · 文字 --------------------------- */

const DARK_BG = '#0B0D12'
const DARK_SURFACE = '#171A21'
const DARK_BORDER = '#2A2F3A'
const DARK_TEXT_1 = '#FFFFFF'
const DARK_TEXT_2 = '#AFB4BD'
const DARK_TEXT_3 = '#7A808C'
const DARK_PLACEHOLDER = '#5F6673'
const DARK_DISABLED = '#3A3F4A'

/* 暗色下品牌色：稍微调亮，避免低对比 */
const DARK_PRIMARY = '#3C8DFF'
const DARK_PRIMARY_HOVER = '#5FA1FF'
const DARK_PRIMARY_PRESSED = '#1B65D4'
const DARK_PRIMARY_SUPPL = '#8DBFFF'
const DARK_PRIMARY_FADE = '#0D2B58'
const DARK_PRIMARY_FADE_HOVER = '#163A74'

/* ============================== 主题导出 ============================== */

/** 通用色阶：保证 common 所有 token 都有值，避免 [seemly/rgba] undefined 报错 */
function buildCommon(dark: false): GlobalThemeOverrides['common'] {
  return {
    // 背景
    bodyColor: LIGHT_BG,
    modalColor: LIGHT_SURFACE,
    popoverColor: LIGHT_SURFACE,
    cardColor: LIGHT_SURFACE,
    tableColor: LIGHT_SURFACE,
    codeColor: '#F3F4F6',
    // 边框/分割
    borderColor: LIGHT_BORDER,
    borderColorStrong: '#D1D5DB',
    dividerColor: LIGHT_BORDER,
    // 文字
    textColorBase: LIGHT_TEXT_1,
    textColor1: LIGHT_TEXT_1,
    textColor2: LIGHT_TEXT_2,
    textColor3: LIGHT_TEXT_3,
    placeholderColor: LIGHT_PLACEHOLDER,
    placeholderColorDisabled: LIGHT_DISABLED,
    // 主色
    primaryColor: PRIMARY,
    primaryColorHover: PRIMARY_HOVER,
    primaryColorPressed: PRIMARY_PRESSED,
    primaryColorSuppl: PRIMARY_SUPPL,
    // 主色淡色
    primaryColorFaded: PRIMARY_FADE,
    primaryColorFadedHover: PRIMARY_FADE_HOVER,
    // 功能色
    infoColor: '#0B78CE',
    infoColorHover: '#1D91E8',
    infoColorPressed: '#075BA0',
    infoColorSuppl: '#36A3F7',
    infoColorFaded: '#E2F2FF',
    successColor: '#18A058',
    successColorHover: '#36AD6A',
    successColorPressed: '#0C7A43',
    successColorSuppl: '#58CA86',
    successColorFaded: '#D8F5E3',
    warningColor: '#F0A020',
    warningColorHover: '#F5B340',
    warningColorPressed: '#C87F10',
    warningColorSuppl: '#FFBE58',
    warningColorFaded: '#FFF4D9',
    errorColor: '#D03050',
    errorColorHover: '#DE576D',
    errorColorPressed: '#A81C38',
    errorColorSuppl: '#FF6C88',
    errorColorFaded: '#FBE3E8',
    // 控件态
    invertedColor: '#20242B',
    closeIconColor: LIGHT_TEXT_2,
    closeIconColorHover: LIGHT_TEXT_1,
    closeIconColorPressed: LIGHT_TEXT_3,
    closeColorHover: '#F3F4F6',
    closeColorPressed: '#E5E7EB',
    clearColor: LIGHT_TEXT_3,
    clearColorHover: LIGHT_TEXT_2,
    tabColor: LIGHT_SURFACE,
    headerColor: '#FAFBFC',
    scrollbarColor: 'rgba(0, 0, 0, 0.25)',
    scrollbarColorHover: 'rgba(0, 0, 0, 0.4)',
    progressRailColor: '#F0F2F5',
    railColor: '#F0F2F5',
    // 字体
    fontFamily: `Inter, 'Source Han Sans CN', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif`,
    fontFamilyMono: `"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontSizeHuge: '16px',
    // 圆角 / 线宽
    borderRadiusSmall: '4px',
    borderRadius: '6px',
    borderRadiusMedium: '8px',
    borderRadiusLarge: '12px',
    lineWidth: '1px',
    lineHeight: '1.57',
    cubicBezierEaseInOut: 'cubic-bezier(.4, 0, .2, 1)',
    cubicBezierEaseOut: 'cubic-bezier(0, 0, .2, 1)',
    cubicBezierEaseIn: 'cubic-bezier(.4, 0, 1, 1)',
    // 信息框/标签等额外 common token（显式覆盖，避免 undefined）
    tagColorCheckableDefault: '#F3F4F6',
    tagTextColorCheckableDefault: LIGHT_TEXT_2,
  } as NonNullable<GlobalThemeOverrides['common']>
}

function buildCommonDark(): GlobalThemeOverrides['common'] {
  return {
    // 背景
    bodyColor: DARK_BG,
    modalColor: DARK_SURFACE,
    popoverColor: DARK_SURFACE,
    cardColor: DARK_SURFACE,
    tableColor: DARK_SURFACE,
    codeColor: '#22262F',
    // 边框/分割
    borderColor: DARK_BORDER,
    borderColorStrong: '#3A3F4A',
    dividerColor: DARK_BORDER,
    // 文字
    textColorBase: DARK_TEXT_1,
    textColor1: DARK_TEXT_1,
    textColor2: DARK_TEXT_2,
    textColor3: DARK_TEXT_3,
    placeholderColor: DARK_PLACEHOLDER,
    placeholderColorDisabled: DARK_DISABLED,
    // 主色（暗下调亮）
    primaryColor: DARK_PRIMARY,
    primaryColorHover: DARK_PRIMARY_HOVER,
    primaryColorPressed: DARK_PRIMARY_PRESSED,
    primaryColorSuppl: DARK_PRIMARY_SUPPL,
    primaryColorFaded: DARK_PRIMARY_FADE,
    primaryColorFadedHover: DARK_PRIMARY_FADE_HOVER,
    // 功能色
    infoColor: '#2D8CFF',
    infoColorHover: '#55A3FF',
    infoColorPressed: '#1F6FD4',
    infoColorSuppl: '#7FB8FF',
    infoColorFaded: '#112A4E',
    successColor: '#25C26A',
    successColorHover: '#47CF81',
    successColorPressed: '#169B54',
    successColorSuppl: '#77DC9F',
    successColorFaded: '#0F3A27',
    warningColor: '#F5A524',
    warningColorHover: '#F8B850',
    warningColorPressed: '#C87F0E',
    warningColorSuppl: '#FFCF6E',
    warningColorFaded: '#3F2B0A',
    errorColor: '#DE4B67',
    errorColorHover: '#E77085',
    errorColorPressed: '#B62F47',
    errorColorSuppl: '#FF8EA0',
    errorColorFaded: '#3F1320',
    // 控件态
    invertedColor: '#000000',
    closeIconColor: DARK_TEXT_2,
    closeIconColorHover: DARK_TEXT_1,
    closeIconColorPressed: DARK_TEXT_3,
    closeColorHover: 'rgba(255,255,255,0.08)',
    closeColorPressed: 'rgba(255,255,255,0.05)',
    clearColor: DARK_TEXT_3,
    clearColorHover: DARK_TEXT_2,
    tabColor: DARK_SURFACE,
    headerColor: '#1F242D',
    scrollbarColor: 'rgba(255, 255, 255, 0.25)',
    scrollbarColorHover: 'rgba(255, 255, 255, 0.4)',
    progressRailColor: '#2A2F3A',
    railColor: '#2A2F3A',
    // 字体（与亮色一致）
    fontFamily: `Inter, 'Source Han Sans CN', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, sans-serif`,
    fontFamilyMono: `"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontSizeHuge: '16px',
    // 圆角 / 线宽
    borderRadiusSmall: '4px',
    borderRadius: '6px',
    borderRadiusMedium: '8px',
    borderRadiusLarge: '12px',
    lineWidth: '1px',
    lineHeight: '1.57',
    cubicBezierEaseInOut: 'cubic-bezier(.4, 0, .2, 1)',
    cubicBezierEaseOut: 'cubic-bezier(0, 0, .2, 1)',
    cubicBezierEaseIn: 'cubic-bezier(.4, 0, 1, 1)',
    tagColorCheckableDefault: '#242831',
    tagTextColorCheckableDefault: DARK_TEXT_2,
  } as NonNullable<GlobalThemeOverrides['common']>
}

/* ============================ 组件级覆盖 ============================ */

/** 亮色下重点组件的一致性微调 */
const lightComponents: Pick<
  GlobalThemeOverrides,
  | 'Button'
  | 'Input'
  | 'Dropdown'
  | 'Modal'
  | 'Tooltip'
  | 'Select'
  | 'Popconfirm'
  | 'Drawer'
  | 'DataTable'
  | 'Form'
> = {
  Button: {
    heightSmall: '28px',
    heightMedium: '32px',
    heightLarge: '36px',
    // ghost 在深色顶栏上不会被 naive-ui 的 darkTheme 生效（顶栏自己是深色，但 body 是亮色）
    // 但我们把 ghost/quaternary 的文字色交回组件自行覆盖（见 TopToolbar）
  },
  Dropdown: {
    borderRadius: '6px',
    optionHeightMedium: '32px',
  },
  Modal: {
    borderRadius: '10px',
  },
  Tooltip: {
    borderRadius: '6px',
  },
  Select: {
    peers: {
      InternalSelection: { heightMedium: '32px', borderRadius: '6px' },
      // 下拉菜单：亮色下显式钉死表面背景 + 语义文字色，
      // 避免 portal 到 body 后主题 token 未生效导致「浅灰背景 + 白字」不可读。
      InternalSelectMenu: {
        borderRadius: '6px',
        color: LIGHT_SURFACE,
        optionTextColor: LIGHT_TEXT_1,
        optionTextColorActive: PRIMARY,
        optionTextColorPressed: PRIMARY_PRESSED,
        optionTextColorDisabled: LIGHT_TEXT_3,
        optionColorPending: 'rgba(0, 0, 0, 0.04)',
        optionColorActive: 'rgba(0, 0, 0, 0.06)',
      },
    },
  },
  Popconfirm: {
    borderRadius: '8px',
  },
  Drawer: {
    borderRadius: '10px',
  },
  DataTable: {
    borderRadius: '6px',
    peers: {
      Empty: { textColor: LIGHT_TEXT_3 },
      Pagination: { itemTextColor: LIGHT_TEXT_2 },
    },
  },
  Form: {
    labelTextColor: LIGHT_TEXT_2,
    asteriskColor: '#D03050',
  },
}

/** 暗色下重点组件的一致性微调 */
const darkComponents: Pick<
  GlobalThemeOverrides,
  | 'Button'
  | 'Input'
  | 'Dropdown'
  | 'Modal'
  | 'Tooltip'
  | 'Select'
  | 'Popconfirm'
  | 'Drawer'
  | 'DataTable'
  | 'Form'
> = {
  Button: {
    heightSmall: '28px',
    heightMedium: '32px',
    heightLarge: '36px',
    // 暗色下 ghost/quaternary 背景透明，文字用 textColor1（#FFFFFF）保证可读
    colorGhost: 'transparent',
    textColorGhost: DARK_TEXT_1,
    colorGhostHover: 'rgba(255,255,255,0.06)',
    colorGhostPressed: 'rgba(255,255,255,0.04)',
    colorQuaternary: 'transparent',
    textColorQuaternary: DARK_TEXT_1,
    colorQuaternaryHover: 'rgba(255,255,255,0.06)',
    colorQuaternaryPressed: 'rgba(255,255,255,0.04)',
  },
  Input: {
    borderHover: '#3F4555',
    borderFocus: DARK_PRIMARY_HOVER,
  },
  Dropdown: {
    borderRadius: '6px',
    optionHeightMedium: '32px',
    colorOptionHover: 'rgba(255,255,255,0.06)',
  },
  Modal: {
    borderRadius: '10px',
    boxShadow: '0 20px 60px -10px rgba(0,0,0,0.7)',
  },
  Tooltip: {
    borderRadius: '6px',
  },
  Select: {
    peers: {
      InternalSelection: { heightMedium: '32px', borderRadius: '6px' },
      // 下拉菜单：暗色下显式钉死表面背景 + 语义文字色（白字/主色），
      // 避免 portal 到 body 后主题 token 未生效导致「浅灰背景 + 白字」不可读。
      InternalSelectMenu: {
        borderRadius: '6px',
        color: DARK_SURFACE,
        optionTextColor: DARK_TEXT_1,
        optionTextColorActive: DARK_PRIMARY,
        optionTextColorPressed: DARK_PRIMARY_PRESSED,
        optionTextColorDisabled: DARK_TEXT_3,
        optionColorPending: 'rgba(255, 255, 255, 0.06)',
        optionColorActive: 'rgba(255, 255, 255, 0.1)',
      },
    },
  },
  Popconfirm: {
    borderRadius: '8px',
  },
  Drawer: {
    borderRadius: '10px',
  },
  DataTable: {
    borderRadius: '6px',
    tdColorStriped: 'rgba(255,255,255,0.02)',
    thColor: '#1F242D',
    peers: {
      Empty: { textColor: DARK_TEXT_3 },
      Pagination: { itemTextColor: DARK_TEXT_2 },
    },
  },
  Form: {
    labelTextColor: DARK_TEXT_2,
    asteriskColor: '#DE4B67',
  },
}

/* ================================ 公共导出 ================================ */

export const lightThemeOverrides: GlobalThemeOverrides = {
  common: buildCommon(false),
  ...lightComponents,
}

export const darkThemeOverrides: GlobalThemeOverrides = {
  common: buildCommonDark(),
  ...darkComponents,
}

/* ============================== SVIP 黑金主题 ==============================
 * 黑金 = 暗色基座 + 金色覆盖：背景 #3E4144、金色渐变主色
 * （#FFB95A → #E4A93C → #B87100）、小灰字 #C0C4CC。
 * NConfigProvider.theme 用 darkTheme（黑金属于深色系），仅 themeOverrides 替换。
 * ========================================================================= */

const SVIP_PRIMARY = '#E4A93C'
const SVIP_PRIMARY_HOVER = '#FFB95A'
const SVIP_PRIMARY_PRESSED = '#B87100'
const SVIP_PRIMARY_SUPPL = '#FFCF6E'
const SVIP_PRIMARY_FADE = '#3A3423'
const SVIP_PRIMARY_FADE_HOVER = '#4A3F28'

/** SVIP：基于暗色 common 的覆盖（背景/文字/主色全换黑金色系） */
export const svipThemeOverrides: GlobalThemeOverrides = {
  common: {
    ...buildCommonDark(),
    // 背景：用户指定 #3E4144；表面略亮形成层次
    bodyColor: '#3E4144',
    modalColor: '#484C50',
    popoverColor: '#484C50',
    cardColor: '#484C50',
    tableColor: '#484C50',
    codeColor: '#3A3D40',
    headerColor: '#3A3D40',
    // 边框
    borderColor: '#585C61',
    borderColorStrong: '#6A6E73',
    dividerColor: '#585C61',
    // 文字：主文字暖金白 / 小灰字 #C0C4CC
    textColorBase: '#F2E6C9',
    textColor1: '#F2E6C9',
    textColor2: '#C0C4CC',
    textColor3: '#9AA0A6',
    placeholderColor: '#9AA0A6',
    placeholderColorDisabled: '#6E7378',
    // 主色：金色系
    primaryColor: SVIP_PRIMARY,
    primaryColorHover: SVIP_PRIMARY_HOVER,
    primaryColorPressed: SVIP_PRIMARY_PRESSED,
    primaryColorSuppl: SVIP_PRIMARY_SUPPL,
    primaryColorFaded: SVIP_PRIMARY_FADE,
    primaryColorFadedHover: SVIP_PRIMARY_FADE_HOVER,
    // 控件态
    invertedColor: '#2B2E31',
    tabColor: '#484C50',
    progressRailColor: '#585C61',
    railColor: '#585C61',
    tagColorCheckableDefault: '#3A3D40',
    tagTextColorCheckableDefault: '#C0C4CC',
  } as NonNullable<GlobalThemeOverrides['common']>,
  ...darkComponents,
  // 黑金组件级微调：portal 场景（下拉菜单）与表格表头也换黑金表面色
  Select: {
    ...darkComponents.Select,
    peers: {
      ...darkComponents.Select?.peers,
      InternalSelectMenu: {
        ...darkComponents.Select?.peers?.InternalSelectMenu,
        color: '#484C50',
        optionTextColorActive: SVIP_PRIMARY,
        optionTextColorPressed: SVIP_PRIMARY_PRESSED,
      },
    },
  },
  DataTable: {
    ...darkComponents.DataTable,
    thColor: '#3A3D40',
  },
}

/** 语义化 CSS 变量（同步到 :root / html.dark，供 uno.config 与 scoped CSS 使用） */
export const themeCssVars = {
  light: {
    '--brand-primary': PRIMARY,
    '--brand-bg': LIGHT_BG,
    '--brand-surface': LIGHT_SURFACE,
    '--brand-border': LIGHT_BORDER,
    '--brand-text-1': LIGHT_TEXT_1,
    '--brand-text-2': LIGHT_TEXT_2,
    '--brand-text-3': LIGHT_TEXT_3,
    /** 顶栏跟随主题：亮色下用白色表面 + 深色文字 */
    '--brand-nav-bg': LIGHT_SURFACE,
    '--brand-nav-bg-hover': 'rgba(0,0,0,0.04)',
    '--brand-nav-text': LIGHT_TEXT_1,
    '--brand-nav-text-muted': LIGHT_TEXT_3,
    '--brand-nav-text-active': LIGHT_TEXT_1,
    '--brand-nav-icon': LIGHT_TEXT_2,
    '--brand-nav-icon-hover': LIGHT_TEXT_1,
  },
  dark: {
    '--brand-primary': DARK_PRIMARY,
    '--brand-bg': DARK_BG,
    '--brand-surface': DARK_SURFACE,
    '--brand-border': DARK_BORDER,
    '--brand-text-1': DARK_TEXT_1,
    '--brand-text-2': DARK_TEXT_2,
    '--brand-text-3': DARK_TEXT_3,
    /** 顶栏 · 暗色下用深色背景 + 白色文字/图标 */
    '--brand-nav-bg': '#0F1116',
    '--brand-nav-bg-hover': 'rgba(255,255,255,0.08)',
    '--brand-nav-text': '#FFFFFF',
    '--brand-nav-text-muted': '#9CA3AF',
    '--brand-nav-text-active': '#FFFFFF',
    '--brand-nav-icon': '#FFFFFF',
    '--brand-nav-icon-hover': '#FFFFFF',
  },
} as const
