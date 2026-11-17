<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Переговорные кампании</div>
        <div class="note">{{ scopeText }}</div>
      </div>
      <button v-if="canCreate" class="tdBtn primary" @click="createDlg = true"><Icon id="plus" :size="15" /><span>Создать кампанию</span></button>
    </div>

    <!-- KPI в области видимости пользователя и выбранного года -->
    <div class="kpiGrid">
      <button class="kpi" :class="{ selected: filters.stage === 'ACTIVE' && !filters.overdue }" @click="setStage('ACTIVE')">
        <div class="kpiLabel">Активные кампании</div>
        <div class="kpiValue">{{ kpi.active }}</div>
        <div class="kpiSub">без отменённых и закрытых</div>
      </button>
      <button class="kpi" :class="{ selected: filters.stage === 'APPROVAL' }" @click="setStage('APPROVAL')">
        <div class="kpiLabel">Ждут решения</div>
        <div class="kpiValue">{{ kpi.awaiting_decision }}</div>
        <div class="kpiSub">на внутреннем согласовании</div>
      </button>
      <div class="kpi">
        <div class="kpiLabel">Согласованы</div>
        <div class="kpiValue">{{ kpi.approved }}</div>
        <div class="kpiSub">внутри, сетью или финально</div>
      </div>
      <button class="kpi" :class="{ selected: filters.overdue }" @click="toggleOverdue">
        <div class="kpiLabel"><Icon id="alert-triangle" :size="13" />Просрочена контрольная дата</div>
        <div class="kpiValue" :class="{ red: kpi.overdue > 0 }">{{ kpi.overdue }}</div>
        <div class="kpiSub">условия не согласованы вовремя</div>
      </button>
      <div class="kpi">
        <div class="kpiLabel">План инвестиций</div>
        <div class="kpiValue">{{ fmtShort(kpi.investment) }}</div>
        <div class="kpiSub">по текущим версиям {{ kpi.with_versions }} {{ plural(kpi.with_versions, 'кампании', 'кампаний', 'кампаний') }}</div>
      </div>
      <div class="kpi">
        <div class="kpiLabel">Ожидаемый оборот · ROI</div>
        <div class="kpiValue">{{ fmtShort(kpi.turnover) }}</div>
        <div class="kpiSub">ROI {{ fmtRoi(kpi.roi) }} — оборот на 1 ₽ инвестиций</div>
      </div>
    </div>

    <!-- Количество кампаний по этапам -->
    <div class="stageStrip" style="margin-top: 10px" role="group" aria-label="Этапы">
      <button v-for="s in STAGES" :key="s" :class="{ active: filters.stage === s }" @click="setStage(filters.stage === s ? 'ACTIVE' : s)">
        <span class="n">{{ kpi.by_stage[s] ?? 0 }}</span>
        <span class="l">{{ STAGE_LABEL[s] }}</span>
        <span class="bar"><i :style="{ width: barWidth(s) }" /></span>
      </button>
    </div>

    <div class="tableTools">
      <q-input v-model="filters.q" outlined dense clearable debounce="300" placeholder="Сеть, название или номер" class="searchCtl" style="width: 240px" aria-label="Поиск" hide-bottom-space>
        <template #prepend><Icon id="search-sm" :size="15" class="muted" /></template>
      </q-input>
      <TdSelect v-model="filters.year" :options="yearOptions" aria-label="Год" />
      <TdSelect v-model="filters.stage" :options="stageOptions" aria-label="Этап" />
      <TdSelect v-model="filters.type" clearable :options="typeOptions" placeholder="Все типы" aria-label="Тип" />
      <TdSelect v-model="filters.network" clearable :options="networkOptions" placeholder="Все сети" aria-label="Сеть" />
      <TdSelect v-if="ownerOptions.length > 1" v-model="filters.owner" clearable :options="ownerOptions" placeholder="Все КАМ" aria-label="Ответственный" />
      <div class="spacer" />
      <button v-if="hasFilters" class="tdBtn accent" @click="reset"><Icon id="eraser" :size="15" /><span>Сбросить</span></button>
    </div>

    <q-table
      class="tdTable" flat row-key="id" :rows="rows" :columns="columns" :loading="loading"
      v-model:pagination="pagination" :rows-per-page-options="[25, 50, 100, 0]"
      no-data-label="Кампаний по этим условиям нет"
      @row-click="(_: unknown, row: Row) => go('campaign', row.id)"
    >
      <template #body-cell-network="p">
        <q-td :props="p">
          <div style="font-weight: 600">{{ p.row.network_name }}</div>
          <div class="cellSub clip" :title="p.row.network_regions.join(', ')">{{ p.row.network_regions.join(', ') }}</div>
        </q-td>
      </template>
      <template #body-cell-title="p">
        <q-td :props="p">
          <div style="font-weight: 500">{{ p.row.title }}</div>
          <div class="cellSub">{{ campaignNo(p.row.number) }} · {{ p.row.type_name }}</div>
        </q-td>
      </template>
      <template #body-cell-period="p">
        <q-td :props="p">{{ fmtDate(p.row.period_from) }}<div class="cellSub">по {{ fmtDate(p.row.period_to) }}</div></q-td>
      </template>
      <template #body-cell-stage="p">
        <q-td :props="p"><span class="pill" :class="STAGE_TONE[p.row.stage]">{{ STAGE_LABEL[p.row.stage] }}</span></q-td>
      </template>
      <template #body-cell-money="p">
        <q-td :props="p" class="text-right">
          <template v-if="p.row.version">
            <div style="font-weight: 500">{{ fmtShort(p.row.investment) }}</div>
            <div class="cellSub">{{ fmtShort(p.row.turnover) }} · ROI {{ fmtRoi(p.row.roi) }} · v{{ p.row.version }}</div>
          </template>
          <span v-else class="muted">нет версии</span>
        </q-td>
      </template>
      <template #body-cell-control="p">
        <q-td :props="p">
          <span :class="{ overdue: p.row.overdue }">{{ fmtDate(p.row.control_date) }}</span>
          <div v-if="p.row.overdue" class="cellSub" style="color: var(--red)">просрочена</div>
        </q-td>
      </template>
      <template #body-cell-owner="p">
        <q-td :props="p">
          <div>{{ p.row.owner_name }}</div>
          <div class="cellSub">обновлено {{ fmtDate(p.row.updated_at) }}</div>
        </q-td>
      </template>
    </q-table>

    <NewCampaignDialog v-if="createDlg" @close="createDlg = false" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, company, go, state, announceTitle } from '../store';
