<template>
  <div v-if="loading && !c" class="panel emptyState"><q-spinner size="24px" /></div>
  <div v-else-if="error" class="panel emptyState"><Icon id="alert-circle" :size="28" /><br />{{ error }}<br /><button class="tdBtn" style="margin-top: 12px" @click="go('portfolio')">К портфелю</button></div>
  <div v-else-if="c">
    <div class="headPanel">
      <div class="headTop">
        <div style="min-width: 0">
          <div class="headTitle">{{ c.network.name }} — {{ c.title }}</div>
          <div class="metaTags">
            <span class="metaTag">{{ campaignNo(c.number) }}</span>
            <span class="metaTag">{{ c.type.name }}</span>
            <span class="metaTag"><Icon id="calendar" :size="12" />{{ fmtPeriod(c.period_from, c.period_to) }}</span>
            <span class="metaTag" :class="{ red: c.overdue }"><Icon id="clock" :size="12" />Согласовать до {{ fmtDate(c.control_date) }}{{ c.overdue ? ' · просрочено' : '' }}</span>
            <span class="metaTag"><Icon id="user-01" :size="12" />{{ c.owner.name }}</span>
            <span class="metaTag"><Icon id="building-07" :size="12" />{{ selectedEntities.length }} {{ plural(selectedEntities.length, 'юрлицо', 'юрлица', 'юрлиц') }}</span>
          </div>
        </div>
        <div class="headActions">
          <button v-if="has('CANCEL')" class="tdBtn danger" @click="cancelDlg = true">Отменить кампанию</button>
          <button v-if="has('EDIT')" class="tdBtn" @click="editDlg = true"><Icon id="edit-05" :size="15" /><span>Изменить</span></button>
          <button v-if="has('START_NEGOTIATION')" class="tdBtn primary" :disabled="busy" @click="move('START_NEGOTIATION')"><span>Начать переговоры</span><Icon id="arrow-right" :size="15" /></button>
          <button v-if="has('CLOSE')" class="tdBtn primary" :disabled="busy" @click="move('CLOSE')">Закрыть кампанию</button>
        </div>
      </div>
      <div class="steps" :class="{ halted: c.stage === 'CANCELLED' }" aria-label="Этапы кампании">
        <div v-for="(s, i) in STAGES" :key="s" class="step" :class="{ done: i < currentIndex, current: i === currentIndex }" :aria-current="i === currentIndex ? 'step' : undefined">
          <span class="num"><Icon v-if="i < currentIndex" id="check" :size="12" /><template v-else>{{ i + 1 }}</template></span>
          <span class="txt">{{ STAGE_LABEL[s] }}</span>
        </div>
      </div>
      <div v-if="c.stage === 'CANCELLED'" class="banner error" style="margin-top: 10px"><Icon id="x-circle" :size="15" /><span><b>Кампания отменена.</b> {{ c.cancel_reason }}</span></div>
      <div v-else-if="c.stage === 'CLOSED'" class="banner info" style="margin-top: 10px"><Icon id="check-circle" :size="15" /><span>Кампания закрыта: условия переданы в контроль исполнения.</span></div>
    </div>

    <!-- Предложение: текущая или выбранная версия -->
    <div v-if="version" class="kpiGrid" style="margin-top: 12px">
      <div class="kpi"><div class="kpiLabel">План инвестиций</div><div class="kpiValue">{{ fmtShort(version.totals.investment) }}</div><div class="kpiSub">{{ vsPrior('investment') }}</div></div>
      <div class="kpi"><div class="kpiLabel">Ожидаемый оборот</div><div class="kpiValue">{{ fmtShort(version.totals.turnover) }}</div><div class="kpiSub">{{ vsPrior('turnover') }}</div></div>
      <div class="kpi"><div class="kpiLabel">ROI<q-tooltip>Ожидаемый оборот на 1 ₽ инвестиций; это не окупаемость.</q-tooltip></div><div class="kpiValue">{{ fmtRoi(version.totals.roi) }}</div>
        <div class="kpiSub">{{ version.totals.prior?.fact_roi ? `факт ${version.prior_label}: ${fmtRoi(version.totals.prior.fact_roi)}` : 'нет факта прошлого периода' }}</div></div>
      <div class="kpi"><div class="kpiLabel">Версия предложения</div><div class="kpiValue">v{{ version.number }}<span v-if="version.number !== version.latest" class="muted" style="font-size: 12px; font-weight: 500"> · не текущая</span></div>
        <div class="kpiSub">{{ version.author }}, {{ fmtDate(version.created_at) }}</div></div>
    </div>

    <div class="twoCol">
      <div class="stack">
        <div class="panel">
          <div class="panelHead">
            <div class="panelTitle">Разбивка предложения</div>
            <span v-if="version?.brand_limited" class="pill gray">ваши бренды подробно, остальные — итогом</span>
            <div class="spacer" />
            <div v-if="version" class="tdTabs small" role="tablist" aria-label="Показатель">
              <button v-for="m in metrics" :key="m.key" role="tab" :class="{ active: metric === m.key }" @click="metric = m.key">{{ m.label }}</button>
            </div>
            <button v-if="has('NEW_VERSION')" class="tdBtn primary" @click="editorOpen = true"><Icon id="plus" :size="15" /><span>{{ versions.length ? 'Новая версия' : 'Первая версия' }}</span></button>
          </div>
          <div class="panelBody">
            <div v-if="!version" class="placeholder">
              <Icon id="layers-three-01" :size="20" />
              <div><div style="color: var(--text); font-weight: 600">Версий пока нет</div>
                Версия — это инвестиции и ожидаемый оборот по брендам и {{ splitText }}. Её можно ввести вручную, вставить из Excel или загрузить по шаблону.</div>
            </div>
            <template v-else>
              <div class="note" style="margin-bottom: 8px">Суммы в тыс. ₽. Под суммой периода — факт того же квартала прошлого года.</div>
              <BreakdownTable :version="version" :metric="metric" />
              <div v-if="version.totals.highlights.length && version.totals.highlights[0] !== 'NO_PRIOR'" class="banner warn" style="margin-top: 10px">
                <Icon id="alert-triangle" :size="15" /><span><b>Для согласующего:</b> {{ version.totals.highlights.map((h) => HIGHLIGHT[h]?.label).join(', ') }} по кампании в целом.</span>
              </div>
            </template>
          </div>
        </div>

        <div v-if="version" class="panel">
          <div class="panelHead"><div class="panelTitle">Обоснование версии {{ version.number }}</div></div>
          <div class="panelBody">
            <div v-if="version.justification" style="white-space: pre-wrap">{{ version.justification }}</div>
            <div v-else class="muted">Обоснование не заполнено — оно понадобится при отправке на согласование.</div>
            <div v-if="version.comment" class="cellSub" style="margin-top: 8px">Что изменилось: {{ version.comment }}</div>
            <div v-if="version.documents.length" class="chips" style="margin-top: 8px">
              <span v-for="d in version.documents" :key="d.id" class="pill gray"><Icon id="file-05" :size="12" />{{ d.file_name }}</span>
            </div>
          </div>
        </div>

        <div v-if="versions.length" class="panel">
          <div class="panelHead"><div class="panelTitle">Версии предложения</div></div>
          <div class="panelBody">
            <div class="miniWrap">
              <table class="miniTable">
                <thead><tr><th style="width: 70px">Версия</th><th>Автор и дата</th><th class="num">Инвестиции</th><th class="num">Оборот</th><th class="num">ROI</th><th>Что изменилось</th><th style="width: 90px"></th></tr></thead>
                <tbody>
                  <tr v-for="v in versions" :key="v.number" :class="{ current: version?.number === v.number }">
                    <td><b>v{{ v.number }}</b><span v-if="v.number === versions[0]!.number" class="pill purple" style="margin-left: 6px">текущая</span></td>
                    <td>{{ v.author }}<div class="cellSub">{{ fmtTime(v.created_at) }}</div></td>
                    <td class="num">{{ fmtShort(v.investment) }}</td>
                    <td class="num">{{ fmtShort(v.turnover) }}</td>
                    <td class="num">{{ fmtRoi(v.roi) }}</td>
                    <td><span class="cellSub">{{ v.comment || '—' }}</span></td>
                    <td class="actionCell"><button v-if="version?.number !== v.number" class="linkBtn" @click="openVersion(v.number)">Показать</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <DocumentsPanel :campaign-id="c.id" :documents="documents" :can-upload="has('UPLOAD')" @changed="onDocsChanged" />

        <div class="panel">
          <div class="panelHead">
            <div class="panelTitle">Юрлица кампании</div>
            <div class="spacer" />
            <span class="note">Исполнение в PharmaCheck отслеживается по этим ИНН</span>
          </div>
          <div class="panelBody">
            <div class="miniWrap">
              <table class="miniTable">
                <thead><tr><th>Юрлицо</th><th style="width: 140px">ИНН</th><th style="width: 120px">В кампании</th></tr></thead>
                <tbody>
                  <tr v-for="e in c.legal_entities" :key="e.id" :class="{ inactive: !e.selected }">
                    <td>{{ e.name }}<span v-if="!e.active" class="pill red" style="margin-left: 6px">неактивно</span></td>
                    <td class="mono">{{ e.inn }}</td>
                    <td><span v-if="e.selected" class="pill green">включено</span><span v-else class="muted">не включено</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="stack">
      <ApprovalPanel :campaign-id="c.id" :etag="etag" :view="approval" @changed="onApprovalChanged" />
      <div class="panel">
        <div class="panelHead"><div class="panelTitle">История</div></div>
        <div class="panelBody">
          <ul class="timeline">
            <li v-for="(e, i) in c.events" :key="e.id" :class="{ first: i === 0 }">
              <time>{{ fmtTime(e.at) }}</time>
              <strong>{{ eventTitle(e) }}</strong>
              <span>{{ e.actor_name ?? 'Система' }}</span>
              <span v-if="e.comment" class="comment">{{ e.comment }}</span>
            </li>
          </ul>
        </div>
      </div>
      </div>
    </div>

    <VersionEditor v-if="editorOpen" :campaign-id="c.id" :etag="etag" :title="`${c.network.name} — ${c.title}`" :documents="documents" @close="editorOpen = false" @saved="afterVersion" />
    <EditCampaignDialog v-if="editDlg" :campaign="c" :etag="etag" @close="editDlg = false" @saved="afterSave" />
    <q-dialog v-if="cancelDlg" :model-value="true" persistent @hide="cancelDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead">
          <div><div class="dlgTitle">Отменить кампанию</div><div class="dlgSub">Кампания останется в истории со статусом «Отменена». Восстановить её нельзя — при необходимости создайте новую.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
        </div>
        <div class="dlgBody">
          <label class="fieldLabel" for="cn-reason">Причина<span class="req">*</span></label>
          <q-input for="cn-reason" v-model="reason" type="textarea" autogrow outlined dense maxlength="2000" aria-label="Причина отмены" hide-bottom-space autofocus />
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot">
          <button v-close-popup class="tdBtn">Не отменять</button>
          <button class="tdBtn primary" :disabled="busy || !reason.trim()" @click="move('CANCEL', reason)">Отменить кампанию</button>
        </div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api, ApiError } from '../api';
