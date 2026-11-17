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

    <div class="twoCol">
      <div class="stack">
        <div class="panel">
          <div class="panelHead"><div class="panelTitle">Предложение и версии</div></div>
          <div class="panelBody">
            <div class="placeholder">
              <Icon id="layers-three-01" :size="20" />
              <div>
                <div style="color: var(--text); font-weight: 600">Появится на следующем шаге разработки</div>
                Версии предложения с разбивкой инвестиций и ожидаемого оборота по брендам и {{ splitText }}, ROI, обоснование,
                сравнение с планом и фактом прошлого периода и документы кампании.
              </div>
            </div>
          </div>
        </div>
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
import { base, go, announceTitle } from '../store';
import { useCommand } from '../command';
import { STAGES, STAGE_LABEL, campaignNo, fmtDate, fmtPeriod, fmtTime, plural } from '../format';
import Icon from '../components/Icon.vue';
import EditCampaignDialog from '../components/EditCampaignDialog.vue';
import type { Campaign } from '../types';

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
    await load();
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

onMounted(load);
</script>
