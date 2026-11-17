<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Бренды</div>
        <div class="note">Строки разбивки версий предложения и область видимости бренд-менеджеров. Позже справочник будет приходить из домена «Препараты» MDM.</div>
      </div>
    </div>
    <div class="toolbar" style="margin-bottom: 12px">
      <q-input v-model="name" outlined dense maxlength="120" style="width: 260px" placeholder="Название бренда" aria-label="Новый бренд" hide-bottom-space @keyup.enter="add" />
      <button class="tdBtn primary" :disabled="busy || !name.trim()" @click="add"><Icon id="plus" :size="15" /><span>Добавить</span></button>
      <span v-if="err.message" class="formError" style="margin: 0">{{ err.message }}</span>
    </div>
    <div class="miniWrap" style="max-width: 640px">
      <table class="miniTable">
        <thead><tr><th>Бренд</th><th style="width: 200px"></th></tr></thead>
        <tbody>
          <tr v-for="b in rows" :key="b.id" :class="{ inactive: b.archived }">
            <td>
              <q-input v-if="edit?.id === b.id" v-model="edit.name" outlined dense autofocus hide-bottom-space aria-label="Название" @keyup.enter="rename(b)" @keyup.esc="edit = null" />
              <template v-else>{{ b.name }}<span v-if="b.archived" class="pill red" style="margin-left: 6px">в архиве</span></template>
            </td>
            <td class="actionCell">
              <template v-if="edit?.id === b.id"><button class="linkBtn accent" @click="rename(b)">Сохранить</button><button class="linkBtn" @click="edit = null">Отмена</button></template>
              <template v-else><button class="linkBtn" @click="edit = { id: b.id, name: b.name }">Переименовать</button><button class="linkBtn" @click="archive(b)">{{ b.archived ? 'Вернуть' : 'В архив' }}</button></template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { base, loadRef, announceTitle } from '../store';
import { useCommand } from '../command';
import Icon from '../components/Icon.vue';

interface Brand { id: string; name: string; archived: boolean }
const rows = ref<Brand[]>([]);
const name = ref('');
const edit = ref<{ id: string; name: string } | null>(null);
const { err, busy, run } = useCommand();

async function load() { rows.value = (await api.get<{ items: Brand[] }>(`${base()}/brands`)).items; void loadRef(); }
async function add() {
  if (!name.value.trim()) return;
  if (await run(() => api.post(`${base()}/brands`, { name: name.value }))) { name.value = ''; await load(); }
}
async function rename(b: Brand) {
  if (await run(() => api.put(`${base()}/brands/${b.id}`, { name: edit.value!.name, archived: b.archived }))) { edit.value = null; await load(); }
}
async function archive(b: Brand) {
  if (await run(() => api.put(`${base()}/brands/${b.id}`, { name: b.name, archived: !b.archived }))) await load();
}
onMounted(() => { announceTitle('Бренды'); void load(); });
</script>