import { base, go, announceTitle, refreshPending } from '../store';
import { useCommand } from '../command';
import { HIGHLIGHT, STAGES, STAGE_LABEL, campaignNo, deltaPct, fmtDate, fmtDelta, fmtPeriod, fmtRoi, fmtShort, fmtTime, plural } from '../format';
import Icon from '../components/Icon.vue';
import EditCampaignDialog from '../components/EditCampaignDialog.vue';
import type { ApprovalView, Campaign, Doc, Version, VersionSummary } from '../types';
import BreakdownTable from '../components/BreakdownTable.vue';
import VersionEditor from '../components/VersionEditor.vue';
import DocumentsPanel from '../components/DocumentsPanel.vue';
import ApprovalPanel from '../components/ApprovalPanel.vue';

const props = defineProps<{ id: string }>();
const $q = useQuasar();
const setCrumb = inject<(t: string) => void>('setCrumb', () => undefined);
const c = ref<Campaign | null>(null);
const etag = ref('');
const loading = ref(true);
const error = ref('');
const editDlg = ref(false);
const cancelDlg = ref(false);
const reason = ref('');
const { err, busy, run } = useCommand();
const versions = ref<VersionSummary[]>([]);
const version = ref<Version | null>(null);
const documents = ref<Doc[]>([]);
const editorOpen = ref(false);
const approval = ref<ApprovalView | null>(null);
async function loadApproval() {
  approval.value = await api.get<ApprovalView>(`${base()}/campaigns/${props.id}/approval`);
}
const onApprovalChanged = () => Promise.all([load(), loadApproval(), refreshPending()]);
type Metric = 'investment' | 'turnover' | 'roi';
const metric = ref<Metric>('investment');
const metrics: { key: Metric; label: string }[] = [{ key: 'investment', label: 'Инвестиции' }, { key: 'turnover', label: 'Оборот' }, { key: 'roi', label: 'ROI' }];
function vsPrior(m: 'investment' | 'turnover') {
  const p = version.value?.totals.prior;
  const base = p ? (m === 'investment' ? p.fact_investment : p.fact_turnover) : null;
  if (!base) return 'нет факта прошлого периода';
  return `${fmtDelta(deltaPct(version.value!.totals[m], base))} к факту ${version.value!.prior_label}`;
}
async function loadVersions() {
  versions.value = (await api.get<{ items: VersionSummary[] }>(`${base()}/campaigns/${props.id}/versions`)).items;
  version.value = versions.value.length ? await api.get<Version>(`${base()}/campaigns/${props.id}/versions/current`) : null;
}
async function openVersion(n: number) {
  version.value = await api.get<Version>(`${base()}/campaigns/${props.id}/versions/${n}`);
}
async function loadDocs() {
  documents.value = (await api.get<{ items: Doc[] }>(`${base()}/campaigns/${props.id}/documents`)).items;
}
const onDocsChanged = () => Promise.all([loadDocs(), load(), loadApproval()]);
async function afterVersion(n: number, info?: { stage: string; tolerance: { within: boolean; reason: string } | null }) {
  editorOpen.value = false;
  $q.notify({ type: 'positive', message: `Версия ${n} сохранена` });
  if (info?.tolerance) $q.notify({ type: info.tolerance.within ? 'info' : 'warning', message: info.tolerance.reason, timeout: 8000 });
  await Promise.all([load(), loadVersions(), loadDocs(), loadApproval()]);
}

