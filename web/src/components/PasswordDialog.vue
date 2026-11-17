<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <div class="q-card tdDialog narrow">
      <div class="dlgHead">
        <div>
          <div class="dlgTitle">{{ forced ? 'Задайте свой пароль' : 'Сменить пароль' }}</div>
          <div class="dlgSub">{{ forced ? 'Вы вошли по временному паролю от администратора. Придумайте свой — не короче 10 символов. До этого модуль доступен только для просмотра.' : 'Другие ваши сеансы будут закрыты.' }}</div>
        </div>
        <div class="spacer" />
        <button v-if="!forced" v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
      </div>
      <form class="dlgBody" @submit.prevent="send">
        <div class="formGrid">
          <div class="full">
            <label class="fieldLabel" for="pw-cur">{{ forced ? 'Временный пароль' : 'Текущий пароль' }}<span class="req">*</span></label>
            <q-input for="pw-cur" v-model="current" type="password" outlined dense autocomplete="current-password" aria-label="Текущий пароль" hide-bottom-space :error="err.field === 'current_password'" />
          </div>
          <div class="full">
            <label class="fieldLabel" for="pw-new">Новый пароль<span class="req">*</span></label>
            <q-input for="pw-new" v-model="next" type="password" outlined dense autocomplete="new-password" aria-label="Новый пароль" hide-bottom-space :error="err.field === 'new_password'" />
          </div>
          <div class="full">
            <label class="fieldLabel" for="pw-rep">Ещё раз<span class="req">*</span></label>
            <q-input for="pw-rep" v-model="repeat" type="password" outlined dense autocomplete="new-password" aria-label="Повтор пароля" hide-bottom-space />
            <div v-if="repeat && repeat !== next" class="fieldHint" style="color: var(--red)">Пароли не совпадают.</div>
          </div>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        <button type="submit" hidden />
      </form>
      <div class="dlgFoot">
        <button v-if="!forced" v-close-popup class="tdBtn">Отмена</button>
        <button class="tdBtn primary" :disabled="busy || !current || next.length < 10 || next !== repeat" @click="send"><q-spinner v-if="busy" size="14px" /><span>Сохранить пароль</span></button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { useCommand } from '../command';
import Icon from './Icon.vue';

defineProps<{ forced: boolean }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const $q = useQuasar();
const { err, busy, run } = useCommand();
const current = ref('');
const next = ref('');
const repeat = ref('');

async function send() {
  if (next.value !== repeat.value) return;
  const r = await run(() => api.post('/me/password', { current_password: current.value, new_password: next.value }));
  if (r) {
    $q.notify({ type: 'positive', message: 'Пароль изменён.' });
    emit('changed');
  }
}
</script>
