<script setup lang="ts">
/**
 * CommonProps —— 所有控件通用属性：名称 / 几何 / 旋转 / 锁定 / 打印开关（§5.4a）
 * 几何单位 mm（协议层），编辑即同步画布。
 */
import { computed } from 'vue'
import { NInput, NInputNumber, NSwitch } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'

const store = useDesignerStore()
const control = computed(() => store.selectedControl)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

const isZone = computed(() => control.value?.type === 'zone')
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">通用</div>

    <div class="props-row">
      <span class="props-label">名称</span>
      <NInput
        size="small"
        :value="control.name ?? ''"
        placeholder="图层名称"
        @update:value="patch({ name: $event || undefined })"
      />
    </div>

    <template v-if="!isZone">
      <div class="grid grid-cols-2 gap-2">
        <div class="props-row">
          <span class="props-label">X</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="Number.isFinite(control.left) ? control.left : 0"
            :precision="1"
            :step="0.1"
            @update:value="patch({ left: $event ?? 0 })"
          />
        </div>
        <div class="props-row">
          <span class="props-label">Y</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="Number.isFinite(control.top) ? control.top : 0"
            :precision="1"
            :step="0.1"
            @update:value="patch({ top: $event ?? 0 })"
          />
        </div>
        <div class="props-row">
          <span class="props-label">宽</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="Number.isFinite(control.width) ? control.width : 0"
            :precision="1"
            :min="0"
            @update:value="patch({ width: $event ?? 0 })"
          />
        </div>
        <div class="props-row">
          <span class="props-label">高</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="Number.isFinite(control.height) ? control.height : 0"
            :precision="1"
            :min="0"
            @update:value="patch({ height: $event ?? 0 })"
          />
        </div>
      </div>

      <div class="props-row">
        <span class="props-label">旋转</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.angle ?? 0"
          :min="-360"
          :max="360"
          style="width: 100px"
          @update:value="patch({ angle: $event ?? 0 })"
        />
      </div>

      <div class="props-row">
        <span class="props-label">锁定</span>
        <NSwitch
          size="small"
          :value="control.locked ?? false"
          @update:value="patch({ locked: $event || undefined })"
        />
      </div>
    </template>

    <div class="props-row">
      <span class="props-label">打印此元素</span>
      <NSwitch
        size="small"
        :value="control.printable ?? true"
        @update:value="patch({ printable: $event })"
      />
    </div>

    <div class="props-row">
      <span class="props-label">常驻辅助线</span>
      <NSwitch
        size="small"
        :value="control.showGuides ?? false"
        @update:value="patch({ showGuides: $event || undefined })"
      />
    </div>
  </div>
</template>

<style>
.props-section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--brand-border);
}
.props-title {
  font-size: 12px;
  color: var(--brand-text-3);
  margin-bottom: 8px;
  text-transform: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.props-title-tip {
  font-size: 11px;
  font-weight: normal;
  color: var(--brand-primary, #3b82f6);
  opacity: 0.85;
}
.props-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.props-label {
  font-size: 12px;
  color: var(--brand-text-2);
  flex-shrink: 0;
  min-width: 28px;
}
.props-tip {
  font-size: 11px;
  line-height: 1.5;
  color: var(--brand-text-3);
  margin: -2px 0 8px;
}
</style>
