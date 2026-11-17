<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <div class="q-card tdDialog xwide">
      <div class="dlgHead">
        <div><div class="dlgTitle">{{ template ? `Шаблон «${template.name}»` : 'Новый шаблон маршрута' }}</div>
          <div class="dlgSub">Шаги идут по порядку. Шаг с условием пропускается, если условие не выполнено. Правка шаблона не меняет уже отправленные кампании.</div></div>
        <div class="spacer" /><button class="iconBtn" aria-label="Закрыть" @click="emit('close')"><Icon id="x-close" :size="18" /></button>
      </div>
      <div class="dlgBody">
        <div class="tplGrid">
          <div>
            <div class="formGrid">
              <div><label class="fieldLabel" for="tp-name">Название<span class="req">*</span></label><q-input for="tp-name" v-model="form.name" outlined dense maxlength="120" hide-bottom-space :error="err.field === 'name'" aria-label="Название" /></div>
              <div style="display: flex; align-items: flex-end"><label class="choice" :class="{ on: form.is_default }" style="width: 100%"><input v-model="form.is_default" type="checkbox" :disabled="template?.is_default" />
                <span><b>Шаблон по умолчанию</b><small>Для кампаний без подходящего правила.</small></span></label></div>
              <div class="full"><label class="fieldLabel" for="tp-desc">Описание</label><q-input for="tp-desc" v-model="form.description" outlined dense maxlength="500" hide-bottom-space aria-label="Описание" /></div>
              <div><label class="fieldLabel" for="tp-ti">Допуск роста инвестиций новой версии, %</label><q-input for="tp-ti" v-model.number="form.tolerance_investment_pct" type="number" min="0" max="100" outlined dense hide-bottom-space aria-label="Допуск роста инвестиций" /></div>
              <div><label class="fieldLabel" for="tp-tt">Допуск снижения оборота, %</label><q-input for="tp-tt" v-model.number="form.tolerance_turnover_pct" type="number" min="0" max="100" outlined dense hide-bottom-space aria-label="Допуск снижения оборота" /></div>
            </div>
            <div class="fieldHint" style="margin-top: 4px">Допуски: если после «Согласовано внутри» КАМ добавит версию в этих пределах, согласование сохраняется; иначе кампания возвращается в переговоры.</div>

            <div class="stepsHead"><b>Шаги маршрута</b><div class="spacer" /><button class="tdBtn" :disabled="form.steps.length >= 10" @click="addStep"><Icon id="plus" :size="15" /><span>Шаг</span></button></div>
            <div v-for="(s, i) in form.steps" :key="s.key" class="stepCard">
              <div class="stepTop">
                <span class="stepNo">{{ i + 1 }}</span>
                <q-input v-model="s.title" outlined dense maxlength="120" hide-bottom-space placeholder="Название шага" :aria-label="`Название шага ${i + 1}`" style="flex: 1" />
                <button class="iconBtn" :disabled="i === 0" aria-label="Выше" @click="moveStep(i, -1)"><Icon id="arrow-up" :size="15" /></button>
                <button class="iconBtn" :disabled="i === form.steps.length - 1" aria-label="Ниже" @click="moveStep(i, 1)"><Icon id="arrow-up" :size="15" style="transform: rotate(180deg)" /></button>
                <button class="iconBtn" :disabled="form.steps.length === 1" aria-label="Удалить шаг" @click="form.steps.splice(i, 1)"><Icon id="trash-01" :size="15" /></button>
              </div>
              <div class="stepRow">
                <div>
                  <label class="fieldLabel">Исполнитель</label>
                  <TdSelect v-model="s.kind" :options="KIND_OPTIONS" :aria-label="`Исполнитель шага ${i + 1}`" />
                </div>
                <div v-if="s.kind === 'MANAGER'">
                  <label class="fieldLabel">Уровень</label>
                  <TdSelect v-model="s.level" :options="LEVELS" :aria-label="`Уровень руководителя шага ${i + 1}`" />
                </div>
                <div v-else-if="s.kind === 'ROLE'">
                  <label class="fieldLabel">Роль</label>
                  <TdSelect v-model="s.role_id" :options="roleOptions" placeholder="Выберите роль" :aria-label="`Роль шага ${i + 1}`" />
                </div>
                <div v-else>
                  <label class="fieldLabel">Пользователь</label>
                  <TdSelect v-model="s.user_id" :options="userOptions" placeholder="Выберите пользователя" :aria-label="`Пользователь шага ${i + 1}`" />
                </div>
                <div>
                  <label class="fieldLabel">Срок, раб. дней</label>
                  <q-input v-model.number="s.deadline_days" type="number" min="1" max="60" outlined dense hide-bottom-space :aria-label="`Срок шага ${i + 1}`" />
                </div>
              </div>
              <label v-if="s.kind === 'ROLE'" class="inlineCheck"><input v-model="s.scoped" type="checkbox" /> Только сотрудники роли, которые видят сеть кампании</label>
              <div class="conds">
                <div v-for="(c, j) in s.conditions" :key="j" class="condRow">
                  <span class="condLabel">{{ COND_LABEL[c.kind] }}</span>
                  <q-input v-if="c.kind === 'INVESTMENT_GTE'" v-model.number="c.amount" type="number" min="0" outlined dense hide-bottom-space suffix="₽" aria-label="Порог инвестиций" style="width: 180px" />
                  <q-input v-else-if="c.kind === 'GROWTH_GTE'" v-model.number="c.pct" type="number" outlined dense hide-bottom-space suffix="%" aria-label="Рост инвестиций" style="width: 120px" />
                  <q-select v-else-if="c.kind !== 'ROI_BELOW_PRIOR'" v-model="c.ids" :options="idOptions(c.kind)" multiple emit-value map-options use-chips outlined dense options-dense hide-bottom-space
                    :aria-label="COND_LABEL[c.kind]" style="flex: 1; min-width: 220px" />
                  <span v-if="c.kind === 'INVESTMENT_GTE' && c.amount" class="cellSub">{{ fmtShort(c.amount) }}</span>
                  <button class="iconBtn" aria-label="Убрать условие" @click="s.conditions.splice(j, 1)"><Icon id="x-close" :size="14" /></button>
                </div>
                <q-btn-dropdown v-if="freeConds(s).length" flat dense no-caps class="addCond" label="+ условие включения" dropdown-icon="none">
                  <q-list dense>
                    <q-item v-for="k in freeConds(s)" :key="k" v-close-popup clickable @click="addCond(s, k)"><q-item-section>{{ COND_LABEL[k] }}</q-item-section></q-item>
                  </q-list>
                </q-btn-dropdown>
              </div>
            </div>
            <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
          </div>

          <div class="previewCol">
            <div class="panelTitle" style="margin-bottom: 6px">Предпросмотр</div>
            <div class="note" style="margin-bottom: 8px">Выберите кампанию — увидите, какие шаги и какие люди получатся по её текущей версии.</div>
            <q-select v-model="previewCampaign" :options="campaignOptions" outlined dense options-dense emit-value map-options use-input fill-input hide-selected input-debounce="0"
              placeholder="Найти кампанию" aria-label="Кампания для предпросмотра" hide-bottom-space @filter="filterCampaigns" />
            <button class="tdBtn" style="margin-top: 8px; width: 100%" :disabled="!previewCampaign || previewBusy" @click="runPreview"><Icon id="refresh-cw-01" :size="14" /><span>Показать маршрут</span></button>
            <div v-if="previewError" class="formError">{{ previewError }}</div>
            <ol v-if="preview" class="routeSteps">
              <li v-for="s in preview.steps" :key="s.position" :class="{ skipped: !s.included }">
                <span class="dot">{{ s.position }}</span>
                <div>
                  <div class="stepTitle">{{ s.title }}<span v-if="!s.included" class="pill gray">пропуск</span></div>
                  <div v-if="s.included && s.candidates.length" class="who">{{ s.candidates.map((x) => x.name).join(', ') }}</div>
                  <div v-if="s.assign_note" class="cellSub warnText">{{ s.assign_note }}</div>
                  <div v-if="s.skip_reason" class="cellSub">{{ s.skip_reason }}</div>
                  <div v-if="s.error" class="cellSub badText">{{ s.error }}</div>
                </div>
              </li>
            </ol>
            <div v-if="preview && !preview.has_version" class="note" style="margin-top: 6px">У кампании нет версии: условия по суммам не проверялись.</div>
          </div>
        </div>
      </div>
      <div class="dlgFoot">
        <button class="tdBtn" @click="emit('close')">Отмена</button>
        <button class="tdBtn primary" :disabled="busy" @click="save">Сохранить шаблон</button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';