import { STAGES, STAGE_LABEL, STAGE_TONE, campaignNo, fmtDate, fmtRoi, fmtShort, plural } from '../format';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';
import NewCampaignDialog from '../components/NewCampaignDialog.vue';

interface Row {
  version: number | null; investment: number | null; turnover: number | null; roi: number | null;
  id: string; number: number; title: string; stage: string; period_from: string; period_to: string; control_date: string; overdue: boolean; updated_at: string;
  network_name: string; network_regions: string[]; type_name: string; owner_name: string;
}
interface Kpi { investment: number; turnover: number; roi: number | null; with_versions: number; active: number; overdue: number; awaiting_decision: number; approved: number; by_stage: Record<string, number> }

const $q = useQuasar();
const thisYear = new Date().getFullYear();
// С октября основной поток — условия следующего года.
const defaultYear = new Date().getMonth() >= 9 ? thisYear + 1 : thisYear;
const defaults = () => ({ q: '', year: String(defaultYear), stage: 'ACTIVE', type: null as string | null, network: null as string | null, owner: null as string | null, overdue: false });
const filters = reactive(readFilters());
const rows = ref<Row[]>([]);
const kpi = ref<Kpi>({ investment: 0, turnover: 0, roi: null, with_versions: 0, active: 0, overdue: 0, awaiting_decision: 0, approved: 0, by_stage: {} });
const loading = ref(false);
const createDlg = ref(false);
const pagination = ref({ rowsPerPage: 50, page: 1 });

