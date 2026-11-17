<template>
  <q-dialog :model-value="true" @hide="emit('close')">
    <div class="q-card tdDialog wide">
      <div class="dlgHead">
        <div><div class="dlgTitle">{{ user.display_name }}</div><div class="dlgSub">{{ user.email }}{{ user.sso ? ' · входит из платформы' : '' }}</div></div>
        <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
      </div>
      <div class="subTabs" role="tablist">
        <button v-for="t in tabs" :key="t.key" role="tab" :class="{ active: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
      <div class="dlgBody" style="padding-top: 14px">
        <!-- Роли и бренды -->
        <template v-if="tab === 'roles'">
          <div class="choiceGrid">
            <label v-for="r in activeRoles" :key="r.id" class="choice" :class="{ on: roleIds.includes(r.id) }">
              <input v-model="roleIds" type="checkbox" :value="r.id" />
              <span><b>{{ r.name }}</b><small>{{ r.permissions.map((p) => PERMISSION_LABEL[p]).join(', ') || 'без полномочий' }} · {{ SCOPE_LABEL[r.scope] }}</small></span>
            </label>
          </div>
          <div v-if="needsBrands" style="margin-top: 14px">
            <label class="fieldLabel">Бренды сотрудника</label>
            <div class="fieldHint" style="margin: -2px 0 8px">Для области «Свои бренды»: суммы этих брендов видны полностью, остальных — только итогом.</div>
            <div class="checkList">
              <label v-for="b in state.ref?.brands ?? []" :key="b.id"><input v-model="brandIds" type="checkbox" :value="b.id" /><span>{{ b.name }}</span></label>
            </div>
          </div>
        </template>

        <!-- Руководитель -->
        <template v-else-if="tab === 'manager'">
          <div class="note" style="margin-bottom: 12px">Текущий руководитель: <b>{{ user.manager?.name ?? 'не назначен' }}</b><span v-if="user.manager"> · с {{ fmtDate(user.manager.from) }}</span>.
            Руководитель видит кампании подчинённых и может быть шагом «руководитель автора» в маршруте согласования.</div>
          <div class="formGrid">
            <div><label class="fieldLabel">Новый руководитель</label>
              <TdSelect v-model="managerId" clearable :options="managerOptions" placeholder="Без руководителя" style="width: 100%" aria-label="Руководитель" /></div>
            <div><label class="fieldLabel" for="mg-from">Действует с</label>
              <q-input for="mg-from" v-model="managerFrom" type="date" outlined dense hide-bottom-space aria-label="Действует с" /></div>
          </div>
        </template>

        <!-- Сети -->
        <template v-else-if="tab === 'networks'">
          <div class="miniWrap">
            <table class="miniTable">
              <thead><tr><th>Сеть</th><th style="width: 150px">Период</th><th style="width: 110px"></th></tr></thead>
              <tbody>
                <tr v-for="a in user.assignments" :key="a.id">
                  <td>{{ a.network_name }}</td>
                  <td>с {{ fmtDate(a.from) }}{{ a.to ? ` по ${fmtDate(a.to)}` : '' }}</td>
                  <td class="actionCell"><button class="linkBtn" :disabled="busy" @click="endAssignment(a.id)">Открепить</button></td>
                </tr>
                <tr v-if="!user.assignments.length"><td colspan="3" class="muted">Сотрудник не закреплён ни за одной сетью.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="toolbar" style="margin-top: 12px">
            <TdSelect v-model="newNetwork" :options="networkOptions" placeholder="Сеть" aria-label="Сеть" style="width: 260px" />
            <q-input v-model="newFrom" type="date" outlined dense hide-bottom-space class="dateIn" aria-label="С даты" />
            <button class="tdBtn accent" :disabled="busy || !newNetwork" @click="addAssignment"><Icon id="plus" :size="15" /><span>Закрепить</span></button>
          </div>
          <div class="fieldHint">Открепление закрывает период вчерашним днём: история кампаний сохраняется.</div>
        </template>

        <!-- Доступ -->
        <template v-else>
          <div class="stack">
            <label class="choice" :class="{ on: active }"><input v-model="active" type="checkbox" :disabled="user.me" />
              <span><b>Доступ к модулю включён</b><small>Отключённый сотрудник не может войти ни из платформы, ни по паролю.</small></span></label>
            <div v-if="!user.me" class="toolbar">
              <button class="tdBtn" :disabled="busy" @click="resetPassword"><Icon id="lock-01" :size="15" /><span>Выдать временный пароль</span></button>
              <span v-if="tempPassword" class="mono panel" style="padding: 6px 10px">{{ tempPassword }}</span>
            </div>
            <div class="fieldHint">Временный пароль нужен только для входа напрямую в модуль; при входе из платформы пароль не используется.</div>
          </div>
        </template>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>
      <div class="dlgFoot">
        <button v-close-popup class="tdBtn">Закрыть</button>
        <button v-if="tab === 'roles' || tab === 'access'" class="tdBtn primary" :disabled="busy" @click="saveMain">Сохранить</button>
        <button v-if="tab === 'manager'" class="tdBtn primary" :disabled="busy" @click="saveManager">Назначить</button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, state } from '../store';