import { base, state } from '../store';
import { useCommand } from '../command';
import { fmtShort } from '../format';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';
import type { Condition, RouteStepView, RouteTemplate, StepDef } from '../types';

const props = defineProps<{ template: RouteTemplate | null; roles: { id: string; name: string; permissions: string[]; archived: boolean }[]; users: { id: string; display_name: string; active: boolean; disabled: boolean }[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { err, busy, run } = useCommand();

type CondKind = Condition['kind'];
const COND_LABEL: Record<CondKind, string> = {
  INVESTMENT_GTE: 'Инвестиции не меньше', GROWTH_GTE: 'Рост инвестиций к факту прошлого периода не меньше', ROI_BELOW_PRIOR: 'ROI ниже факта прошлого периода',
  TYPE_IN: 'Тип кампании', NETWORK_IN: 'Сеть', GROUP_IN: 'Группа сетей', BRAND_IN: 'Бренд в разбивке',
};
const KIND_OPTIONS = [{ label: 'Руководитель автора', value: 'MANAGER' }, { label: 'Бизнес-роль', value: 'ROLE' }, { label: 'Конкретный пользователь', value: 'USER' }];
const LEVELS = [1, 2, 3, 4, 5].map((n) => ({ label: n === 1 ? 'непосредственный' : `${n}-й уровень`, value: n }));
const roleOptions = computed(() => props.roles.filter((r) => !r.archived && r.permissions.includes('APPROVE')).map((r) => ({ label: r.name, value: r.id })));
const userOptions = computed(() => props.users.filter((u) => u.active && !u.disabled).map((u) => ({ label: u.display_name, value: u.id })));
function idOptions(kind: CondKind) {
  const ref = state.ref;
  const list = kind === 'TYPE_IN' ? ref?.types : kind === 'NETWORK_IN' ? ref?.networks : kind === 'GROUP_IN' ? ref?.groups : ref?.brands;
  return (list ?? []).map((x) => ({ label: x.name, value: x.id }));
}

interface EditStep { key: number; title: string; kind: 'MANAGER' | 'ROLE' | 'USER'; level: number; role_id: string | null; scoped: boolean; user_id: string | null; deadline_days: number; conditions: (Condition & Record<string, any>)[] }
let seq = 0;
const toEdit = (s: StepDef): EditStep => ({
  key: ++seq, title: s.title, kind: s.assignee.kind, level: s.assignee.kind === 'MANAGER' ? s.assignee.level : 1,
  role_id: s.assignee.kind === 'ROLE' ? s.assignee.role_id : null, scoped: s.assignee.kind === 'ROLE' ? s.assignee.scoped : false,
  user_id: s.assignee.kind === 'USER' ? s.assignee.user_id : null, deadline_days: s.deadline_days, conditions: s.conditions.map((c) => ({ ...c })),
});
const form = reactive({
  name: props.template?.name ?? '', description: props.template?.description ?? '', is_default: props.template?.is_default ?? false,
  tolerance_investment_pct: props.template?.tolerance_investment_pct ?? 0, tolerance_turnover_pct: props.template?.tolerance_turnover_pct ?? 0,
  steps: (props.template?.steps ?? [{ title: 'Руководитель КАМ', assignee: { kind: 'MANAGER', level: 1 }, conditions: [], deadline_days: 3 } as StepDef]).map(toEdit),
});
function addStep() { form.steps.push(toEdit({ title: '', assignee: { kind: 'ROLE', role_id: '', scoped: false } as never, conditions: [], deadline_days: 3 })); }
function moveStep(i: number, d: number) { const [s] = form.steps.splice(i, 1); form.steps.splice(i + d, 0, s!); }
const freeConds = (s: EditStep) => (Object.keys(COND_LABEL) as CondKind[]).filter((k) => !s.conditions.some((c) => c.kind === k));
function addCond(s: EditStep, kind: CondKind) {
  s.conditions.push(kind === 'INVESTMENT_GTE' ? { kind, amount: 10_000_000 } : kind === 'GROWTH_GTE' ? { kind, pct: 15 } : kind === 'ROI_BELOW_PRIOR' ? { kind } : { kind, ids: [] });
}
const toDef = (s: EditStep) => ({
  title: s.title, deadline_days: s.deadline_days, conditions: s.conditions,
  assignee: s.kind === 'MANAGER' ? { kind: 'MANAGER', level: s.level } : s.kind === 'ROLE' ? { kind: 'ROLE', role_id: s.role_id, scoped: s.scoped } : { kind: 'USER', user_id: s.user_id },
});
const body = () => ({ ...form, steps: form.steps.map(toDef), revision: props.template?.revision });

async function save() {
  const path = props.template ? `${base()}/route-templates/${props.template.id}` : `${base()}/route-templates`;
  const r = await run(() => (props.template ? api.put(path, body()) : api.post(path, body())));
  if (r) emit('saved');
}

// Предпросмотр
const campaigns = ref<{ label: string; value: string }[]>([]);
const campaignOptions = ref<{ label: string; value: string }[]>([]);
const previewCampaign = ref<string | null>(null);
const preview = ref<{ steps: RouteStepView[]; has_version: boolean } | null>(null);
const previewError = ref('');
const previewBusy = ref(false);
function filterCampaigns(val: string, update: (fn: () => void) => void) {
  update(() => { const q = val.toLowerCase(); campaignOptions.value = campaigns.value.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 100); });
}
async function runPreview() {
  previewBusy.value = true; previewError.value = '';
  try {
    preview.value = (await api.post(`${base()}/route-templates/preview`, { campaign_id: previewCampaign.value, name: form.name, steps: form.steps.map(toDef) })).data;
  } catch (e) {
    preview.value = null;
    previewError.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally { previewBusy.value = false; }
}
onMounted(async () => {
  const r = await api.get<{ items: { id: string; network_name: string; title: string; number: number; stage: string }[] }>(`${base()}/campaigns`, { stage: 'ACTIVE' });
  campaigns.value = r.items.map((c) => ({ label: `${c.network_name} — ${c.title} (К-${String(c.number).padStart(4, '0')})`, value: c.id }));
  campaignOptions.value = campaigns.value.slice(0, 100);
});
</script>

<style scoped>
.tplGrid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.previewCol { position: sticky; top: 0; border: 1px solid var(--line); border-radius: 9px; padding: 12px; background: #fcfcfd; }
.stepsHead { display: flex; align-items: center; margin: 16px 0 8px; }
.stepCard { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; margin-bottom: 10px; background: #fff; }
.stepTop { display: flex; gap: 6px; align-items: center; }
.stepNo { width: 22px; height: 22px; border-radius: 50%; background: var(--purple-soft); color: var(--purple); display: grid; place-items: center; font-weight: 600; font-size: 12px; flex: none; }
.stepRow { display: grid; grid-template-columns: 1fr 1fr 130px; gap: 10px; margin-top: 8px; }
.stepRow :deep(.selectCtl) { width: 100%; }
.inlineCheck { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 12px; color: var(--text-2); }
.inlineCheck input { accent-color: var(--purple); }
.conds { margin-top: 8px; display: grid; gap: 6px; }
.condRow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 8px; border-radius: 7px; background: #f9fafb; }
.condLabel { font-size: 12px; color: var(--text); }
.addCond { justify-self: start; color: var(--purple); font-size: 12px; padding: 0 4px; min-height: 24px; }
.routeSteps { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }
.routeSteps li { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; }
.routeSteps .dot { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--control); display: grid; place-items: center; font-size: 11px; color: var(--muted); background: #fff; }
.routeSteps li.skipped { opacity: 0.7; }
.stepTitle { font-weight: 600; color: var(--ink); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.who { font-size: 12px; color: var(--text); }
.warnText { color: #b54708; }
.badText { color: var(--red); }
@media (max-width: 900px) { .tplGrid { grid-template-columns: 1fr; } .stepRow { grid-template-columns: 1fr; } }
</style>
