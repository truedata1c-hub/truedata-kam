<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Пользователи и оргструктура</div>
        <div class="note">Роли, руководитель и закрепление за сетями. Права действуют сразу после сохранения. Сотрудники, входящие из платформы, появляются здесь после первого входа — им остаётся назначить роли.</div>
      </div>
      <button class="tdBtn primary" @click="inviteDlg = true"><Icon id="plus" :size="15" /><span>Добавить сотрудника</span></button>
    </div>
    <div class="tableTools">
      <q-input v-model="search" outlined dense clearable placeholder="Имя или почта" class="searchCtl" style="width: 240px" aria-label="Поиск" hide-bottom-space>
        <template #prepend><Icon id="search-sm" :size="15" class="muted" /></template>
      </q-input>
      <TdSelect v-model="roleFilter" clearable :options="roleOptions" placeholder="Все роли" aria-label="Роль" />
    </div>
    <q-table class="tdTable" flat row-key="id" :rows="filtered" :columns="columns" :loading="loading" :pagination="{ rowsPerPage: 0 }" hide-pagination no-data-label="Сотрудников нет" @row-click="(_: unknown, r: User) => (editOf = r)">
      <template #body-cell-name="p">
        <q-td :props="p">
          <div style="font-weight: 500">{{ p.row.display_name }}<span v-if="p.row.me" class="muted"> · это вы</span></div>
          <div class="cellSub">{{ p.row.email }}</div>
        </q-td>
      </template>
      <template #body-cell-roles="p">
        <q-td :props="p"><div class="chips">
          <span v-for="id in p.row.role_ids" :key="id" class="pill" :class="adminRoleIds.has(id) ? 'purple' : 'gray'">{{ roleName(id) }}</span>
          <span v-if="!p.row.role_ids.length" class="pill amber">роли не назначены</span>
        </div></q-td>
      </template>
      <template #body-cell-manager="p"><q-td :props="p">{{ p.row.manager?.name ?? '—' }}</q-td></template>
      <template #body-cell-networks="p">
        <q-td :props="p">
          <span v-if="!p.row.assignments.length" class="muted">—</span>
          <template v-else>{{ (p.row as User).assignments.slice(0, 3).map((a) => a.network_name).join(', ') }}<span v-if="p.row.assignments.length > 3" class="muted"> и ещё {{ p.row.assignments.length - 3 }}</span></template>
        </q-td>
      </template>
      <template #body-cell-state="p">
        <q-td :props="p">
          <span v-if="!p.row.active" class="pill red">отключён</span>
          <span v-else-if="p.row.must_change_password" class="pill amber">ждёт первого входа</span>
          <span v-else class="muted">{{ p.row.last_login_at ? `вход ${fmtDate(p.row.last_login_at)}` : 'ещё не входил' }}</span>
          <div v-if="p.row.sso" class="cellSub">входит из платформы</div>
        </q-td>
      </template>
    </q-table>

    <!-- Добавление -->
    <q-dialog v-if="inviteDlg" :model-value="true" persistent @hide="closeInvite">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead">
          <div><div class="dlgTitle">{{ issued ? 'Доступ выдан' : 'Добавить сотрудника' }}</div>
            <div class="dlgSub">{{ issued ? 'Передайте временный пароль лично. При первом входе его нужно сменить; пароль больше не будет показан.' : 'Для входа из платформы пароль не нужен; временный пароль — для входа напрямую в модуль.' }}</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
        </div>
        <div class="dlgBody">
          <template v-if="issued">
            <div v-if="issued.temporary_password" class="panel" style="padding: 12px; font-size: 15px; letter-spacing: .5px" ><span class="mono" style="font-size: 15px">{{ issued.temporary_password }}</span></div>
            <div v-else class="note">Учётная запись уже существовала — сотруднику добавлен доступ, пароль не менялся.</div>
          </template>
          <form v-else class="formGrid" @submit.prevent="invite">
            <div class="full"><label class="fieldLabel" for="iv-email">Почта<span class="req">*</span></label>
              <q-input for="iv-email" v-model="inv.email" outlined dense type="email" aria-label="Почта" hide-bottom-space autofocus :error="err.field === 'email'" /></div>
            <div class="full"><label class="fieldLabel" for="iv-name">Фамилия, имя, отчество<span class="req">*</span></label>
              <q-input for="iv-name" v-model="inv.name" outlined dense maxlength="120" hide-bottom-space :error="err.field === 'display_name'" />
              <div class="fieldHint">Отчество можно пропустить.</div></div>
            <div class="full"><label class="fieldLabel">Роли</label>
              <div class="choiceGrid">
                <label v-for="r in activeRoles" :key="r.id" class="choice" :class="{ on: inv.roles.includes(r.id) }">
                  <input v-model="inv.roles" type="checkbox" :value="r.id" /><span><b>{{ r.name }}</b><small>{{ r.description || SCOPE_LABEL[r.scope] }}</small></span>
                </label>
              </div></div>
            <button type="submit" hidden />
          </form>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot">
          <template v-if="issued"><button v-close-popup class="tdBtn primary">Готово</button></template>
          <template v-else>
            <button v-close-popup class="tdBtn">Отмена</button>
            <button class="tdBtn primary" :disabled="busy || !inv.email" @click="invite">Добавить</button>
          </template>
        </div>
      </div>
    </q-dialog>

    <UserDialog v-if="editOf" :user="editOf" :users="rows" :roles="roles" @close="editOf = null" @changed="load" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, loadRef, announceTitle } from '../store';
