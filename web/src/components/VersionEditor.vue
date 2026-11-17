<template>
  <q-dialog :model-value="true" persistent maximized transition-show="fade" transition-hide="fade" @hide="emit('close')">
    <div class="q-card editorCard">
      <div class="dlgHead">
        <div>
          <div class="dlgTitle">Новая версия предложения · {{ title }}</div>
          <div class="dlgSub">Инвестиции и ожидаемый оборот по брендам и периодам, в рублях. {{ draft?.base_number ? `Основа — версия ${draft.base_number}; после сохранения версию нельзя изменить.` : 'После сохранения версию нельзя изменить.' }}</div>
        </div>
        <div class="spacer" />
        <button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
      </div>

      <div v-if="!draft" class="dlgBody"><q-spinner size="24px" /></div>
      <div v-else class="dlgBody editorBody">
        <div class="kpiGrid" style="grid-template-columns: repeat(4, minmax(0, 1fr))">
          <div class="kpi"><div class="kpiLabel">Инвестиции</div><div class="kpiValue">{{ fmtShort(totals.investment) }}</div><div class="kpiSub">{{ priorSub('investment') }}</div></div>
          <div class="kpi"><div class="kpiLabel">Ожидаемый оборот</div><div class="kpiValue">{{ fmtShort(totals.turnover) }}</div><div class="kpiSub">{{ priorSub('turnover') }}</div></div>
          <div class="kpi"><div class="kpiLabel">ROI (оборот на 1 ₽ инвестиций)</div><div class="kpiValue">{{ fmtRoi(roi(totals)) }}</div><div class="kpiSub">{{ priorTotal?.fact_roi ? `факт ${draft.prior_label}: ${fmtRoi(priorTotal.fact_roi)}` : 'нет факта прошлого периода' }}</div></div>
          <div class="kpi"><div class="kpiLabel">Брендов в разбивке</div><div class="kpiValue">{{ filledBrands }}</div><div class="kpiSub">бренды без сумм не сохраняются</div></div>
        </div>

        <div class="toolbar" style="margin: 14px 0 10px">
          <div class="tdTabs" role="tablist" aria-label="Показатель">
            <button role="tab" :class="{ active: metric === 'investment' }" @click="metric = 'investment'">Инвестиции, ₽</button>
            <button role="tab" :class="{ active: metric === 'turnover' }" @click="metric = 'turnover'">Ожидаемый оборот, ₽</button>
          </div>
          <TdSelect v-model="addBrand" :options="brandOptions" placeholder="Добавить бренд" aria-label="Добавить бренд" style="width: 220px" @update:model-value="onAddBrand" />
          <div class="spacer" />
          <a class="tdBtn" :href="templateUrl" download><Icon id="download-01" :size="15" /><span>Шаблон Excel</span></a>
          <button class="tdBtn" :disabled="parsing" @click="fileInput?.click()"><q-spinner v-if="parsing" size="14px" /><Icon v-else id="upload-01" :size="15" /><span>Загрузить из Excel</span></button>
          <input ref="fileInput" type="file" accept=".xlsx" hidden @change="onFile" />
        </div>
        <div class="fieldHint" style="margin: -4px 0 8px">Можно вставить блок ячеек из Excel (Cmd+V) в любую ячейку таблицы — значения разложатся вправо и вниз.</div>
        <div v-if="issues.length" class="banner error" style="margin-bottom: 10px">
          <Icon id="alert-triangle" :size="15" />
          <div><b>В файле есть ошибки — значения из этих ячеек не загружены:</b>
            <div v-for="(i, n) in issues.slice(0, 8)" :key="n">{{ i.row ? `строка ${i.row}${i.column ? `, столбец ${i.column}` : ''}: ` : '' }}{{ i.message }}</div>
            <div v-if="issues.length > 8">…и ещё {{ issues.length - 8 }}</div></div>
        </div>

        <div class="miniWrap gridWrap">
          <table class="miniTable grid">
            <thead>
              <tr>
                <th class="sticky">Бренд</th>
                <th v-for="p in draft.periods" :key="p.key" class="num">{{ p.label }}</th>
                <th class="num">Итого</th>
                <th class="num">Факт {{ draft.prior_label || 'прошлого' }}</th>
                <th>Комментарий к бренду</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(b, ri) in rows" :key="b.id">
                <td class="sticky"><b>{{ b.name }}</b><div v-if="highlightOf(b.id)" class="cellSub warnText">{{ highlightOf(b.id) }}</div></td>
                <td v-for="(p, ci) in draft.periods" :key="p.key" class="cellIn">
                  <input :value="values[key(b.id, p.key)]?.[metric] ?? ''" inputmode="decimal" :aria-label="`${b.name}, ${p.label}`"
                         @input="(e) => setVal(b.id, p.key, (e.target as HTMLInputElement).value)" @paste="(e) => onPaste(e, ri, ci)" />
                </td>
                <td class="num"><b>{{ fmtNum(rowTotal(b.id)[metric]) }}</b></td>
                <td class="num muted">{{ fmtNum(priorOf(b.id)) }}</td>
                <td class="noteIn"><input v-model="notes[b.id]" maxlength="1000" placeholder="—" :aria-label="`Комментарий: ${b.name}`" /></td>
                <td class="actionCell"><button class="iconBtn" :aria-label="`Убрать ${b.name}`" @click="removeRow(b.id)"><Icon id="trash-01" :size="15" /></button></td>
              </tr>
              <tr v-if="!rows.length"><td :colspan="draft.periods.length + 5" class="muted">Добавьте бренды кнопкой «Добавить бренд» или загрузите шаблон Excel.</td></tr>
            </tbody>
            <tfoot v-if="rows.length">
              <tr>
                <td class="sticky"><b>Итого</b></td>
                <td v-for="p in draft.periods" :key="p.key" class="num"><b>{{ fmtNum(colTotal(p.key)) }}</b></td>
                <td class="num"><b>{{ fmtNum(totals[metric]) }}</b></td>
                <td class="num muted">{{ fmtNum(priorTotal ? (metric === 'investment' ? priorTotal.fact_investment : priorTotal.fact_turnover) : null) }}</td>
                <td colspan="2" />
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="formGrid" style="margin-top: 16px">
          <div class="full">
            <label class="fieldLabel" for="ve-just">Обоснование</label>
            <q-input for="ve-just" v-model="justification" type="textarea" autogrow outlined dense maxlength="5000" aria-label="Обоснование" hide-bottom-space
                     placeholder="Почему такие условия и как они соотносятся с результатами прошлого периода" />
            <div class="fieldHint">Обязательно при отправке на согласование. Согласующий увидит его рядом со сравнением с прошлым периодом.</div>
          </div>
          <div>
            <label class="fieldLabel" for="ve-comment">Что изменилось в версии</label>
            <q-input for="ve-comment" v-model="comment" outlined dense maxlength="2000" aria-label="Комментарий к версии" hide-bottom-space placeholder="Например, учли встречное предложение сети" />
          </div>
          <div>
            <label class="fieldLabel">Документы версии</label>
            <div v-if="docs.length" class="checkList" style="max-height: 140px">
              <label v-for="d in docs" :key="d.id"><input v-model="docIds" type="checkbox" :value="d.id" /><span style="flex: 1">{{ d.file_name }}</span><span class="sub">{{ DOC_KIND[d.kind] }}</span></label>
            </div>
            <div v-else class="fieldHint">В кампании пока нет документов — их можно загрузить в карточке.</div>
          </div>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>

      <div class="dlgFoot">
        <span class="note">Итог: {{ fmtRub(totals.investment) }} инвестиций · {{ fmtRub(totals.turnover) }} оборота</span>
        <div class="spacer" />
        <button v-close-popup class="tdBtn">Отмена</button>
        <button class="tdBtn primary" :disabled="busy || !filledBrands" @click="save"><q-spinner v-if="busy" size="14px" /><span>Сохранить версию {{ (draft?.base_number ?? 0) + 1 }}</span></button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { base, state } from '../store';
