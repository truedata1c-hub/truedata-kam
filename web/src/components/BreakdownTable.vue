<template>
  <div class="miniWrap breakdown">
    <table class="miniTable">
      <thead>
        <tr>
          <th class="sticky">Бренд</th>
          <th v-for="p in version.periods" :key="p.key" class="num">{{ p.label }}</th>
          <th class="num total">Итого</th>
          <th class="num">{{ priorTitle }}</th>
          <th class="num">К факту</th>
          <th>Подсветки</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in version.brands" :key="b.brand_id ?? 'other'" :class="{ other: b.brand_id === null }">
          <td class="sticky">
            <div class="brandName">{{ b.name }}</div>
            <div v-if="b.note" class="cellSub" :title="b.note">{{ b.note }}</div>
            <div v-if="b.previous && metric !== 'roi'" class="cellSub">к v{{ version.number - 1 }}: {{ fmtDelta(deltaPct(val(b.total), val(b.previous))) || '0 %' }}</div>
          </td>
          <td v-for="p in version.periods" :key="p.key" class="num">
            <div>{{ cellText(b.cells[p.key]) }}</div>
            <div v-if="b.period_prior?.[p.key] && metric !== 'roi'" class="cellSub" :title="`Факт ${p.label.replace(/\d{4}/, String(Number(p.key.slice(0, 4)) - 1))}`">факт {{ priorCell(b.period_prior[p.key]) }}</div>
          </td>
          <td class="num total"><b>{{ totalText(b.total) }}</b></td>
          <td class="num">{{ b.prior ? priorText(b.prior) : '—' }}<div v-if="b.prior && metric === 'turnover' && b.prior.execution_pct !== null" class="cellSub">выполнение {{ fmtPct(b.prior.execution_pct) }}</div></td>
          <td class="num" :class="toneOf(b)">{{ changeText(b) }}</td>
          <td>
            <div class="chips">
              <span v-for="h in b.highlights" :key="h" class="pill" :class="HIGHLIGHT[h]?.tone">{{ HIGHLIGHT[h]?.short ?? h }}<q-tooltip>{{ HIGHLIGHT[h]?.label }}: {{ HIGHLIGHT[h]?.hint }}</q-tooltip></span>
            </div>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td class="sticky"><b>Итого</b></td>
          <td v-for="p in version.periods" :key="p.key" class="num"><b>{{ cellText(periodTotal(p.key)) }}</b></td>
          <td class="num total"><b>{{ totalText(version.totals) }}</b></td>
          <td class="num"><b>{{ version.totals.prior ? priorText(version.totals.prior) : '—' }}</b></td>
          <td class="num" :class="toneOf({ total: version.totals, prior: version.totals.prior })"><b>{{ changeText({ total: version.totals, prior: version.totals.prior }) }}</b></td>
          <td />
        </tr>
      </tfoot>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Money, PriorView, Version } from '../types';
import { HIGHLIGHT, deltaPct, fmtDelta, fmtPct, fmtRoi, fmtThousands } from '../format';

const props = defineProps<{ version: Version; metric: 'investment' | 'turnover' | 'roi' }>();
const roiOf = (m: Money | undefined) => (m && m.investment > 0 ? m.turnover / m.investment : null);
const val = (m: Money) => (props.metric === 'turnover' ? m.turnover : m.investment);
const cellText = (m: Money | undefined) => (props.metric === 'roi' ? fmtRoi(roiOf(m)) : fmtThousands(m ? val(m) : 0));
const totalText = (m: Money) => (props.metric === 'roi' ? fmtRoi(roiOf(m)) : fmtThousands(val(m)));
const priorTitle = computed(() => `Факт ${props.version.prior_label || 'прошлого периода'}`);
const priorFact = (p: PriorView) => (props.metric === 'roi' ? p.fact_roi : props.metric === 'turnover' ? p.fact_turnover : p.fact_investment);
const priorText = (p: PriorView) => (props.metric === 'roi' ? fmtRoi(p.fact_roi) : fmtThousands(priorFact(p)));
const priorCell = (p: PriorView | null) => (p ? priorText(p) : '—');
function change(b: { total: Money; prior: PriorView | null }) {
  if (!b.prior) return null;
  const base = priorFact(b.prior);
  if (props.metric === 'roi') { const r = roiOf(b.total); return r !== null && base ? r - base : null; }
  return deltaPct(val(b.total), base);
}
function changeText(b: { total: Money; prior: PriorView | null }) {
  const d = change(b);
  if (d === null) return '—';
  return props.metric === 'roi' ? `${d > 0 ? '+' : ''}${fmtRoi(d).replace('×', '')}` : fmtDelta(d);
}
// Для инвестиций рост — повод присмотреться; для оборота и ROI тревожно падение.
function toneOf(b: { total: Money; prior: PriorView | null }) {
  const d = change(b);
  if (d === null) return '';
  if (props.metric === 'investment') return d > props.version.thresholds.investment_growth_pct ? 'warn' : '';
  return d < 0 ? 'bad' : 'good';
}
function periodTotal(key: string): Money {
  return props.version.brands.reduce((a, b) => ({ investment: a.investment + (b.cells[key]?.investment ?? 0), turnover: a.turnover + (b.cells[key]?.turnover ?? 0) }), { investment: 0, turnover: 0 });
}
</script>

<style scoped>
.breakdown { overflow-x: auto; }
.breakdown th, .breakdown td { white-space: nowrap; }
.breakdown .num { text-align: right; font-variant-numeric: tabular-nums; }
.breakdown .total { background: #f9fafb; }
.breakdown .sticky { position: sticky; left: 0; background: #fff; z-index: 1; min-width: 150px; max-width: 220px; white-space: normal; }
.breakdown thead .sticky { background: var(--head, #f9fafb); }
.breakdown tfoot td { border-top: 1px solid var(--line); background: #fcfcfd; }
.breakdown tfoot .sticky { background: #fcfcfd; }
.breakdown tr.other td { color: var(--muted); }
.brandName { font-weight: 600; color: var(--ink); }
.cellSub { overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
td .chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 170px; white-space: normal; }
.warn { color: #b54708; font-weight: 600; }
.bad { color: var(--red); font-weight: 600; }
.good { color: #067647; font-weight: 600; }
</style>