import { useCommand } from '../command';
import { SCOPE_LABEL, fmtDate } from '../format';
import type { Role, User } from '../types';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';
import UserDialog from '../components/UserDialog.vue';

const $q = useQuasar();
const rows = ref<User[]>([]);
const roles = ref<Role[]>([]);
const loading = ref(false);
const search = ref('');
const roleFilter = ref<string | null>(null);
const editOf = ref<User | null>(null);
const inviteDlg = ref(false);
const inv = reactive({ email: '', name: '', roles: [] as string[] });
const issued = ref<{ temporary_password: string | null } | null>(null);
const { err, busy, run } = useCommand();

const columns = [
  { name: 'name', label: 'Сотрудник', field: 'display_name', align: 'left' as const, sortable: true },
  { name: 'roles', label: 'Роли', field: 'role_ids', align: 'left' as const },
  { name: 'manager', label: 'Руководитель', field: (r: User) => r.manager?.name ?? '', align: 'left' as const, sortable: true },
  { name: 'networks', label: 'Закреплён за сетями', field: (r: User) => r.assignments.length, align: 'left' as const, sortable: true },
  { name: 'state', label: 'Состояние', field: 'last_login_at', align: 'left' as const },
];
const roleName = (id: string) => roles.value.find((r) => r.id === id)?.name ?? '—';
const adminRoleIds = computed(() => new Set(roles.value.filter((r) => r.permissions.includes('ADMIN')).map((r) => r.id)));
const activeRoles = computed(() => roles.value.filter((r) => !r.archived));
const roleOptions = computed(() => activeRoles.value.map((r) => ({ label: r.name, value: r.id })));
const filtered = computed(() => rows.value.filter((u) =>
  (!search.value || `${u.display_name} ${u.email}`.toLowerCase().includes(search.value.toLowerCase())) && (!roleFilter.value || u.role_ids.includes(roleFilter.value))));

async function load() {
  loading.value = true;
  try {
    const [u, r] = await Promise.all([api.get<{ items: User[] }>(`${base()}/users`), api.get<{ items: Role[] }>(`${base()}/roles`)]);
    rows.value = u.items;
    roles.value = r.items;
    if (editOf.value) editOf.value = u.items.find((x) => x.id === editOf.value!.id) ?? null;
    void loadRef();
  } catch (e) {
    $q.notify({ type: 'negative', message: (e as Error).message });
  } finally {
    loading.value = false;
  }
}

async function invite() {
  const r = await run(() => api.post<{ temporary_password: string | null }>(`${base()}/users`, { email: inv.email, display_name: inv.name, role_ids: inv.roles }));
  if (r) { issued.value = r.data; await load(); }
}
function closeInvite() {
  inviteDlg.value = false;
  issued.value = null;
  Object.assign(inv, { email: '', name: '', roles: [] });
  err.message = '';
}

onMounted(() => { announceTitle('Пользователи'); void load(); });
</script>
