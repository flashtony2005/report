import { defineConfig, presetWind4 } from 'unocss'

/**
 * React 版 UnoCSS 配置 —— 与 Vue 版 `openprint/uno.config.ts` 保持同源语义：
 * 同为 presetWind4 + darkMode:'class'（html.dark），品牌色指向同一批 CSS 变量
 * （brand.css 经 @ alias 引入，亮暗主题自动联动）。
 *
 * 差异说明：React 端未使用 presetIcons（无 i-carbon-* 图标类，图标走 antd/svg）。
 */
export default defineConfig({
  presets: [presetWind4({ darkMode: 'class' })],
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
