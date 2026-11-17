<template>
  <div v-if="view && (view.current || view.preview || view.rounds.length)" class="panel approvalPanel">
    <div class="panelHead">
      <div class="panelTitle">{{ view.current ? 'Согласование' : view.preview ? 'Маршрут согласования' : 'Согласование' }}</div>
      <div class="spacer" />
      <span v-if="view.current" class="pill amber">раунд {{ view.current.round }}</span>
      <span v-else-if="mainRound" class="pill" :class="ROUND[mainRound.status].tone">{{ ROUND[mainRound.status].label }}</span>
    </div>
    <div class="panelBody">
      <!-- Решение текущего пользователя -->
      <div v-if="view.my_decision && view.current" class="decideBox">
        <div><b>Ваше решение</b> по шагу «{{ activeStep?.title }}»<span v-if="view.my_decision.for_user"> — за {{ view.my_decision.for_user }} (замещение)</span>.</div>
        <div class="note">Версия {{ view.current.version }}: {{ fmtShort(view.current.investment) }} инвестиций, ROI {{ fmtRoi(view.current.investment ? view.current.turnover / view.current.investment : null) }}.</div>
        <div class="toolbar" style="margin-top: 8px">
          <button class="tdBtn primary" @click="openDecision('APPROVE')"><Icon id="check" :size="15" /><span>Согласовать</span></button>
          <button class="tdBtn danger" @click="openDecision('REJECT')"><Icon id="x-close" :size="15" /><span>Отклонить</span></button>
        </div>
      </div>

      <!-- Идущий или последний раунд -->
      <template v-if="mainRound">
        <div class="note" style="margin-bottom: 8px">Маршрут «{{ mainRound.template_name }}» · версия {{ mainRound.version }} · отправил {{ mainRound.submitted_by_name }} {{ fmtTime(mainRound.submitted_at) }}</div>
        <div v-if="mainRound.submit_comment" class="comment" style="margin-bottom: 8px">{{ mainRound.submit_comment }}</div>
        <StepList :steps="mainRound.steps" />
        <button v-if="view.can_withdraw" class="tdBtn" style="margin-top: 10px; width: 100%" @click="withdrawDlg = true">Отозвать с согласования</button>
      </template>

      <!-- Предпросмотр до отправки -->
      <template v-if="view.preview">
        <div v-if="mainRound" class="sectionLabel">Следующая отправка</div>
        <div v-if="view.preview.template" class="note" style="margin-bottom: 8px">
          Шаблон «{{ view.preview.template.name }}» ({{ view.preview.template.rule }}). Исполнители определены по оргструктуре на сегодня{{ view.preview.version ? ` и версии ${view.preview.version}` : '' }}.
        </div>
        <ol class="routeSteps">
          <li v-for="s in view.preview.steps" :key="s.position" :class="{ skipped: !s.included, broken: s.error }">
            <span class="dot">{{ s.position }}</span>
            <div>
              <div class="stepTitle">{{ s.title }}<span v-if="!s.included" class="pill gray">пропуск</span></div>
              <div class="cellSub">{{ s.assignee_rule }}<template v-if="s.condition_text"> · если {{ s.condition_text }}</template></div>
              <div v-if="s.included && s.candidates.length" class="who">{{ s.candidates.map((x) => x.name).join(', ') }} · {{ s.deadline_days }} {{ plural(s.deadline_days, 'раб. день', 'раб. дня', 'раб. дней') }}</div>
              <div v-if="s.assign_note" class="cellSub warnText">{{ s.assign_note }}</div>
              <div v-if="s.skip_reason" class="cellSub">{{ s.skip_reason }}</div>
              <div v-if="s.error" class="cellSub badText">{{ s.error }}</div>
            </div>
          </li>
        </ol>
        <div v-if="view.preview.problems.length" class="banner warn" style="margin-top: 8px">
          <Icon id="alert-triangle" :size="15" /><div><div v-for="p in view.preview.problems" :key="p">{{ p }}</div></div>
        </div>
        <button class="tdBtn primary" style="margin-top: 10px; width: 100%" :disabled="view.preview.problems.length > 0" @click="submitDlg = true">
          <span>Отправить на согласование</span><Icon id="arrow-right" :size="15" />
        </button>
      </template>

      <!-- Прошлые раунды -->
      <div v-if="pastRounds.length" class="pastRounds">
        <button class="linkBtn" @click="showPast = !showPast"><Icon :id="showPast ? 'chevron-up' : 'chevron-down'" :size="13" /> Предыдущие раунды · {{ pastRounds.length }}</button>
        <div v-if="showPast">
          <div v-for="r in pastRounds" :key="r.id" class="pastRound">
            <div class="pastHead"><b>Раунд {{ r.round }}</b> · v{{ r.version }} · {{ fmtDate(r.submitted_at) }}<span class="pill" :class="ROUND[r.status].tone">{{ ROUND[r.status].label }}</span></div>
            <StepList :steps="r.steps" compact />
          </div>
        </div>
      </div>
    </div>

    <q-dialog v-if="submitDlg" :model-value="true" @hide="submitDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Отправить на согласование</div><div class="dlgSub">Маршрут «{{ view.preview?.template?.name }}» зафиксируется с исполнителями. До первого решения отправку можно отозвать.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <label class="fieldLabel" for="ap-sc">Комментарий для согласующих</label>
          <q-input for="ap-sc" v-model="comment" type="textarea" autogrow outlined dense maxlength="2000" hide-bottom-space aria-label="Комментарий для согласующих" />
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy" @click="doSubmit">Отправить</button></div>
      </div>
    </q-dialog>

    <q-dialog v-if="decision" :model-value="true" @hide="decision = null">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">{{ decision === 'APPROVE' ? 'Согласовать' : 'Отклонить' }}</div>
          <div class="dlgSub">{{ decision === 'APPROVE' ? 'Кампания перейдёт к следующему шагу маршрута.' : 'Кампания вернётся КАМ в переговоры; повторная отправка — только с новой версией.' }}</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <label class="fieldLabel" for="ap-dc">Комментарий<span v-if="decision === 'REJECT'" class="req">*</span></label>
          <q-input for="ap-dc" v-model="comment" type="textarea" autogrow outlined dense maxlength="2000" hide-bottom-space autofocus aria-label="Комментарий к решению"
            :placeholder="decision === 'REJECT' ? 'Что нужно изменить в предложении' : 'По желанию'" />
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button>
          <button class="tdBtn" :class="decision === 'APPROVE' ? 'primary' : 'dangerSolid'" :disabled="busy || (decision === 'REJECT' && !comment.trim())" @click="doDecide">{{ decision === 'APPROVE' ? 'Согласовать' : 'Отклонить' }}</button></div>
      </div>
    </q-dialog>

    <q-dialog v-if="withdrawDlg" :model-value="true" @hide="withdrawDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Отозвать с согласования</div><div class="dlgSub">Кампания вернётся в переговоры; ту же версию можно будет отправить снова.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <label class="fieldLabel" for="ap-wc">Причина</label>
          <q-input for="ap-wc" v-model="comment" type="textarea" autogrow outlined dense maxlength="2000" hide-bottom-space aria-label="Причина отзыва" />
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy" @click="doWithdraw">Отозвать</button></div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { fmtDate, fmtRoi, fmtShort, fmtTime, plural } from '../format';
import Icon from './Icon.vue';
import type { ApprovalStep, ApprovalView } from '../types';