import { useCommand } from '../command';
import { DOC_KIND, fmtRoi, fmtRub, fmtShort, HIGHLIGHT } from '../format';
import type { Doc, Draft, Money, PriorView } from '../types';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const props = defineProps<{ campaignId: string; etag: string; title: string; documents: Doc[] }>();
const emit = defineEmits<{ close: []; saved: [number: number] }>();
const { err, busy, run } = useCommand();
type Metric = 'investment' | 'turnover';
const metric = ref<Metric>('investment');
const draft = ref<Draft | null>(null);
const rows = ref<{ id: string; name: string }[]>([]);
const values = reactive<Record<string, { investment: string; turnover: string }>>({});
const notes = reactive<Record<string, string>>({});
const justification = ref('');
const comment = ref('');
const docIds = ref<string[]>([]);
const addBrand = ref<string | null>(null);
const issues = ref<{ row: number; column: string; message: string }[]>([]);
const parsing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const key = (b: string, p: string) => `${b}|${p}`;
const docs = computed(() => props.documents.filter((d) => !d.archived_at));
const templateUrl = computed(() => api.url(`${base()}/campaigns/${props.campaignId}/versions/template.xlsx`));
const brandName = (id: string) => state.ref?.brands.find((b) => b.id === id)?.name ?? 'Бренд';
const brandOptions = computed(() => (state.ref?.brands ?? []).filter((b) => !rows.value.some((r) => r.id === b.id)).map((b) => ({ label: b.name, value: b.id })));