const has = (a: string) => c.value?.actions.includes(a) ?? false;
const selectedEntities = computed(() => c.value?.legal_entities.filter((e) => e.selected) ?? []);
const currentIndex = computed(() => {
  const s = c.value?.stage ?? '';
  if (s === 'CLOSED') return STAGES.length;
  if (s === 'CANCELLED') {
    const last = c.value!.events.find((e) => e.to_stage === 'CANCELLED')?.from_stage ?? 'PREPARATION';
    return STAGES.indexOf(last as never);
  }
  return STAGES.indexOf(s as never);
});
const splitText = computed(() => ({ MONTH: 'месяцам', QUARTER: 'кварталам', FOUR_MONTHS: 'периодам по четыре месяца', WHOLE: 'периоду' } as Record<string, string>)[c.value?.type.period_split ?? 'QUARTER']);

const CHANGE_TEXT = (p: any) => (p?.changes?.length ? `Изменены: ${p.changes.join(', ')}` : 'Изменены реквизиты');
function eventTitle(e: Campaign['events'][number]) {
  if (e.kind === 'CREATED') return 'Кампания создана';
  if (e.kind === 'UPDATED') return CHANGE_TEXT(e.payload);
  if (e.kind === 'VERSION_CREATED') return `Версия ${e.payload?.number}: ${fmtShort(e.payload?.total_investment)} инвестиций`;
  if (e.kind === 'DOCUMENT_UPLOADED') return `Загружен документ «${e.payload?.file_name}»`;
  if (e.kind === 'DOCUMENT_ARCHIVED') return `Документ «${e.payload?.file_name}» в архиве`;
  if (e.kind === 'APPROVAL_SUBMITTED') return `Отправлено на согласование: версия ${e.payload?.number ?? e.payload?.version}, маршрут «${e.payload?.template}»`;
  if (e.kind === 'APPROVAL_DECISION') return `${e.payload?.decision === 'REJECT' ? 'Отклонено' : 'Согласовано'}: шаг «${e.payload?.title}»${e.payload?.for_user_name ? ` (за ${e.payload.for_user_name})` : ''}`;
  if (e.kind === 'APPROVAL_WITHDRAWN') return 'Отправка отозвана с согласования';
  if (e.kind === 'VERSION_WITHIN_TOLERANCE') return `Версия ${e.payload?.number} в пределах допусков — согласование сохранено`;
  if (e.kind === 'STAGE') return `${STAGE_LABEL[e.from_stage ?? ''] ?? ''} → ${STAGE_LABEL[e.to_stage ?? ''] ?? ''}`;
  return e.kind;
}

