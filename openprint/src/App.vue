<script setup lang="ts">
/**
 * App —— 顶层三栏布局壳（《实施指南》§5.5 + UI 参考图）
 * 亮 / 暗 / SVIP黑金 三主题：
 *   - NConfigProvider.theme = light ? null : darkTheme（SVIP 属深色系，复用 darkTheme）
 *   - NConfigProvider.themeOverrides = lightThemeOverrides / darkThemeOverrides / svipThemeOverrides
 *   - NGlobalStyle 同步 common.bodyColor / textColor 到 document.body
 *   - html.dark / html.svip 类由 ui store 负责同步（主题闭环：ui store = 唯一真相源）
 */
import { computed } from 'vue'
import { NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import TopToolbar from '@/design/toolbar/TopToolbar.vue'
import LeftPanel from '@/design/panels/LeftPanel.vue'
import RightPanel from '@/design/panels/RightPanel.vue'
import CanvasStage from '@/design/canvas/CanvasStage.vue'
import SignaturePadModal from '@/design/panels/SignaturePadModal.vue'
import { useUiStore } from '@/design/stores/ui'
import { darkThemeOverrides, lightThemeOverrides, svipThemeOverrides } from '@/theme/naive-theme'

const uiStore = useUiStore()

/** SVIP 属深色系：非 light 一律用 darkTheme 基座 */
const isDark = computed(() => uiStore.effectiveTheme !== 'light')
const naiveTheme = computed(() => (isDark.value ? darkTheme : null))
const themeOverrides = computed(() => {
  switch (uiStore.effectiveTheme) {
    case 'svip':
      return svipThemeOverrides
    case 'dark':
      return darkThemeOverrides
    default:
      return lightThemeOverrides
  }
})
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NGlobalStyle />
    <NMessageProvider>
      <NDialogProvider>
        <div class="flex h-full flex-col">
          <TopToolbar />

          <div class="flex min-h-0 flex-1">
            <!-- 左侧组件库面板（组件/数据源/图层 三 tab 自含，无需额外侧边导航栏） -->
            <aside class="w-250px flex-shrink-0 overflow-y-auto border-r border-brand-border bg-brand-surface">
              <LeftPanel />
            </aside>

            <!-- 中央画布 -->
            <main class="min-w-0 flex-1 bg-brand-bg">
              <CanvasStage />
            </main>

            <!-- 右侧属性面板 -->
            <aside
              v-if="uiStore.rightPanelVisible"
              class="w-300px flex-shrink-0 border-l border-brand-border bg-brand-surface"
            >
              <RightPanel />
            </aside>
          </div>

          <!-- 弹出式手写签名画板（WPS 式） -->
          <SignaturePadModal />
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
</style>
