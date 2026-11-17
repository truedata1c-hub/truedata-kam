<template>
  <q-select
    v-bind="$attrs"
    :model-value="modelValue"
    outlined dense options-dense emit-value map-options hide-dropdown-icon hide-bottom-space
    :display-value="isEmpty ? placeholder : undefined"
    :class="['selectCtl', { hasValue: !isEmpty }]"
    popup-content-class="tdSelectMenu"
    @update:model-value="(v: unknown) => emit('update:modelValue', v)"
  >
    <template #append>
      <button v-if="clearable && modelValue" type="button" class="iconBtn" style="width: 18px; height: 18px" aria-label="Очистить" @click.stop="emit('update:modelValue', null)">
        <Icon id="x-close" :size="13" />
      </button>
      <Icon id="chevron-down" :size="15" class="muted" />
    </template>
  </q-select>
</template>

<script setup lang="ts">
// Селект в виде контрола портала: серая рамка без фиолетовой подсветки, стрелка chevron-down с отступом справа.
import { computed } from 'vue';
import Icon from './Icon.vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue: unknown; clearable?: boolean; placeholder?: string }>();
const isEmpty = computed(() => props.modelValue === null || props.modelValue === undefined || props.modelValue === '');
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();
</script>
