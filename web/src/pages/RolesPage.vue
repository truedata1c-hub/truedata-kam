<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Роли</div>
        <div class="note">Роль — набор полномочий и область видимости. Заведите роли вашей компании (финансовый контролёр, коммерческий директор…) и назначьте их сотрудникам; затем роли используются в маршрутах согласования.</div>
      </div>
      <button class="tdBtn primary" @click="open(null)"><Icon id="plus" :size="15" /><span>Новая роль</span></button>
    </div>
    <q-table class="tdTable" flat row-key="id" :rows="rows" :columns="columns" :loading="loading" :pagination="{ rowsPerPage: 0 }" hide-pagination no-data-label="Ролей нет" @row-click="(_: unknown, r: Role) => open(r)">
      <template #body-cell-name="p">
        <q-td :props="p">
          <div style="font-weight: 500">{{ p.row.name }}<span v-if="p.row.archived" class="pill red" style="margin-left: 6px">в архиве</span></div>
          <div class="cellSub">{{ p.row.description }}</div>
        </q-td>
      </template>
      <template #body-cell-permissions="p">
        <q-td :props="p"><div class="chips">
          <span v-for="x in p.row.permissions" :key="x" class="pill" :class="x === 'ADMIN' ? 'purple' : 'gray'">{{ PERMISSION_LABEL[x] }}</span>
          <span v-if="!p.row.permissions.length" class="muted">только просмотр</span>
        </div></q-td>
      </template>
      <template #body-cell-scope="p"><q-td :props="p">{{ SCOPE_LABEL[p.row.scope] }}</q-td></template>
    </q-table>

    <q-dialog v-if="editing" :model-value="true" persistent @hide="editing = null">
      <div class="q-card tdDialog">
        <div class="dlgHead">
          <div><div class="dlgTitle">{{ editing.id ? 'Роль' : 'Новая роль' }}</div><div class="dlgSub">Изменения действуют сразу для всех сотрудников с этой ролью.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
        </div>
        <form class="dlgBody" @submit.prevent="save">
          <div class="formGrid">
            <div class="full"><label class="fieldLabel" for="rl-name">Название<span class="req">*</span></label>
              <q-input for="rl-name" v-model="editing.name" outlined dense maxlength="120" aria-label="Название" hide-bottom-space autofocus :error="err.field === 'name'" /></div>
            <div class="full"><label class="fieldLabel" for="rl-desc">Описание</label>
              <q-input for="rl-desc" v-model="editing.description" outlined dense maxlength="500" aria-label="Описание" hide-bottom-space /></div>
            <div><label class="fieldLabel">Полномочия</label>
              <div class="choiceGrid">
                <label v-for="x in PERMISSIONS" :key="x" class="choice" :class="{ on: editing.permissions.includes(x) }">
                  <input v-model="editing.permissions" type="checkbox" :value="x" /><span><b>{{ PERMISSION_LABEL[x] }}</b><small>{{ PERMISSION_HINT[x] }}</small></span>
                </label>
              </div></div>
            <div><label class="fieldLabel">Область видимости<span class="req">*</span></label>
              <div class="choiceGrid">
                <label v-for="s in SCOPES" :key="s" class="choice" :class="{ on: editing.scope === s }">
                  <input v-model="editing.scope" type="radio" :value="s" name="scope" /><span><b>{{ SCOPE_LABEL[s] }}</b><small>{{ SCOPE_HINT[s] }}</small></span>
                </label>
              </div></div>
            <div v-if="editing.id" class="full">
              <label class="choice" :class="{ on: editing.archived }"><input v-model="editing.archived" type="checkbox" />
                <span><b>В архиве</b><small>Роль перестаёт действовать у всех сотрудников и не предлагается при назначении.</small></span></label>
            </div>
          </div>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
          <button type="submit" hidden />
        </form>
        <div class="dlgFoot">
          <button v-close-popup class="tdBtn">Отмена</button>
          <button class="tdBtn primary" :disabled="busy || !editing.name.trim()" @click="save">Сохранить</button>
        </div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, loadMe, announceTitle } from '../store';
import { useCommand } from '../command';
import { PERMISSION_HINT, PERMISSION_LABEL, SCOPE_HINT, SCOPE_LABEL } from '../format';
import type { Role } from '../types';
import Icon from '../components/Icon.vue';

const PERMISSIONS = ['CAMPAIGN_EDIT', 'CAMPAIGN_EDIT_SUBORDINATES', 'APPROVE', 'ANALYTICS', 'ADMIN'];
const SCOPES = ['OWN', 'SUBORDINATES', 'ALL', 'BRANDS'];
const $q = useQuasar();
const rows = ref<Role[]>([]);
const loading = ref(false);
const editing = ref<{ id: string | null; name: string; description: string; permissions: string[]; scope: string; archived: boolean } | null>(null);
const { err, busy, run } = useCommand();

const columns = [
  { name: 'name', label: 'Роль', field: 'name', align: 'left' as const, sortable: true },
  { name: 'permissions', label: 'Полномочия', field: 'permissions', align: 'left' as const },
  { name: 'scope', label: 'Видимость', field: 'scope', align: 'left' as const },
  { name: 'users', label: 'Сотрудников', field: 'users', align: 'right' as const, sortable: true },
];

function open(r: Role | null) {
  err.message = '';
  editing.value = r ? { id: r.id, name: r.name, description: r.description, permissions: [...r.permissions], scope: r.scope, archived: r.archived }
    : { id: null, name: '', description: '', permissions: [], scope: 'OWN', archived: false };
}
async function load() {
  loading.value = true;
  try { rows.value = (await api.get<{ items: Role[] }>(`${base()}/roles`)).items; } finally { loading.value = false; }
}
async function save() {
  const e = editing.value!;
  const body = { name: e.name, description: e.description, permissions: e.permissions, scope: e.scope, archived: e.archived };
  const r = await run(() => (e.id ? api.put(`${base()}/roles/${e.id}`, body) : api.post(`${base()}/roles`, body)));
  if (r) {
    editing.value = null;
    $q.notify({ type: 'positive', message: 'Роль сохранена' });
    await Promise.all([load(), loadMe()]);
  }
}
onMounted(() => { announceTitle('Роли'); void load(); });
</script>
