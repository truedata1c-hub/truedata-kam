<template>
  <div class="analytics">
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Аналитика переговоров</div>
        <div class="note">Кампании {{ year }} года в вашей области видимости. Суммы — доля текущих версий предложений, приходящаяся на {{ year }} год, без отменённых кампаний; прошлый период — факт {{ Number(year) - 1 }} года по тем же сетям в тех же кварталах.</div>
      </div>
    </div>
    <div class="toolbar filters">
      <TdSelect v-model="year" :options="yearOptions" aria-label="Год" style="width: 130px" />
      <TdSelect v-model="type" :options="typeOptions" clearable placeholder="Все типы" aria-label="Тип кампании" style="width: 200px" />
      <TdSelect v-model="group" :options="groupOptions" clearable placeholder="Все группы сетей" aria-label="Группа сетей" style="width: 200px" />
      <TdSelect v-model="network" :options="networkOptions" clearable placeholder="Все сети" aria-label="Сеть" style="width: 200px" />
      <TdSelect v-if="ownerOptions.length > 1" v-model="owner" :options="ownerOptions" clearable placeholder="Все КАМ" aria-label="КАМ" style="width: 200px" />
      <q-spinner v-if="loading" size="18px" color="primary" />
    </div>
    <div v-if="d?.brand_limited" class="banner info" style="margin-bottom: 12px"><Icon id="info-circle" :size="15" /><span>Вы видите подробно свои бренды; суммы по остальным брендам показаны одной строкой «Прочие бренды».</span></div>

    <template v-if="d">
      <div class="kpiRow">
        <div class="kpiTile">
          <div class="kLabel">План инвестиций</div>
          <div class="kValue">{{ fmtShort(d.kpi.investment) }}</div>
          <div class="kSub" :class="tone(d.kpi.growth_pct, 15)">{{ d.kpi.growth_pct === null ? 'нет факта прошлого года' : `${sign(d.kpi.growth_pct)} % к факту ${prev} (${fmtShort(d.kpi.prior_fact_investment)})` }}</div>
        </div>
        <div class="kpiTile">
          <div class="kLabel">Ожидаемый оборот · ROI</div>
          <div class="kValue">{{ fmtShort(d.kpi.turnover) }} <span class="kSmall">· {{ fmtRoi(d.kpi.roi) }}</span></div>
          <div class="kSub" :class="{ warnText: d.kpi.roi !== null && d.kpi.prior_roi !== null && d.kpi.roi < d.kpi.prior_roi }">ROI факт {{ prev }}: {{ fmtRoi(d.kpi.prior_roi) }}</div>
        </div>
        <div class="kpiTile">
          <div class="kLabel">Согласовано</div>
          <div class="kValue">{{ d.kpi.approved }} <span class="kSmall">из {{ d.kpi.campaigns - d.kpi.cancelled }} {{ plural(d.kpi.campaigns - d.kpi.cancelled, 'кампании', 'кампаний', 'кампаний') }}</span></div>
          <div class="kSub">{{ d.kpi.approved_share_pct ?? 0 }} % плана инвестиций · {{ fmtShort(d.kpi.approved_investment) }}</div>
        </div>
        <div class="kpiTile">
          <div class="kLabel">С первого раунда</div>
          <div class="kValue">{{ d.kpi.first_pass_pct === null ? '—' : `${d.kpi.first_pass_pct} %` }}</div>
          <div class="kSub">отклонено раундов: {{ d.kpi.rejected_rounds }} из {{ d.kpi.rounds }}</div>
        </div>
        <div class="kpiTile" :class="{ alert: d.kpi.overdue_control + d.kpi.overdue_steps > 0 }">
          <div class="kLabel">Просрочено</div>
          <div class="kValue">{{ d.kpi.overdue_control + d.kpi.overdue_steps }}</div>
          <div class="kSub">контрольных дат: {{ d.kpi.overdue_control }} · шагов согласования: {{ d.kpi.overdue_steps }}</div>
        </div>
      </div>

      <div class="grid2">
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">Воронка этапов</div><div class="spacer" /><span class="note">кампаний · инвестиции</span></div>
          <div class="panelBody">
            <div v-for="f in funnelRows" :key="f.stage" class="barRow">
              <div class="barLabel">{{ STAGE_LABEL[f.stage] }}</div>
              <div class="barTrack"><div class="bar" :class="{ muted: f.stage === 'CANCELLED' }" :style="{ width: pct(f.count, maxFunnel) }"><q-tooltip>{{ STAGE_LABEL[f.stage] }}: {{ f.count }} {{ plural(f.count, 'кампания', 'кампании', 'кампаний') }}, {{ fmtShort(f.investment) }} инвестиций</q-tooltip></div></div>
              <div class="barVal"><b>{{ f.count }}</b><span class="cellSub">{{ f.investment ? fmtShort(f.investment) : '—' }}</span></div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">Сколько длятся этапы</div><div class="spacer" /><span class="note">дней, среднее · медиана</span></div>
          <div class="panelBody">
            <div v-for="t in d.timing" :key="t.stage" class="barRow">
              <div class="barLabel">{{ STAGE_LABEL[t.stage] }}</div>
              <div class="barTrack"><div class="bar" :style="{ width: pct(t.avg_days ?? 0, maxTiming) }"><q-tooltip>{{ STAGE_LABEL[t.stage] }}: в среднем {{ ru(t.avg_days) }} дн., медиана {{ ru(t.median_days) }} дн.; прошли этап {{ t.finished }} из {{ t.n }}</q-tooltip></div></div>
              <div class="barVal"><b>{{ ru(t.avg_days) }}</b><span class="cellSub">медиана {{ ru(t.median_days) }}</span></div>
            </div>
            <div class="note" style="margin-top: 6px">Для кампаний, которые ещё на этапе, считается время до сегодня.</div>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-top: 12px">
        <div class="panelHead"><div class="panelTitle">Узкие места согласования</div><div class="spacer" /><span class="note">по шагам маршрутов</span></div>
        <div class="panelBody">
          <div class="miniWrap">
            <table class="miniTable">
              <thead><tr><th>Шаг</th><th class="num">Решений</th><th class="num">Среднее время, дн.</th><th class="num">С опозданием</th><th class="num">Отклонено</th><th class="num">Ждут сейчас</th><th class="num">Просрочено</th></tr></thead>
              <tbody>
                <tr v-for="s in d.steps" :key="s.title">
                  <td style="font-weight: 500">{{ s.title }}</td>
                  <td class="num">{{ s.decided }}</td>
                  <td class="num">{{ ru(s.avg_days) }}</td>
                  <td class="num">{{ s.late || '—' }}</td>
                  <td class="num">{{ s.rejected || '—' }}</td>
                  <td class="num">{{ s.active || '—' }}</td>
                  <td class="num" :class="{ redText: s.overdue }">{{ s.overdue || '—' }}</td>
                </tr>
                <tr v-if="!d.steps.length"><td colspan="7" class="muted">Согласований пока не было.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-top: 12px">
        <div class="panelHead">
          <div class="panelTitle">Инвестиции по брендам</div><div class="spacer" />
          <span class="legend"><span class="swatch" /> план {{ year }}</span><span class="legend"><span class="tick" /> факт {{ prev }}</span>
        </div>
        <div class="panelBody">
          <div class="miniWrap">
            <table class="miniTable">
              <thead><tr><th style="width: 160px">Бренд</th><th style="min-width: 220px"></th><th class="num">План {{ year }}</th><th class="num">Факт {{ prev }}</th><th class="num">Изменение</th><th class="num">ROI план</th><th class="num">ROI факт {{ prev }}</th><th class="num">Выполнение плана {{ prev }}</th></tr></thead>
              <tbody>
                <tr v-for="b in d.by_brand" :key="b.brand_id ?? 'other'" :class="{ otherRow: !b.brand_id }">
                  <td style="font-weight: 500">{{ b.name }}</td>
                  <td><BarCell :value="b.investment" :prior="b.prior_fact_investment" :max="maxBrand" :label="`${b.name}: план ${fmtShort(b.investment)}, факт ${prev} ${fmtShort(b.prior_fact_investment)}`" /></td>
                  <td class="num">{{ fmtShort(b.investment) }}</td>
                  <td class="num">{{ fmtShort(b.prior_fact_investment) }}</td>
                  <td class="num" :class="tone(b.growth_pct, 15)">{{ b.growth_pct === null ? '—' : `${sign(b.growth_pct)} %` }}</td>
                  <td class="num" :class="{ warnText: b.roi !== null && b.prior_roi !== null && b.roi < b.prior_roi }">{{ fmtRoi(b.roi) }}</td>
                  <td class="num">{{ fmtRoi(b.prior_roi) }}</td>
                  <td class="num" :class="{ warnText: b.prior_execution_pct !== null && b.prior_execution_pct < 90 }">{{ b.prior_execution_pct === null ? '—' : `${ru(b.prior_execution_pct)} %` }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="note" style="margin-top: 6px">Оранжевым — рост инвестиций выше 15 %, ROI ниже прошлого года, план прошлого года выполнен меньше чем на 90 %.</div>
        </div>
      </div>

      <div class="grid2" style="margin-top: 12px">
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">По кварталам</div><div class="spacer" /><span class="legend"><span class="swatch" /> план</span><span class="legend"><span class="tick" /> факт {{ prev }}</span></div>
          <div class="panelBody">
            <div v-for="qq in d.by_quarter" :key="qq.quarter" class="barRow">
              <div class="barLabel">{{ qq.label }}</div>
              <BarCell :value="qq.investment" :prior="qq.prior_fact_investment" :max="maxQuarter" :label="`${qq.label}: план ${fmtShort(qq.investment)}, факт ${prev} ${fmtShort(qq.prior_fact_investment)}, ROI ${fmtRoi(qq.roi)}`" />
              <div class="barVal"><b>{{ fmtShort(qq.investment) }}</b><span class="cellSub">ROI {{ fmtRoi(qq.roi) }} · факт {{ fmtRoi(qq.prior_roi) }}</span></div>
            </div>
            <div class="note" style="margin-top: 6px">Суммы акций, разбитых по месяцам или на весь срок, распределены по кварталам равномерно по месяцам.</div>
          </div>
        </div>
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">По КАМ</div></div>
          <div class="panelBody">
            <div class="miniWrap">
              <table class="miniTable">
                <thead><tr><th>КАМ</th><th class="num">Кампаний</th><th class="num">Согласовано</th><th class="num">Инвестиции</th><th class="num">ROI</th><th class="num">Просрочено</th></tr></thead>
                <tbody>
                  <tr v-for="o in d.by_owner" :key="o.owner_id">
                    <td>{{ o.name }}</td><td class="num">{{ o.campaigns }}</td><td class="num">{{ o.approved }}</td>
                    <td class="num">{{ fmtShort(o.investment) }}</td><td class="num">{{ fmtRoi(o.roi) }}</td><td class="num" :class="{ redText: o.overdue }">{{ o.overdue || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-top: 12px">
        <div class="panelHead"><div class="panelTitle">По сетям</div><div class="spacer" /><span class="note">{{ d.by_network.length }} {{ plural(d.by_network.length, 'сеть', 'сети', 'сетей') }}</span></div>
        <div class="panelBody">
          <div class="miniWrap" style="max-height: 420px; overflow-y: auto">
            <table class="miniTable">
              <thead><tr><th>Сеть</th><th class="num">Кампаний</th><th class="num">План инвестиций</th><th class="num">Факт {{ prev }}</th><th class="num">Изменение</th><th class="num">ROI</th><th class="num">ROI факт {{ prev }}</th><th class="num">Просрочено</th></tr></thead>
              <tbody>
                <tr v-for="n in d.by_network" :key="n.network_id" class="clickRow" @click="openNetwork(n.network_id)">
                  <td style="font-weight: 500">{{ n.name }}</td><td class="num">{{ n.campaigns }}</td>
                  <td class="num">{{ fmtShort(n.investment) }}</td><td class="num">{{ fmtShort(n.prior_fact_investment) }}</td>
                  <td class="num" :class="tone(n.growth_pct, 15)">{{ n.growth_pct === null ? '—' : `${sign(n.growth_pct)} %` }}</td>
                  <td class="num" :class="{ warnText: n.roi !== null && n.prior_roi !== null && n.roi < n.prior_roi }">{{ fmtRoi(n.roi) }}</td>
                  <td class="num">{{ fmtRoi(n.prior_roi) }}</td><td class="num" :class="{ redText: n.overdue }">{{ n.overdue || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="grid2" style="margin-top: 12px">
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">Пульс переговоров</div><div class="spacer" /><span class="note">последние встречи, звонки и письма</span></div>
          <div class="panelBody">
            <div v-for="a in d.pulse" :key="a.id" class="pulseItem" @click="go('campaign', a.campaign_id)">
              <div class="pulseHead"><b>{{ a.network }}</b> · {{ KIND[a.kind] }}{{ a.contact ? ` с ${a.contact}` : '' }}<time>{{ fmtTime(a.at) }}</time></div>
              <div class="cellSub">{{ a.title }} · {{ a.owner }}</div>
              <div class="pulseText">{{ a.outcome }}</div>
            </div>
            <div v-if="!d.pulse.length" class="muted">Завершённых активностей пока нет.</div>
          </div>
        </div>
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">Запланировано</div></div>
          <div class="panelBody">
            <div v-for="a in d.upcoming" :key="a.id" class="pulseItem" @click="go('campaign', a.campaign_id)">
              <div class="pulseHead"><b>{{ a.network }}</b> · {{ KIND[a.kind] }}{{ a.contact ? ` с ${a.contact}` : '' }}<time>{{ fmtTime(a.at) }}</time></div>
              <div class="cellSub">{{ a.title }} · {{ a.owner }}</div>
              <div class="pulseText">{{ a.purpose }}</div>
            </div>
            <div v-if="!d.upcoming.length" class="muted">Запланированных активностей нет.</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue';
import { QTooltip } from 'quasar';
import { api } from '../api';
import { base, go, state, announceTitle } from '../store';
import { STAGE_LABEL, fmtRoi, fmtShort, fmtTime, plural } from '../format';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';

/* eslint-disable @typescript-eslint/no-explicit-any */
const d = ref<any>(null);
const loading = ref(false);
const thisYear = new Date().getFullYear();
const year = ref(String(thisYear + 1));
const type = ref<string | null>(null);
const group = ref<string | null>(null);
const network = ref<string | null>(null);
const owner = ref<string | null>(null);
const prev = computed(() => String(Number(year.value) - 1));
const yearOptions = [thisYear - 1, thisYear, thisYear + 1].map((y) => ({ label: `${y} год`, value: String(y) }));
const typeOptions = computed(() => (state.ref?.types ?? []).map((t) => ({ label: t.name, value: t.id })));
const groupOptions = computed(() => (state.ref?.groups ?? []).map((g) => ({ label: g.name, value: g.id })));
const networkOptions = computed(() => (state.ref?.networks ?? []).map((n) => ({ label: n.name, value: n.id })));
const ownerOptions = computed(() => (state.ref?.owners ?? []).map((o) => ({ label: o.name, value: o.id })));
const KIND: Record<string, string> = { MEETING: 'встреча', CALL: 'звонок', EMAIL: 'письмо' };

const funnelRows = computed(() => (d.value?.funnel ?? []).filter((f: any) => f.stage !== 'CLOSED' || f.count));
const maxFunnel = computed(() => Math.max(1, ...funnelRows.value.map((f: any) => f.count)));
const maxTiming = computed(() => Math.max(1, ...(d.value?.timing ?? []).map((t: any) => t.avg_days ?? 0)));
const maxBrand = computed(() => Math.max(1, ...(d.value?.by_brand ?? []).filter((b: any) => b.brand_id).flatMap((b: any) => [b.investment, b.prior_fact_investment])));
const maxQuarter = computed(() => Math.max(1, ...(d.value?.by_quarter ?? []).flatMap((q: any) => [q.investment, q.prior_fact_investment])));
const pct = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
const ru = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('ru-RU'));
const sign = (v: number) => (v > 0 ? `+${v.toLocaleString('ru-RU')}` : v.toLocaleString('ru-RU'));
const tone = (g: number | null, limit: number) => ({ warnText: g !== null && g > limit });

// Полоса плана и отметка факта прошлого года на одной шкале.
const BarCell = defineComponent({
  props: { value: { type: Number, required: true }, prior: { type: Number, required: true }, max: { type: Number, required: true }, label: { type: String, required: true } },
  setup(p) {
    return () => h('div', { class: 'barTrack' }, [
      h('div', { class: 'bar', style: { width: pct(p.value, p.max) } }),
      p.prior > 0 ? h('div', { class: 'priorTick', style: { left: `calc(${pct(Math.min(p.prior, p.max), p.max)} - 1px)` } }) : null,
      h(QTooltip, null, () => p.label),
    ]);
  },
});

function openNetwork(id: string) { network.value = id; }

async function load() {
  loading.value = true;
  try {
    d.value = await api.get(`${base()}/analytics`, { year: year.value, type: type.value ?? '', group: group.value ?? '', network: network.value ?? '', owner: owner.value ?? '' });
  } finally { loading.value = false; }
}
watch([year, type, group, network, owner], load);
onMounted(() => { announceTitle('Аналитика'); void load(); });
</script>

<style scoped>
.filters { flex-wrap: wrap; margin-bottom: 12px; }
.kpiRow { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.kpiTile { border: 1px solid var(--line); border-radius: 10px; background: #fff; padding: 12px 14px; }
.kpiTile.alert { border-color: #fda29b; }
.kLabel { color: var(--text-2); font-size: 12px; }
.kValue { color: var(--ink); font-size: 22px; font-weight: 600; margin-top: 4px; }
.kSmall { font-size: 14px; font-weight: 500; color: var(--text-2); }
.kSub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.grid2 > * { min-width: 0; }
.barRow { display: grid; grid-template-columns: 170px minmax(0, 1fr) 150px; gap: 10px; align-items: center; padding: 5px 0; }
.barLabel { color: var(--text); font-size: 12.5px; }
.barVal { display: grid; text-align: right; font-variant-numeric: tabular-nums; }
.analytics :deep(.barTrack) { position: relative; height: 14px; border-radius: 4px; background: #f2f4f7; }
.analytics :deep(.bar) { height: 100%; border-radius: 0 4px 4px 0; background: var(--purple); min-width: 2px; }
.analytics :deep(.bar.muted) { background: #98a2b3; }
.analytics :deep(.priorTick) { position: absolute; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: #344054; }
.legend { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); margin-left: 12px; }
.legend .swatch { width: 12px; height: 8px; border-radius: 2px; background: var(--purple); }
.legend .tick { width: 2px; height: 12px; border-radius: 1px; background: #344054; }
.analytics :deep(.miniTable td.num) { white-space: nowrap; }
.otherRow td { color: var(--text-2); font-style: italic; }
.clickRow { cursor: pointer; }
.clickRow:hover td { background: var(--hover); }
.redText { color: var(--red); }
.warnText { color: #b54708; }
.pulseItem { padding: 8px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
.pulseItem:last-child { border-bottom: 0; }
.pulseItem:hover { background: var(--hover); }
.pulseHead { display: flex; gap: 6px; align-items: baseline; font-size: 12.5px; color: var(--ink); }
.pulseHead time { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
.pulseText { color: var(--text); margin-top: 2px; font-size: 12.5px; }
@media (max-width: 1200px) { .kpiRow { grid-template-columns: repeat(3, minmax(0, 1fr)); } .grid2 { grid-template-columns: 1fr; } }
</style>
