<template>
  <div class="panel" style="padding: 16px; margin-top: 12px">
    <div class="toolbar"><div class="panelTitle">Резервные копии</div><div class="spacer" />
      <span v-if="d?.configured" class="pill" :class="d.stale || d.last?.ok === false ? 'red' : 'green'">{{ d.stale || d.last?.ok === false ? 'нужна проверка' : 'в порядке' }}</span>
      <button class="iconBtn" aria-label="Обновить" @click="load"><Icon id="refresh-cw-01" :size="14" /></button></div>
    <div v-if="d && !d.configured" class="note" style="margin-top: 6px">На этом сервере резервное копирование не настроено (нет каталога копий).</div>
    <template v-else-if="d">
      <div class="note" style="margin: 4px 0 10px">Каждую ночь в 03:15 по Москве: дамп базы с проверкой читаемости и копия файлов документов. Дампы хранятся 14 дней. Порядок восстановления — в инструкции по эксплуатации.</div>
      <div v-if="d.last" class="lastLine" :class="{ bad: !d.last.ok }">
        <template v-if="d.last.ok">Последняя копия: <b>{{ fmtTime(d.last.at) }}</b> · база {{ fmtBytes(d.last.bytes) }} · файлов документов: {{ d.last.files }}</template>
        <template v-else>Последняя попытка {{ fmtTime(d.last.at) }} не удалась: {{ d.last.error }}</template>
      </div>
      <div v-if="d.stale && d.last?.ok" class="lastLine bad">Копии старше суток — проверьте службу резервного копирования.</div>
      <details v-if="d.dumps.length" style="margin-top: 8px"><summary class="note" style="cursor: pointer">Дампы базы · {{ d.count }}</summary>
        <div class="miniWrap" style="margin-top: 6px"><table class="miniTable"><thead><tr><th>Файл</th><th class="num">Размер</th><th>Создан</th></tr></thead>
          <tbody><tr v-for="x in d.dumps" :key="x.file"><td class="mono">{{ x.file }}</td><td class="num">{{ fmtBytes(x.bytes) }}</td><td>{{ fmtTime(x.at) }}</td></tr></tbody></table></div>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { base } from '../store';
import { fmtTime } from '../format';
import Icon from './Icon.vue';
/* eslint-disable @typescript-eslint/no-explicit-any */
const d = ref<any>(null);
const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
async function load() { d.value = await api.get(`${base()}/backups`); }
onMounted(load);
</script>

<style scoped>
.lastLine { padding: 8px 10px; border-radius: 8px; background: #f6fef9; color: var(--text); }
.lastLine.bad { background: #fef3f2; color: var(--red); margin-top: 6px; }
</style>
