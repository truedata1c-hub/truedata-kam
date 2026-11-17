<template>
  <div class="panel">
    <div class="panelHead">
      <div class="panelTitle">Работа с сетью</div>
      <div class="tdTabs small" role="tablist" aria-label="Работа с сетью" style="margin-left: 10px">
        <button role="tab" :class="{ active: tab === 'activities' }" :aria-selected="tab === 'activities'" @click="tab = 'activities'">Активности · {{ activities.length }}</button>
        <button role="tab" :class="{ active: tab === 'contacts' }" :aria-selected="tab === 'contacts'" @click="tab = 'contacts'">Контакты сети · {{ activeContacts.length }}</button>
      </div>
      <div class="spacer" />
      <button v-if="tab === 'activities' && canEditActivities" class="tdBtn" @click="openActivity(null)"><Icon id="plus" :size="15" /><span>Активность</span></button>
      <button v-if="tab === 'contacts' && canEditContacts" class="tdBtn" @click="openContact(null)"><Icon id="plus" :size="15" /><span>Контакт</span></button>
    </div>
    <div class="panelBody">
      <template v-if="tab === 'activities'">
        <div v-if="!activities.length" class="muted">Встреч, звонков и писем пока нет. Завершённые активности попадают в историю кампании.</div>
        <div v-else class="miniWrap">
          <table class="miniTable">
            <thead><tr><th style="width: 130px">Когда</th><th style="width: 90px">Формат</th><th>Контакт</th><th>Цель и итог</th><th style="width: 110px">Статус</th><th style="width: 80px"></th></tr></thead>
            <tbody>
              <tr v-for="a in activities" :key="a.id" :class="{ inactive: a.status === 'CANCELLED' }">
                <td>{{ fmtTime(a.at) }}</td>
                <td>{{ KIND[a.kind] }}</td>
                <td>{{ a.contact_name ?? '—' }}<div v-if="a.contact_position" class="cellSub">{{ a.contact_position }}</div></td>
                <td><div v-if="a.purpose">{{ a.purpose }}</div><div v-if="a.outcome" class="cellSub outcome">Итог: {{ a.outcome }}</div></td>
                <td><span class="pill" :class="STATUS[a.status].tone">{{ STATUS[a.status].label }}</span></td>
                <td class="actionCell"><button v-if="canEditActivities" class="linkBtn" @click="openActivity(a)">{{ a.status === 'PLANNED' ? 'Итог' : 'Изменить' }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <template v-else>
        <div v-if="!contacts.length" class="muted">Контактов сети пока нет.</div>
        <div v-else class="miniWrap">
          <table class="miniTable">
            <thead><tr><th>Контакт</th><th>Должность</th><th>Телефон</th><th>Почта</th><th style="width: 140px"></th></tr></thead>
            <tbody>
              <tr v-for="c in contacts" :key="c.id" :class="{ inactive: c.archived_at }">
                <td style="font-weight: 500">{{ c.name }}<span v-if="c.is_key" class="pill purple" style="margin-left: 6px">ключевой</span><span v-if="c.archived_at" class="pill gray" style="margin-left: 6px">архив</span>
                  <div v-if="c.note" class="cellSub">{{ c.note }}</div></td>
                <td>{{ c.position || '—' }}</td>
                <td class="mono">{{ c.phone || '—' }}</td>
                <td>{{ c.email || '—' }}</td>
                <td class="actionCell"><template v-if="canEditContacts && !c.archived_at"><button class="linkBtn" @click="openContact(c)">Изменить</button><button class="linkBtn" @click="archiveContact(c)">В архив</button></template></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <q-dialog v-if="actDlg" :model-value="true" @hide="actDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">{{ actId ? 'Активность' : 'Новая активность' }}</div><div class="dlgSub">Встреча, звонок или письмо по кампании. Итог завершённой активности виден в истории.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <div class="formGrid">
            <div><label class="fieldLabel">Формат</label><TdSelect v-model="act.kind" :options="kindOptions" aria-label="Формат" style="width: 100%" /></div>
            <div><label class="fieldLabel" for="ac-at">Дата и время</label><q-input for="ac-at" v-model="act.at" type="datetime-local" outlined dense hide-bottom-space aria-label="Дата и время" :error="err.field === 'at'" /></div>
            <div class="full"><label class="fieldLabel">Контакт</label><TdSelect v-model="act.contact_id" :options="contactOptions" clearable placeholder="Без контакта" aria-label="Контакт" style="width: 100%" /></div>
            <div class="full"><label class="fieldLabel" for="ac-p">Цель</label><q-input for="ac-p" v-model="act.purpose" type="textarea" autogrow outlined dense maxlength="1000" hide-bottom-space aria-label="Цель" :error="err.field === 'purpose'" /></div>
            <div class="full"><label class="fieldLabel">Статус</label>
              <div class="tdTabs small" role="radiogroup" aria-label="Статус">
                <button v-for="s in ['PLANNED', 'DONE', 'CANCELLED']" :key="s" role="radio" :aria-checked="act.status === s" :class="{ active: act.status === s }" @click="act.status = s">{{ STATUS[s]!.label }}</button>
              </div></div>
            <div v-if="act.status === 'DONE'" class="full"><label class="fieldLabel" for="ac-o">Итог<span class="req">*</span></label><q-input for="ac-o" v-model="act.outcome" type="textarea" autogrow outlined dense maxlength="2000" hide-bottom-space aria-label="Итог" :error="err.field === 'outcome'" /></div>
          </div>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy" @click="saveActivity">Сохранить</button></div>
      </div>
    </q-dialog>

    <q-dialog v-if="conDlg" :model-value="true" @hide="conDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">{{ conId ? 'Контакт сети' : 'Новый контакт сети' }}</div><div class="dlgSub">Контакты общие для всех кампаний сети {{ networkName }}.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <div class="formGrid">
            <div class="full"><label class="fieldLabel" for="cn-n">Имя<span class="req">*</span></label><q-input for="cn-n" v-model="con.name" outlined dense maxlength="120" hide-bottom-space aria-label="Имя" :error="err.field === 'name'" /></div>
            <div class="full"><label class="fieldLabel" for="cn-p">Должность в сети</label><q-input for="cn-p" v-model="con.position" outlined dense maxlength="120" hide-bottom-space aria-label="Должность" /></div>
            <div><label class="fieldLabel" for="cn-t">Телефон</label><q-input for="cn-t" v-model="con.phone" outlined dense maxlength="40" hide-bottom-space aria-label="Телефон" /></div>
            <div><label class="fieldLabel" for="cn-e">Почта</label><q-input for="cn-e" v-model="con.email" outlined dense maxlength="320" hide-bottom-space aria-label="Почта" :error="err.field === 'email'" /></div>
            <div class="full"><label class="fieldLabel" for="cn-no">Заметка</label><q-input for="cn-no" v-model="con.note" outlined dense maxlength="500" hide-bottom-space aria-label="Заметка" /></div>
            <div class="full"><label class="choice" :class="{ on: con.is_key }"><input v-model="con.is_key" type="checkbox" /><span><b>Ключевой контакт</b><small>Принимает решения по условиям.</small></span></label></div>
          </div>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy" @click="saveContact">Сохранить</button></div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { fmtTime } from '../format';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const props = defineProps<{ campaignId: string; networkId: string; networkName: string }>();
const emit = defineEmits<{ changed: [] }>();
const $q = useQuasar();
const { err, busy, run } = useCommand();
interface Activity { id: string; kind: string; at: string; status: 'PLANNED' | 'DONE' | 'CANCELLED'; purpose: string; outcome: string; contact_id: string | null; contact_name: string | null; contact_position: string | null }
interface Contact { id: string; name: string; position: string; phone: string; email: string; note: string; is_key: boolean; archived_at: string | null }
const KIND: Record<string, string> = { MEETING: 'Встреча', CALL: 'Звонок', EMAIL: 'Письмо' };
const STATUS: Record<string, { label: string; tone: string }> = { PLANNED: { label: 'запланирована', tone: 'amber' }, DONE: { label: 'завершена', tone: 'green' }, CANCELLED: { label: 'отменена', tone: 'gray' } };
const kindOptions = Object.entries(KIND).map(([value, label]) => ({ value, label }));
const tab = ref<'activities' | 'contacts'>('activities');
const activities = ref<Activity[]>([]);
const contacts = ref<Contact[]>([]);
const canEditActivities = ref(false);
const canEditContacts = ref(false);
const activeContacts = computed(() => contacts.value.filter((c) => !c.archived_at));
const contactOptions = computed(() => activeContacts.value.map((c) => ({ label: c.position ? `${c.name} · ${c.position}` : c.name, value: c.id })));

async function load() {
  const [a, c] = await Promise.all([
    api.get<{ items: Activity[]; can_edit: boolean }>(`${base()}/campaigns/${props.campaignId}/activities`),
    api.get<{ items: Contact[]; can_edit: boolean }>(`${base()}/networks/${props.networkId}/contacts`),
  ]);
  activities.value = a.items; canEditActivities.value = a.can_edit;
  contacts.value = c.items; canEditContacts.value = c.can_edit;
}

const actDlg = ref(false);
const actId = ref<string | null>(null);
const act = reactive({ kind: 'MEETING', at: '', contact_id: null as string | null, purpose: '', outcome: '', status: 'PLANNED' });
const localInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function openActivity(a: Activity | null) {
  actId.value = a?.id ?? null;
  const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(11, 0, 0, 0);
  Object.assign(act, a ? { kind: a.kind, at: localInput(a.at), contact_id: a.contact_id, purpose: a.purpose, outcome: a.outcome, status: a.status === 'PLANNED' ? 'DONE' : a.status }
    : { kind: 'MEETING', at: localInput(next.toISOString()), contact_id: activeContacts.value.find((c) => c.is_key)?.id ?? null, purpose: '', outcome: '', status: 'PLANNED' });
  err.message = ''; err.field = null;
  actDlg.value = true;
}
async function saveActivity() {
  const body = { ...act, at: new Date(act.at).toISOString() };
  const path = `${base()}/campaigns/${props.campaignId}/activities${actId.value ? `/${actId.value}` : ''}`;
  if (await run(() => (actId.value ? api.put(path, body) : api.post(path, body)))) {
    actDlg.value = false;
    $q.notify({ type: 'positive', message: 'Активность сохранена' });
    await load();
    emit('changed');
  }
}

const conDlg = ref(false);
const conId = ref<string | null>(null);
const con = reactive({ name: '', position: '', phone: '', email: '', note: '', is_key: false });
function openContact(c: Contact | null) {
  conId.value = c?.id ?? null;
  Object.assign(con, c ? { name: c.name, position: c.position, phone: c.phone, email: c.email, note: c.note, is_key: c.is_key } : { name: '', position: '', phone: '', email: '', note: '', is_key: false });
  err.message = ''; err.field = null;
  conDlg.value = true;
}
async function saveContact() {
  const r = await run(() => (conId.value ? api.put(`${base()}/contacts/${conId.value}`, con) : api.post(`${base()}/networks/${props.networkId}/contacts`, con)));
  if (r) { conDlg.value = false; $q.notify({ type: 'positive', message: 'Контакт сохранён' }); await load(); }
}
async function archiveContact(c: Contact) {
  const r = await run(() => api.put(`${base()}/contacts/${c.id}`, { archived: true }));
  if (r) { $q.notify({ type: 'positive', message: `${c.name} — в архиве` }); await load(); } else if (err.message) $q.notify({ type: 'negative', message: err.message });
}
onMounted(load);
</script>

<style scoped>
.outcome { white-space: normal; max-width: none; }
</style>