import { useCommand } from '../command';
import { PERMISSION_LABEL, SCOPE_LABEL, fmtDate } from '../format';
import type { Role, User } from '../types';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const props = defineProps<{ user: User; users: User[]; roles: Role[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const $q = useQuasar();
const { err, busy, run } = useCommand();
const tabs = [{ key: 'roles', label: 'Роли' }, { key: 'manager', label: 'Руководитель' }, { key: 'networks', label: 'Сети' }, { key: 'access', label: 'Доступ' }];
const tab = ref('roles');
const today = new Date().toISOString().slice(0, 10);

const roleIds = ref([...props.user.role_ids]);
const brandIds = ref([...props.user.brand_ids]);
const active = ref(props.user.active);
const managerId = ref<string | null>(props.user.manager?.manager_id ?? null);
const managerFrom = ref(today);
const newNetwork = ref<string | null>(null);
const newFrom = ref(today);
const tempPassword = ref('');

const activeRoles = computed(() => props.roles.filter((r) => !r.archived || props.user.role_ids.includes(r.id)));
const needsBrands = computed(() => props.roles.some((r) => roleIds.value.includes(r.id) && r.scope === 'BRANDS'));
const managerOptions = computed(() => props.users.filter((u) => u.id !== props.user.id && u.active).map((u) => ({ label: u.display_name, value: u.id })));
const networkOptions = computed(() => {
  const taken = new Set(props.user.assignments.map((a) => a.network_id));
  return (state.ref?.networks ?? []).filter((n) => !taken.has(n.id)).map((n) => ({ label: n.name, value: n.id }));
});

const done = (msg: string) => { $q.notify({ type: 'positive', message: msg }); emit('changed'); };

async function saveMain() {
  const r = await run(() => api.patch(`${base()}/users/${props.user.id}`, { role_ids: roleIds.value, brand_ids: brandIds.value, active: active.value }));
  if (r) done('Сохранено');
}
async function saveManager() {
  const r = await run(() => api.put(`${base()}/users/${props.user.id}/manager`, { manager_id: managerId.value, from: managerFrom.value }));
  if (r) done('Руководитель назначен');
}
async function addAssignment() {
  const r = await run(() => api.post(`${base()}/users/${props.user.id}/assignments`, { network_id: newNetwork.value, from: newFrom.value }));
  if (r) { newNetwork.value = null; done('Сотрудник закреплён за сетью'); }
}
async function endAssignment(id: string) {
  const r = await run(() => api.post(`${base()}/assignments/${id}/end`, {}));
  if (r) done('Сотрудник откреплён');
}
async function resetPassword() {
  const r = await run(() => api.post<{ temporary_password: string }>(`${base()}/users/${props.user.id}/password-reset`, {}));
  if (r) tempPassword.value = r.data.temporary_password;
}
</script>
