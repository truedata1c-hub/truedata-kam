<template>
  <div class="loginWrap">
    <div class="panel loginCard">
      <img src="/truedata-logo.png" alt="TrueData" style="height: 34px; display: block; margin-bottom: 22px" />
      <div class="pageTitle">PharmaCheck · Переговоры</div>
      <div class="note" style="margin-bottom: 20px">Переговорные кампании с аптечными сетями</div>
      <form @submit.prevent="submit">
        <label class="fieldLabel" for="login-email">Электронная почта</label>
        <q-input id="login-email" v-model="email" for="login-email" type="email" autocomplete="username" outlined dense autofocus hide-bottom-space aria-label="Электронная почта" />
        <label class="fieldLabel" for="login-password" style="margin-top: 14px">Пароль</label>
        <q-input id="login-password" v-model="password" for="login-password" type="password" autocomplete="current-password" outlined dense hide-bottom-space aria-label="Пароль" />
        <div v-if="error" class="formError" role="alert">{{ error }}</div>
        <button type="submit" class="tdBtn primary block" style="margin-top: 20px" :disabled="loading || !email || !password">
          <q-spinner v-if="loading" size="14px" />
          <span>Войти</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { api, ApiError } from '../api';

const emit = defineEmits<{ 'logged-in': [] }>();
const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await api.post('/auth/login', { email: email.value.trim(), password: password.value });
    password.value = '';
    emit('logged-in');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Не удалось войти.';
  } finally {
    loading.value = false;
  }
}
</script>
