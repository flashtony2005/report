import { defineConfig, presetWind4, presetIcons } from 'unocss'

/**
 * unocss 品牌色 —— 取 main.css 中的 CSS 变量（随亮暗主题自动切换）
 * 这样：<div class="bg-brand-primary text-brand-text-1 border-brand-border"> 即与主题联动
 *
 * 注意：uno.config 在 build 时解析；theme.colors 必须是具体字符串，
 * 因此我们把颜色指向 CSS 变量的 `var(...)` 形式——浏览器渲染时会取到对应主题的值。
 */
export default defineConfig({
  presets: [
    presetWind4({
      darkMode: 'class', // html.dark → 与 naive-ui darkTheme 同 class
    }),
    presetIcons({ scale: 1.2, warn: true }),
  ],
  /**
   * 图标安全清单：CellToolbar 等处的对齐/垂直对齐图标用 `` `i-carbon-xxx-${v}` `` 模板字面量
   * 在运行期拼接，UnoCSS 的静态扫描看不到完整类名，故必须显式列入 safelist 才会生成图标 CSS，
   * 否则对应按钮图标空白（看不见）。这里集中登记所有「动态拼接」的 carbon 图标。
   */
  safelist: [
    'i-carbon-text-align-left',
    'i-carbon-text-align-center',
    'i-carbon-text-align-right',
    'i-carbon-align-vertical-top',
    'i-carbon-align-vertical-center',
    'i-carbon-align-vertical-bottom',
    'i-carbon-text-color',
    'i-carbon-paint-brush',
    'i-carbon-color-palette',
    'i-carbon-clean',
    'i-carbon-close',
  ],
  theme: {
    colors: {
      brand: {
        primary: 'var(--brand-primary)',
        'primary-hover': 'var(--brand-primary-hover)',
        'primary-pressed': 'var(--brand-primary-pressed)',
        dark: 'var(--brand-nav-bg)',
        bg: 'var(--brand-bg)',
        surface: 'var(--brand-surface)',
        border: 'var(--brand-border)',
        'text-1': 'var(--brand-text-1)',
        'text-2': 'var(--brand-text-2)',
        'text-3': 'var(--brand-text-3)',
        muted: 'var(--brand-text-muted)',
        nav: {
          DEFAULT: 'var(--brand-nav-bg)',
          hover: 'var(--brand-nav-bg-hover)',
          text: 'var(--brand-nav-text)',
          'text-muted': 'var(--brand-nav-text-muted)',
          'text-active': 'var(--brand-nav-text-active)',
          icon: 'var(--brand-nav-icon)',
          'icon-hover': 'var(--brand-nav-icon-hover)',
        },
      },
    },
  },
  variants: [],
})
