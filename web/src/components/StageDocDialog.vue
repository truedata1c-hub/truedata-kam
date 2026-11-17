<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <div class="q-card tdDialog narrow">
      <div class="dlgHead">
        <div><div class="dlgTitle">{{ cfg.title }}</div><div class="dlgSub">{{ cfg.sub }}</div></div>
        <div class="spacer" /><button class="iconBtn" aria-label="Закрыть" @click="emit('close')"><Icon id="x-close" :size="18" /></button>
      </div>
      <div class="dlgBody">
        <div class="fieldLabel">Документ<span class="req">*</span></div>
        <div v-if="eligible.length" class="docChoices">
          <label v-for="d in eligible" :key="d.id" class="choice" :class="{ on: docId === d.id }">
            <input v-model="docId" type="radio" :value="d.id" />
            <span><b>{{ d.file_name }}</b><small>{{ DOC_KIND[d.kind] }} · {{ d.uploaded_by_name }}, {{ fmtTime(d.uploaded_at) }}</small></span>
          </label>
        </div>
        <div v-else class="note">В кампании ещё нет документа нужного типа — загрузите его здесь.</div>
        <div class="uploadRow">
          <TdSelect v-model="newKind" :options="kindOptions" aria-label="Тип нового документа" style="width: 200px" />
          <button class="tdBtn" :disabled="uploading" @click="fileInput?.click()"><q-spinner v-if="uploading" size="14px" /><Icon v-else id="upload-01" :size="15" /><span>Загрузить файл</span></button>
          <input ref="fileInput" type="file" hidden @change="onFile" />
        </div>
        <label class="fieldLabel" for="sd-c" style="margin-top: 12px">Комментарий</label>
        <q-input for="sd-c" v-model="comment" type="textarea" autogrow outlined dense maxlength="2000" hide-bottom-space aria-label="Комментарий" />
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>
      <div class="dlgFoot">
        <button class="tdBtn" @click="emit('close')">Отмена</button>
        <button class="tdBtn primary" :disabled="busy || !docId" @click="save">{{ cfg.button }}</button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, ApiError } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { DOC_KIND, fmtTime } from '../format';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';
import type { Doc } from '../types';

const props = defineProps<{ action: 'CONFIRM' | 'FINALIZE'; campaignId: string; etag: string; documents: Doc[] }>();
const emit = defineEmits<{ close: []; done: [stage: string]; uploaded: [] }>();
const { err, busy, run } = useCommand();
const CFG = {
  CONFIRM: { title: 'Сеть подтвердила условия', sub: 'Приложите письмо или протокол, где сеть соглашается с условиями, или подписанный договор.', button: 'Подтверждено сетью', kinds: ['NETWORK_CONFIRMATION', 'SIGNED_CONTRACT'] },
  FINALIZE: { title: 'Финальные условия', sub: 'Финальный файл условий хранится в кампании; позже он будет выгружаться в PharmaCheck по шаблону.', button: 'Зафиксировать финальные условия', kinds: ['FINAL_TERMS', 'SIGNED_CONTRACT'] },
};
const cfg = computed(() => CFG[props.action]);
const eligible = computed(() => props.documents.filter((d) => !d.archived_at && cfg.value.kinds.includes(d.kind)));
const docId = ref<string | null>(eligible.value[0]?.id ?? null);
const comment = ref('');
const newKind = ref(cfg.value.kinds[0]!);
const kindOptions = computed(() => cfg.value.kinds.map((k) => ({ label: DOC_KIND[k], value: k })));
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  uploading.value = true;
  err.message = '';
  try {
    const form = new FormData();
    form.append('kind', newKind.value);
    form.append('file', f);
    const r = await api.upload<{ id: string }>(`${base()}/campaigns/${props.campaignId}/documents`, form);
    emit('uploaded');
    docId.value = r.data.id;
  } catch (x) {
    err.message = x instanceof ApiError ? x.message : (x as Error).message;
  } finally { uploading.value = false; }
}
async function save() {
  const r = await run(() => api.post(`${base()}/campaigns/${props.campaignId}/transitions`, { action: props.action, document_id: docId.value, comment: comment.value }, props.etag));
  if (r) emit('done', r.data.stage);
}
</script>

<style scoped>
.docChoices { display: grid; gap: 6px; }
.choice small { display: block; color: var(--muted); }
.uploadRow { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
</style>