/** Число из поля ввода: пробелы и запятая допускаются; пустое — ноль; иначе NaN. */
const parseNum = (s: string | undefined) => {
  const t = (s ?? '').replace(/[\s ₽]/g, '').replace(',', '.');
  return t === '' ? 0 : Number(t);
};
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmtNum = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? '—' : nf.format(v));
const roi = (m: Money) => (m.investment > 0 ? m.turnover / m.investment : null);

function rowTotal(b: string): Money {
  return (draft.value?.periods ?? []).reduce((a, p) => ({ investment: a.investment + (parseNum(values[key(b, p.key)]?.investment) || 0), turnover: a.turnover + (parseNum(values[key(b, p.key)]?.turnover) || 0) }), { investment: 0, turnover: 0 });
}
const colTotal = (p: string) => rows.value.reduce((a, b) => a + (parseNum(values[key(b.id, p)]?.[metric.value]) || 0), 0);
const totals = computed<Money>(() => rows.value.reduce((a, b) => { const t = rowTotal(b.id); return { investment: a.investment + t.investment, turnover: a.turnover + t.turnover }; }, { investment: 0, turnover: 0 }));
const filledBrands = computed(() => rows.value.filter((b) => { const t = rowTotal(b.id); return t.investment > 0 || t.turnover > 0; }).length);
const prior = (b: string): PriorView | null => draft.value?.prior[b] ?? null;
const priorOf = (b: string) => { const p = prior(b); return p ? (metric.value === 'investment' ? p.fact_investment : p.fact_turnover) : null; };
const priorTotal = computed<PriorView | null>(() => {
  const ps = rows.value.map((b) => prior(b.id)).filter((p): p is PriorView => Boolean(p));
  if (!ps.length) return null;
  const fi = ps.reduce((a, p) => a + (p.fact_investment ?? 0), 0);
  const ft = ps.reduce((a, p) => a + (p.fact_turnover ?? 0), 0);
  return { plan_investment: null, plan_turnover: null, fact_investment: fi, fact_turnover: ft, plan_roi: null, fact_roi: fi ? ft / fi : null, execution_pct: null };
});
function priorSub(m: Metric) {
  const p = priorTotal.value;
  const base = p ? (m === 'investment' ? p.fact_investment : p.fact_turnover) : null;
  if (!base) return 'нет факта прошлого периода';
  const d = ((totals.value[m] - base) / base) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')} % к факту ${draft.value?.prior_label}`;
}
// Те же правила, что у согласующего, — чтобы КАМ видел их до отправки.
function highlightOf(b: string): string {
  const p = prior(b);
  const t = rowTotal(b);
  if (!t.investment && !t.turnover) return '';
  if (!p) return HIGHLIGHT.NO_PRIOR!.label;
  const th = draft.value!.thresholds;
  const out: string[] = [];
  if (p.fact_investment && t.investment > p.fact_investment * (1 + th.investment_growth_pct / 100)) out.push(HIGHLIGHT.INVESTMENT_GROWTH!.label);
  const r = roi(t);
  if (th.roi_below_prior && r !== null && p.fact_roi !== null && r < p.fact_roi) out.push(HIGHLIGHT.ROI_BELOW_PRIOR!.label);
  if (p.execution_pct !== null && p.execution_pct < th.execution_below_pct) out.push(HIGHLIGHT.PRIOR_UNDERPERFORMED!.label);
  return out.join(' · ');
}