const columns = [
  { name: 'network', label: 'Аптечная сеть', field: 'network_name', align: 'left' as const, sortable: true },
  { name: 'title', label: 'Кампания', field: 'title', align: 'left' as const, sortable: true },
  { name: 'period', label: 'Период', field: 'period_from', align: 'left' as const, sortable: true },
  { name: 'money', label: 'Инвестиции · оборот', field: 'investment', align: 'right' as const, sortable: true },
  { name: 'stage', label: 'Этап', field: (r: Row) => STAGES.indexOf(r.stage as never), align: 'left' as const, sortable: true },
  { name: 'control', label: 'Контрольная дата', field: 'control_date', align: 'left' as const, sortable: true },
  { name: 'owner', label: 'Ответственный', field: 'owner_name', align: 'left' as const, sortable: true },
];

const yearOptions = [thisYear - 1, thisYear, thisYear + 1].map((y) => ({ label: `Условия ${y}`, value: String(y) })).concat([{ label: 'Все годы', value: '' }]);
const stageOptions = [
  { label: 'Активные', value: 'ACTIVE' },
  { label: 'Все этапы', value: '' },
  ...STAGES.map((s) => ({ label: STAGE_LABEL[s], value: s })),
  { label: 'Отменённые', value: 'CANCELLED' },
  { label: 'Закрытые', value: 'CLOSED' },
];
const typeOptions = computed(() => (state.ref?.types ?? []).map((t) => ({ label: t.name, value: t.id })));
const allNetworkOptions = computed(() => (state.ref?.networks ?? []).map((n) => ({ label: n.name, value: n.id })));
const networkOptions = allNetworkOptions;
const ownerOptions = computed(() => (state.ref?.owners ?? []).map((o) => ({ label: o.name, value: o.id })));
const canCreate = computed(() => (state.ref?.assignable.length ?? 0) > 0);
const hasFilters = computed(() => JSON.stringify({ ...filters }) !== JSON.stringify(defaults()));
const scopeText = computed(() => {
  const s = company.value?.scopes ?? [];
  if (s.includes('ALL') || s.includes('BRANDS')) return 'Все кампании компании.';
  if (s.includes('SUBORDINATES')) return 'Ваши кампании и кампании сотрудников вашей группы.';
  return 'Кампании сетей, за которыми вы закреплены.';
});
const maxStage = computed(() => Math.max(1, ...STAGES.map((s) => kpi.value.by_stage[s] ?? 0)));
const barWidth = (s: string) => `${Math.round(((kpi.value.by_stage[s] ?? 0) / maxStage.value) * 100)}%`;

function setStage(s: string) { filters.stage = s; filters.overdue = false; }
function toggleOverdue() { filters.overdue = !filters.overdue; if (filters.overdue) filters.stage = ''; else filters.stage = 'ACTIVE'; }
function reset() { Object.assign(filters, defaults()); }

async function load() {
  loading.value = true;
  try {
    const r = await api.get<{ items: Row[]; kpi: Kpi }>(`${base()}/campaigns`, {
      q: filters.q, year: filters.year, stage: filters.stage, type: filters.type, network: filters.network, owner: filters.owner, overdue: filters.overdue ? '1' : undefined,
    });
    rows.value = r.items;
    kpi.value = r.kpi;
  } catch (e) {
    $q.notify({ type: 'negative', message: (e as Error).message });
  } finally {
    loading.value = false;
  }
}

function readFilters() {
  try { return { ...defaults(), ...JSON.parse(sessionStorage.getItem('kam.portfolio') ?? '{}') }; } catch { return defaults(); }
}
watch(filters, () => {
  try { sessionStorage.setItem('kam.portfolio', JSON.stringify(filters)); } catch { /* удобство */ }
  void load();
});

function onCreated(r: { id: string; warnings: { message: string }[] }) {
  createDlg.value = false;
  for (const w of r.warnings) $q.notify({ type: 'warning', message: w.message, timeout: 6000 });
  go('campaign', r.id);
}

onMounted(() => { announceTitle(''); void load(); });
</script>
