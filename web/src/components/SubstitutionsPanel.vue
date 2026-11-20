<template>
  <div class="panel">
    <div class="panelHead">
      <div class="panelTitle">{{ admin ? 'Замещения' : 'Замещение на время отсутствия' }}</div>
      <div class="spacer" />
      <button class="tdBtn" @click="open"><Icon id="plus" :size="15" /><span>{{ admin ? 'Назначить замещение' : 'Назначить заместителя' }}</span></button>
    </div>
    <div class="panelBody">
      <div class="note" style="margin-bottom: 8px">Заместитель на эти даты получает шаги согласования отсутствующего и решает их «за» него — это видно в истории кампании.</div>
      <div class="miniWrap">
        <table class="miniTable">
          <thead><tr><th>Отсутствует</th><th>Заместитель</th><th>Даты</th><th>Комментарий</th><th style="width: 110px"></th></tr></thead>
          <tbody>
            <tr v-for="s in items" :key="s.id" :class="{ inactive: s.past }">
              <td>{{ s.user_name }}</td>
              <td>{{ s.deputy_name }}</td>
              <td>{{ fmtDate(s.from) }} – {{ fmtDate(s.to) }} <span v-if="s.active" class="pill green">сейчас</span></td>
              <td><span class="cellSub">{{ s.comment || '—' }}</span></td>
              <td class="actionCell"><button v-if="!s.past && (admin || s.user_id === myId)" class="linkBtn" @click="end(s.id)">{{ s.active ? 'Завершить' : 'Удалить' }}</button></td>
            </tr>
            <tr v-if="!items.length"><td colspan="5" class="muted">Замещений нет.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <q-dialog v-if="dlg" :model-value="true" @hide="dlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Замещение</div><div class="dlgSub">Действует включительно по дату окончания.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <div class="formGrid">
            <div v-if="admin" class="full">
              <label class="fieldLabel">Кто отсутствует<span class="req">*</span></label>
              <TdSelect v-model="form.user_id" :options="peopleOptions" aria-label="Кто отсутствует" :error="err.field === 'user_id'" />
            </div>
            <div class="full">
              <label class="fieldLabel">Заместитель<span class="req">*</span></label>
              <TdSelect v-model="form.deputy_id" :options="peopleOptions.filter((p) => p.value !== (admin ? form.user_id : myId))" aria-label="Заместитель" :error="err.field === 'deputy_id'" />
            </div>
            <div><label class="fieldLabel" for="sb-from">С<span class="req">*</span></label><q-input for="sb-from" v-model="form.from" type="date" outlined dense hide-bottom-space :error="err.field === 'from'" aria-label="С" /></div>
            <div><label class="fieldLabel" for="sb-to">По<span class="req">*</span></label><q-input for="sb-to" v-model="form.to" type="date" outlined dense hide-bottom-space :error="err.field === 'to'" aria-label="По" /></div>
            <div class="full"><label class="fieldLabel" for="sb-c">Комментарий</label><q-input for="sb-c" v-model="form.comment" outlined dense maxlength="500" hide-bottom-space placeholder="Например, отпуск" aria-label="Комментарий" /></div>
          </div>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy || !form.deputy_id" @click="save">Сохранить</button></div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, state } from '../store';
import { useCommand } from '../command';
import { fmtDate } from '../format';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const props = defineProps<{ admin?: boolean }>();
interface Sub { id: string; user_id: string; user_name: string; deputy_id: string; deputy_name: string; from: string; to: string; comment: string; active: boolean; past: boolean }
const $q = useQuasar();
const items = ref<Sub[]>([]);
const people = ref<{ id: string; name: string }[]>([]);
const dlg = ref(false);
const myId = computed(() => state.me?.user_id ?? '');
const today = new Date().toISOString().slice(0, 10);
const form = reactive({ user_id: '' as string | null, deputy_id: null as string | null, from: today, to: today, comment: '' });
const { err, busy, run } = useCommand();
const peopleOptions = computed(() => people.value.map((p) => ({ label: p.name, value: p.id })));

async function load() {
  const r = await api.get<{ items: Sub[]; people: { id: string; name: string }[] }>(`${base()}/substitutions`);
  items.value = props.admin ? r.items : r.items.filter((s) => s.user_id === myId.value || s.deputy_id === myId.value);
  people.value = r.people;
}
function open() {
  Object.assign(form, { user_id: myId.value, deputy_id: null, from: today, to: today, comment: '' });
  err.message = '';
  dlg.value = true;
}
async function save() {
  const body = { ...form, user_id: props.admin ? form.user_id : undefined };
  if (await run(() => api.post(`${base()}/substitutions`, body))) {
    dlg.value = false;
    $q.notify({ type: 'positive', message: 'Замещение назначено' });
    await load();
  }
}
async function end(id: string) {
  const r = await run(() => api.post(`${base()}/substitutions/${id}/end`, {}));
  if (r) { $q.notify({ type: 'positive', message: 'Замещение завершено' }); await load(); } else if (err.message) $q.notify({ type: 'negative', message: err.message });
}
onMounted(load);
</script>