const props = defineProps<{ campaignId: string; etag: string; view: ApprovalView | null }>();
const emit = defineEmits<{ changed: [] }>();
const $q = useQuasar();
const { err, busy, run } = useCommand();
const submitDlg = ref(false);
const withdrawDlg = ref(false);
const decision = ref<'APPROVE' | 'REJECT' | null>(null);
const comment = ref('');
const showPast = ref(false);

const ROUND: Record<string, { label: string; tone: string }> = {
  IN_PROGRESS: { label: 'на согласовании', tone: 'amber' }, APPROVED: { label: 'согласовано', tone: 'green' }, REJECTED: { label: 'отклонено', tone: 'red' },
  WITHDRAWN: { label: 'отозвано', tone: 'gray' }, SUPERSEDED: { label: 'заменено новой версией', tone: 'gray' }, CANCELLED: { label: 'кампания отменена', tone: 'gray' },
};
const activeStep = computed(() => props.view?.current?.steps.find((s) => s.status === 'ACTIVE'));
// Главный раунд: идущий; без него — последний, если он не отклонён и не отозван перед новой отправкой.
const mainRound = computed(() => {
  const v = props.view;
  if (!v) return null;
  if (v.current) return v.current;
  const last = v.rounds[0];
  return last && last.status === 'APPROVED' ? last : null;
});
const pastRounds = computed(() => (props.view?.rounds ?? []).filter((r) => r.id !== mainRound.value?.id));

const STEP: Record<ApprovalStep['status'], { label: string; tone: string; icon: string }> = {
  WAITING: { label: 'ждёт очереди', tone: 'gray', icon: 'clock' }, ACTIVE: { label: 'на решении', tone: 'amber', icon: 'clock' },
  APPROVED: { label: 'согласовано', tone: 'green', icon: 'check' }, REJECTED: { label: 'отклонено', tone: 'red', icon: 'x-close' },
  SKIPPED: { label: 'пропущен', tone: 'gray', icon: 'arrow-right' }, CANCELLED: { label: 'не понадобился', tone: 'gray', icon: 'x-close' },
};

