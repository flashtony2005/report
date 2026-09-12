<script setup lang="ts">
/**
 * LeftPanel —— 左栏容器：组件库 / 数据源树 / 批量数据 / 图层
 */
import { NTabs, NTabPane } from 'naive-ui'
import ControlLibrary from './ControlLibrary.vue'
import DataSourceTree from './DataSourceTree.vue'
import LayerPanel from './LayerPanel.vue'
import { useUiStore } from '@/design/stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="left-panel flex h-full flex-col bg-brand-surface">
    <NTabs v-model:value="ui.leftTab" type="segment" size="small" class="flex-1 min-h-0 px-2" animated>
      <NTabPane name="components" tab="组件">
        <ControlLibrary />
      </NTabPane>
      <NTabPane name="datasource" tab="数据源">
        <DataSourceTree />
      </NTabPane>
      <NTabPane name="layers" tab="图层">
        <LayerPanel />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
/*
 * 让 NTabs 的内容容器（.n-tabs-pane-wrapper）成为「可收缩的弹性子项」。
 * naive 默认只给它 overflow:hidden、不设 flex:1/min-height:0，
 * 导致它按内容撑高、不向内部组件传递有界高度，内部 overflow-y-auto 永远不触发。
 * 这里强制其 flex:1 + min-height:0，tab 头固定、内容区内部滚动。
 */
.left-panel :deep(.n-tabs-pane-wrapper) {
  flex: 1 1 0;
  min-height: 0;
}
.left-panel :deep(.n-tab-pane) {
  height: 100%;
}
</style>
