<template>
  <svg class="tdIcon" :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true"><use :href="`/icons.svg#${id}`" /></svg>
</template>

<script setup lang="ts">
// Фирменный набор иконок портала (Untitled UI, demo/gismt-dashboard/public/icons.svg) — только используемые символы.
withDefaults(defineProps<{ id: string; size?: number }>(), { size: 15 });
</script>