// Шаги раунда: статус, исполнители или кто решил, срок и комментарий.
const StepList = defineComponent({
  props: { steps: { type: Array as () => ApprovalStep[], required: true }, compact: Boolean },
  setup(p) {
    return () => h('ol', { class: ['routeSteps', { compact: p.compact }] }, p.steps.map((s) => {
      const st = STEP[s.status];
      const who = s.decided_by_name
        ? `${s.decided_by_name}${s.decided_for_name ? ` за ${s.decided_for_name}` : ''} · ${fmtTime(s.decided_at!)}`
        : s.status === 'SKIPPED' || s.status === 'CANCELLED' ? '' : s.candidate_users.map((u) => u.name).join(', ');
      return h('li', { class: [s.status.toLowerCase()] }, [
        h('span', { class: 'dot' }, s.position),
        h('div', [
          h('div', { class: 'stepTitle' }, [s.title, h('span', { class: ['pill', st.tone] }, st.label)]),
          who ? h('div', { class: 'who' }, who) : null,
          s.status === 'ACTIVE' && s.due_date ? h('div', { class: ['cellSub', { badText: s.overdue }] }, `Срок — ${fmtDate(s.due_date!)}${s.overdue ? ' · просрочено' : ''}`) : null,
          s.status === 'ACTIVE' && s.deputies.length ? h('div', { class: 'cellSub warnText' }, s.deputies.map((d) => `${d.user} отсутствует до ${fmtDate(d.to)}, решает ${d.deputy}`).join('; ')) : null,
          s.assign_note && !p.compact ? h('div', { class: 'cellSub warnText' }, s.assign_note) : null,
          s.skip_reason && !p.compact ? h('div', { class: 'cellSub' }, s.skip_reason) : null,
          s.decision_comment ? h('div', { class: 'comment' }, s.decision_comment) : null,
        ]),
      ]);
    }));
  },
});

function openDecision(d: 'APPROVE' | 'REJECT') { comment.value = ''; err.message = ''; decision.value = d; }
async function done(message: string) {
  submitDlg.value = false; withdrawDlg.value = false; decision.value = null; comment.value = '';
  $q.notify({ type: 'positive', message });
  emit('changed');
}
async function doSubmit() {
  const r = await run(() => api.post(`${base()}/campaigns/${props.campaignId}/approval/submit`, { comment: comment.value }, props.etag));
  if (r) await done(r.data.stage === 'APPROVED' ? 'Все шаги пропущены по условиям — согласовано' : 'Отправлено на согласование');
}
async function doDecide() {
  const r = await run(() => api.post(`${base()}/campaigns/${props.campaignId}/approval/decision`, { step_id: props.view?.my_decision?.step_id, decision: decision.value, comment: comment.value }, props.etag));
  if (r) await done(decision.value === 'REJECT' ? 'Отклонено, кампания вернулась КАМ' : r.data.stage === 'APPROVED' ? 'Согласовано: все шаги пройдены' : 'Согласовано, кампания ушла на следующий шаг');
}
async function doWithdraw() {
  const r = await run(() => api.post(`${base()}/campaigns/${props.campaignId}/approval/withdraw`, { comment: comment.value }, props.etag));
  if (r) await done('Отправка отозвана');
}
</script>

<style scoped>
.approvalPanel :deep(.routeSteps) { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.approvalPanel :deep(.routeSteps li) { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; align-items: start; }
.approvalPanel :deep(.routeSteps .dot) { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--control); display: grid; place-items: center; font-size: 11px; color: var(--muted); background: #fff; }
.approvalPanel :deep(.routeSteps li.active .dot) { border-color: #f79009; color: #b54708; background: #fffaeb; }
.approvalPanel :deep(.routeSteps li.approved .dot) { border-color: #75e0a7; color: #067647; background: #ecfdf3; }
.approvalPanel :deep(.routeSteps li.rejected .dot) { border-color: #fda29b; color: var(--red); background: #fef3f2; }
.approvalPanel :deep(.routeSteps li.skipped), .approvalPanel :deep(.routeSteps li.cancelled) { opacity: 0.7; }
.approvalPanel :deep(.stepTitle) { font-weight: 600; color: var(--ink); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.approvalPanel :deep(.who) { color: var(--text); font-size: 12px; }
.approvalPanel :deep(.comment) { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: #f9fafb; color: var(--text); white-space: pre-wrap; }
.approvalPanel :deep(.warnText) { color: #b54708; }
.approvalPanel :deep(.badText) { color: var(--red); }
.approvalPanel :deep(.routeSteps.compact) { gap: 6px; margin-top: 6px; }
.decideBox { border: 1px solid var(--purple-line); background: var(--purple-soft); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.sectionLabel { margin: 14px 0 8px; padding-top: 10px; border-top: 1px solid var(--line); font-weight: 600; color: var(--ink); }
.comment { padding: 6px 8px; border-radius: 6px; background: #f9fafb; color: var(--text); white-space: pre-wrap; }
.pastRounds { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.pastRounds .linkBtn { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); }
.pastRound { margin-top: 10px; }
.pastHead { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }
</style>