function ensureRow(id: string) {
  if (!rows.value.some((r) => r.id === id)) rows.value.push({ id, name: brandName(id) });
}
function setVal(b: string, p: string, v: string) {
  const k = key(b, p);
  values[k] = { ...(values[k] ?? { investment: '', turnover: '' }), [metric.value]: v };
}
function onAddBrand(id: unknown) {
  if (typeof id === 'string') ensureRow(id);
  addBrand.value = null;
}
function removeRow(id: string) {
  rows.value = rows.value.filter((r) => r.id !== id);
  for (const p of draft.value?.periods ?? []) delete values[key(id, p.key)];
  delete notes[id];
}
function fill(cells: { brand_id: string; period_key: string; investment: number; turnover: number }[]) {
  for (const c of cells) {
    ensureRow(c.brand_id);
    values[key(c.brand_id, c.period_key)] = { investment: c.investment ? String(c.investment) : '', turnover: c.turnover ? String(c.turnover) : '' };
  }
}
// Вставка блока из Excel: строки — бренды вниз от текущей, столбцы — периоды вправо.
function onPaste(e: ClipboardEvent, ri: number, ci: number) {
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!/[\t\n]/.test(text.trim())) return;
  e.preventDefault();
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
  const periods = draft.value!.periods;
  lines.forEach((cols, dr) => {
    const row = rows.value[ri + dr];
    if (!row) return;
    cols.forEach((v, dc) => { const p = periods[ci + dc]; if (p) setVal(row.id, p.key, v.trim()); });
  });
}

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  parsing.value = true;
  issues.value = [];
  try {
    const form = new FormData();
    form.append('file', f);
    const r = await api.upload<{ cells: Draft['cells']; issues: typeof issues.value }>(`${base()}/campaigns/${props.campaignId}/versions/parse`, form);
    issues.value = r.data.issues;
    if (r.data.cells.length) {
      // Файл заменяет разбивку целиком: бренды из файла, остальные убираются.
      rows.value = [];
      for (const k of Object.keys(values)) delete values[k];
      fill(r.data.cells);
    }
  } catch (x) {
    issues.value = [{ row: 0, column: '', message: (x as Error).message }];
  } finally {
    parsing.value = false;
  }
}

async function save() {
  const cells: Draft['cells'] = [];
  for (const b of rows.value) {
    for (const p of draft.value!.periods) {
      const v = values[key(b.id, p.key)];
      const inv = parseNum(v?.investment);
      const turn = parseNum(v?.turnover);
      if (Number.isNaN(inv) || Number.isNaN(turn)) { err.message = `${b.name}, ${p.label}: введите число.`; return; }
      if (inv || turn) cells.push({ brand_id: b.id, period_key: p.key, investment: inv, turnover: turn });
    }
  }
  const brand_notes = Object.fromEntries(Object.entries(notes).filter(([id, n]) => n?.trim() && cells.some((c) => c.brand_id === id)));
  const r = await run(() => api.post<{ number: number }>(`${base()}/campaigns/${props.campaignId}/versions`,
    { cells, justification: justification.value, comment: comment.value, brand_notes, document_ids: docIds.value }, props.etag));
  if (r) emit('saved', r.data.number);
}

onMounted(async () => {
  const d = await api.get<Draft>(`${base()}/campaigns/${props.campaignId}/versions/draft`);
  draft.value = d;
  justification.value = d.justification;
  fill(d.cells);
  // Новая кампания: строки брендов, по которым у сети был прошлый период.
  if (!d.cells.length) for (const id of Object.keys(d.prior)) ensureRow(id);
  rows.value.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
});
</script>

<style scoped>
.editorCard { display: flex; flex-direction: column; background: #fff; }
.editorBody { flex: 1; overflow-y: auto; max-width: 1400px; width: 100%; margin: 0 auto; }
.gridWrap { overflow-x: auto; }
.grid th, .grid td { white-space: nowrap; }
.grid .num { text-align: right; font-variant-numeric: tabular-nums; }
.grid .sticky { position: sticky; left: 0; background: #fff; z-index: 1; min-width: 160px; white-space: normal; }
.grid thead .sticky { background: #f9fafb; }
.grid tfoot td { background: #fcfcfd; border-top: 1px solid var(--line); }
.cellIn input, .noteIn input { width: 112px; height: 28px; border: 1px solid var(--control); border-radius: 6px; padding: 0 8px; font: inherit; text-align: right; font-variant-numeric: tabular-nums; }
.noteIn input { width: 200px; text-align: left; }
.cellIn input:focus, .noteIn input:focus { outline: 2px solid var(--purple-line); border-color: var(--purple); }
.warnText { color: #b54708; }
.dlgFoot { border-top: 1px solid var(--line); }
</style>