async function load() {
  loading.value = true;
  try {
    const r = await api.getWithEtag<Campaign>(`${base()}/campaigns/${props.id}`);
    c.value = r.data;
    etag.value = r.etag ?? '';
    setCrumb(`${r.data.network.name} — ${r.data.title}`);
    announceTitle(`${r.data.network.name} — ${r.data.title}`);
  } catch (e) {
    error.value = e instanceof ApiError && e.status === 404 ? 'Кампания не найдена или недоступна в вашей роли.' : (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function move(action: string, comment?: string) {
  const r = await run(() => api.post(`${base()}/campaigns/${props.id}/transitions`, { action, comment }, etag.value));
  if (r) {
    cancelDlg.value = false;
    $q.notify({ type: 'positive', message: action === 'CANCEL' ? 'Кампания отменена' : `Этап: ${STAGE_LABEL[r.data.stage]}` });
    await Promise.all([load(), loadApproval()]);
  } else if (err.message && !cancelDlg.value) {
    $q.notify({ type: 'negative', message: err.message });
    if (err.code === 'STALE_REVISION') await load();
  }
}

async function afterSave(warnings: { message: string }[]) {
  editDlg.value = false;
  for (const w of warnings) $q.notify({ type: 'warning', message: w.message, timeout: 6000 });
  $q.notify({ type: 'positive', message: 'Изменения сохранены' });
  await load();
}

onMounted(async () => { await load(); if (c.value) await Promise.all([loadVersions(), loadDocs(), loadApproval()]); });
</script>
