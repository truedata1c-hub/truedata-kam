<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Мои решения</div>
        <div class="note">Кампании, по которым вы исполнитель текущего шага согласования или замещаете исполнителя.</div>
      </div>
    </div>
    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tdTabs" role="tablist" aria-label="Решения">
        <button role="tab" :class="{ active: tab === 'active' }" :aria-selected="tab === 'active'" @click="tab = 'active'">Ждут решения<span v-if="pending" class="navBadge" style="margin-left: 6px">{{ pending }}</span></button>
        <button role="tab" :class="{ active: tab === 'done' }" :aria-selected="tab === 'done'" @click="tab = 'done'">Решённые мной</button>
      </div>
    </div>
    <div class="panel" style="margin-bottom: 12px">
      <q-table class="tdTable" flat row-key="step_id" :rows="rows" :columns="columns" :loading="loading" :pagination="{ rowsPerPage: 50 }" @row-click="(_e: unknown, r: Row) => go('campaign', r.campaign_id)">
        <template #body-cell-campaign="p">
          <q-td :props="p"><div style="font-weight: 600; color: var(--ink)">{{ p.row.network }}</div><div class="cellSub">{{ p.row.title }} · {{ campaignNo(p.row.number) }}</div></q-td>
        </template>
        <template #body-cell-step="p">
          <q-td :props="p"><div>{{ p.row.step_title }}</div><div class="cellSub">шаг {{ p.row.position }} из {{ p.row.steps_total }} · раунд {{ p.row.round }}<template v-if="p.row.on_behalf_of"> · за {{ p.row.on_behalf_of }}</template><template v-if="p.row.decided_for"> · за {{ p.row.decided_for }}</template></div></q-td>
        </template>
        <template #body-cell-money="p">
          <q-td :props="p" class="num"><div>{{ fmtShort(p.row.investment) }}</div><div class="cellSub">{{ fmtShort(p.row.turnover) }} · ROI {{ fmtRoi(p.row.roi) }} · v{{ p.row.version }}</div></q-td>
        </template>
        <template #body-cell-when="p">
          <q-td :props="p">
            <template v-if="tab === 'active'"><div :class="{ redText: p.row.overdue }">{{ fmtDate(p.row.due_date) }}</div><div class="cellSub" :class="{ redText: p.row.overdue }">{{ p.row.overdue ? 'просрочено' : `с ${fmtTime(p.row.activated_at)}` }}</div></template>
            <template v-else><div><span class="pill" :class="p.row.status === 'APPROVED' ? 'green' : 'red'">{{ p.row.status === 'APPROVED' ? 'согласовано' : 'отклонено' }}</span></div><div class="cellSub">{{ fmtTime(p.row.decided_at) }}</div></template>
          </q-td>
        </template>
        <template #body-cell-owner="p">
          <q-td :props="p"><div>{{ p.row.owner }}</div><div class="cellSub">{{ p.row.type_name }}</div></q-td>
        </template>
        <template #no-data><div class="emptyState" style="width: 100%">{{ tab === 'active' ? 'Решений не ждёт ни одна кампания.' : 'Вы ещё не принимали решений.' }}</div></template>
      </q-table>
    </div>
    <SubstitutionsPanel />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { base, go, announceTitle } from '../store';
import { campaignNo, fmtDate, fmtRoi, fmtShort, fmtTime } from '../format';
import SubstitutionsPanel from '../components/SubstitutionsPanel.vue';

interface Row {
  step_id: string; step_title: string; position: number; steps_total: number; round: number; status: string; due_date: string; activated_at: string; decided_at: string;
  overdue: boolean; campaign_id: string; number: number; title: string; network: string; type_name: string; owner: string;
  investment: number; turnover: number; roi: number | null; version: number; on_behalf_of: string | null; decided_for: string | null;
}
const tab = ref<'active' | 'done'>('active');
const rows = ref<Row[]>([]);
const pending = ref(0);
const loading = ref(false);
const columns = [
  { name: 'campaign', label: 'Сеть и кампания', field: 'network', align: 'left' as const },
  { name: 'step', label: 'Шаг', field: 'step_title', align: 'left' as const },
  { name: 'money', label: 'Инвестиции · оборот', field: 'investment', align: 'right' as const },
  { name: 'owner', label: 'КАМ', field: 'owner', align: 'left' as const },
  { name: 'when', label: 'Срок', field: 'due_date', align: 'left' as const },
];
async function load() {
  loading.value = true;
  try {
    const r = await api.get<{ items: Row[]; pending?: number }>(`${base()}/my-decisions`, { status: tab.value });
    rows.value = r.items;
    if (tab.value === 'active') pending.value = r.pending ?? r.items.length;
  } finally { loading.value = false; }
}
watch(tab, load);
onMounted(() => { announceTitle('Мои решения'); void load(); });
</script>

<style scoped>
.redText { color: var(--red); }
</style>
