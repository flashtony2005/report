<script setup lang="ts">
/**
 * LayerPanel —— 图层面板：展示画布控件列表（z-order），可选中 / 删除 / 上下移动。
 *
 * 列表顺序以设计模型（store.controls）为真理源：末尾 = 最上层。图层面板上下移动
 * 直接重排模型并同步画布 z-order 与渲染输出，做到「画布设计什么样，预览/打印就什么样」。
 */
import { computed } from 'vue'
import { NButton, NScrollbar } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { CONTROL_TYPE_LABEL } from '@/design/canvas/controls'

const store = useDesignerStore()

/** 图层列表：zone（页眉/页脚）固定在最底，正文控件按模型顺序倒序（最上层在前） */
const layers = computed(() => {
  const list: Array<{ id: string; type: string; name: string; isZone: boolean }> = []
  for (const z of store.zones) {
    list.push({
      id: z.id,
      type: 'zone',
      name: z.zone === 'header' ? '页眉区域' : '页脚区域',
      isZone: true,
    })
  }
  for (let i = store.controls.length - 1; i >= 0; i--) {
    const c = store.controls[i]!
    list.push({
      id: c.id,
      type: c.type,
      name: c.name ?? CONTROL_TYPE_LABEL[c.type] ?? c.type,
      isZone: false,
    })
  }
  return list
})

/** 某正文控件在模型数组中的下标（用于判断能否继续上/下移） */
function modelIndex(id: string): number {
  return store.controls.findIndex((c) => c.id === id)
}

function move(id: string, dir: 'up' | 'down'): void {
  store.moveControl(id, dir)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-b border-brand-border px-3 py-2 text-12px text-brand-text-3">
      图层（{{ layers.length }} 项）
    </div>
    <NScrollbar class="flex-1 min-h-0">
      <div class="p-1">
        <div
          v-for="layer in layers"
          :key="layer.id"
          class="layer-item group"
          :class="{ selected: store.selectedIds.includes(layer.id) }"
          @click="store.selectControl(layer.id)"
        >
          <span class="truncate text-12px">{{ layer.name }}</span>
          <div class="layer-actions">
            <template v-if="!layer.isZone">
              <NButton
                text
                size="tiny"
                class="opacity-0 group-hover:opacity-100"
                :disabled="modelIndex(layer.id) >= store.controls.length - 1"
                @click.stop="move(layer.id, 'up')"
              >
                <div class="i-carbon-arrow-up text-12px text-brand-text-3" />
              </NButton>
              <NButton
                text
                size="tiny"
                class="opacity-0 group-hover:opacity-100"
                :disabled="modelIndex(layer.id) <= 0"
                @click.stop="move(layer.id, 'down')"
              >
                <div class="i-carbon-arrow-down text-12px text-brand-text-3" />
              </NButton>
            </template>
            <NButton
              text
              size="tiny"
              class="opacity-0 group-hover:opacity-100"
              @click.stop="store.removeControl(layer.id)"
            >
              <div class="i-carbon-close text-12px text-brand-text-3" />
            </NButton>
          </div>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.layer-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--brand-text-2);
  border: 1px solid transparent;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.layer-item:hover {
  background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
  color: var(--brand-primary);
}
.layer-item.selected {
  background: color-mix(in srgb, var(--brand-primary) 14%, transparent);
  color: var(--brand-primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 0 var(--brand-primary);
}
.layer-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
</style>
