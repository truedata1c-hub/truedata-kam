<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Прошлые периоды</div>
        <div class="note">План и факт инвестиций и оборота по сети, бренду и кварталу. С ними сравниваются версии предложения; согласующий видит отклонения. Позже данные будут приходить из PharmaCheck автоматически.</div>
      </div>
    </div>
    <div class="toolbar" style="margin-bottom: 12px">
      <TdSelect v-model="year" :options="yearOptions" aria-label="Год" style="width: 140px" />
      <a class="tdBtn" :href="templateUrl" download><Icon id="download-01" :size="15" /><span>Шаблон Excel {{ year }}</span></a>
      <button class="tdBtn primary" :disabled="uploading" @click="fileInput?.click()"><q-spinner v-if="uploading" size="14px" /><Icon v-else id="upload-01" :size="15" /><span>Загрузить {{ year }}</span></button>
      <input ref="fileInput" type="file" accept=".xlsx" hidden @change="onFile" />
      <span class="note">Загрузка заменяет все данные выбранного года; при ошибках ничего не меняется.</span>
    </div>
    <div v-if="issues.length" class="banner error" style="margin-bottom: 12px">
      <Icon id="alert-triangle" :size="15" />
      <div><b>{{ issuesTitle }}</b>
        <div v-for="(i, n) in issues.slice(0, 15)" :key="n">{{ i.row ? `строка ${i.row}${i.column ? `, ${i.column}` : ''}: ` : '' }}{{ i.message }}</div>
        <div v-if="issues.length > 15">…и ещё {{ issues.length - 15 }}</div></div>
    </div>
    <div class="miniWrap">
      <table class="miniTable">
        <thead><tr><th>Сеть</th><th class="num">Брендов</th><th class="num">План инвестиций</th><th class="num">Факт инвестиций</th><th class="num">План оборота</th><th class="num">Факт оборота</th><th class="num">Выполнение</th><th class="num">ROI факт</th></tr></thead>
        <tbody>
          <tr v-for="n in data?.networks ?? []" :key="n.network_id">
            <td style="font-weight: 500">{{ n.network }}</td>
            <td class="num">{{ n.brands }}</td>
            <td class="num">{{ fmtShort(n.plan_investment) }}</td>
            <td class="num">{{ fmtShort(n.fact_investment) }}</td>
            <td class="num">{{ fmtShort(n.plan_turnover) }}</td>
            <td class="num">{{ fmtShort(n.fact_turnover) }}</td>
            <td class="num">{{ n.plan_turnover ? fmtPct((n.fact_turnover / n.plan_turnover) * 100) : '—' }}</td>
            <td class="num">{{ n.fact_investment ? fmtRoi(n.fact_turnover / n.fact_investment) : '—' }}</td>
          </tr>
          <tr v-if="data && !data.networks.length"><td colspan="8" class="muted">За {{ year }} год данных нет. Скачайте шаблон, заполните и загрузите.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api, ApiError } from '../api';
import { base, announceTitle } from '../store';
import { fmtPct, fmtRoi, fmtShort } from '../format';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';

interface Summary {
  year: number; years: { year: number; rows: number }[];
  networks: { network_id: string; network: string; brands: number; plan_investment: number; fact_investment: number; plan_turnover: number; fact_turnover: number }[];
}
const $q = useQuasar();
const data = ref<Summary | null>(null);
const year = ref(String(new Date().getFullYear() - 1));
const uploading = ref(false);
const issues = ref<{ row: number; column: string; message: string }[]>([]);
const issuesTitle = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const now = new Date().getFullYear();
const yearOptions = computed(() => [...new Set([now, now - 1, now - 2, ...(data.value?.years.map((y) => y.year) ?? [])])].sort((a, b) => b - a).map((y) => ({ label: String(y), value: String(y) })));
const templateUrl = computed(() => api.url(`${base()}/prior-periods/template.xlsx?year=${year.value}`));

async function load() {
  data.value = await api.get<Summary>(`${base()}/prior-periods`, { year: year.value });
}
async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  uploading.value = true;
  issues.value = [];
  try {
    const form = new FormData();
    form.append('year', year.value);
    form.append('file', f);
    const r = await api.upload<{ rows: number; replaced: number }>(`${base()}/prior-periods/import`, form);
    $q.notify({ type: 'positive', message: `Загружено строк: ${r.data.rows}${r.data.replaced ? ` (заменено ${r.data.replaced})` : ''}` });
    await load();
  } catch (x) {
    const err = x as ApiError;
    issuesTitle.value = err.message;
    issues.value = (err.details?.issues as typeof issues.value) ?? [{ row: 0, column: '', message: err.message }];
  } finally {
    uploading.value = false;
  }
}
watch(year, () => { issues.value = []; void load(); });
onMounted(async () => {
  announceTitle('Прошлые периоды');
  const first = await api.get<Summary>(`${base()}/prior-periods`);
  year.value = String(first.year);
  data.value = first;
});
</script>
