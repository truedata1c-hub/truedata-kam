<template>
  <div class="panel">
    <div class="panelHead">
      <div class="panelTitle">Документы</div>
      <span class="note">{{ active.length }} · любые форматы до 50 МБ</span>
      <div class="spacer" />
      <button v-if="archived.length" class="linkBtn" style="font-size: 12px" @click="showArchived = !showArchived">{{ showArchived ? 'Скрыть архив' : `Архив (${archived.length})` }}</button>
      <button v-if="canUpload" class="tdBtn accent" @click="openUpload"><Icon id="upload-01" :size="15" /><span>Загрузить</span></button>
    </div>
    <div class="panelBody">
      <div v-if="!shown.length" class="muted">Документов пока нет. Загрузите предложение, ответ сети или протокол встречи — файлы хранятся как есть.</div>
      <div v-else class="miniWrap">
        <table class="miniTable">
          <thead><tr><th>Документ</th><th style="width: 170px">Тип</th><th style="width: 150px">Загрузил</th><th style="width: 160px"></th></tr></thead>
          <tbody>
            <tr v-for="d in shown" :key="d.id" :class="{ inactive: d.archived_at }">
              <td>
                <div style="font-weight: 500; word-break: break-word">{{ d.file_name }}</div>
                <div class="cellSub">{{ fmtSize(d.size) }}<template v-if="d.versions.length"> · версия {{ d.versions.join(', ') }}</template><template v-if="d.comment"> · {{ d.comment }}</template></div>
                <div v-if="d.archived_at" class="cellSub" style="color: var(--red)">В архиве: {{ d.archive_reason }}</div>
              </td>
              <td>{{ DOC_KIND[d.kind] }}</td>
              <td>{{ d.uploaded_by_name }}<div class="cellSub">{{ fmtTime(d.uploaded_at) }}</div></td>
              <td class="actionCell">
                <button v-if="d.previewable" class="linkBtn" @click="preview = d">Открыть</button>
                <a class="linkBtn" :href="fileUrl(d, false)" download>Скачать</a>
                <button v-if="canUpload && !d.archived_at" class="linkBtn" @click="archiveOf = d; reason = ''">В архив</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Загрузка -->
    <q-dialog v-if="uploadDlg" :model-value="true" persistent @hide="uploadDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Загрузить документ</div><div class="dlgSub">Файл сохраняется без изменений. Тип помогает понять историю переговоров.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <div class="formGrid">
            <div class="full">
              <label class="fieldLabel">Файл<span class="req">*</span></label>
              <label class="dropZone" :class="{ has: file }">
                <input type="file" hidden @change="onPick" />
                <Icon id="upload-01" :size="18" />
                <span v-if="file"><b>{{ file.name }}</b> · {{ fmtSize(file.size) }}</span>
                <span v-else>Выберите файл: Excel, PDF, Word, скан, письмо…</span>
              </label>
            </div>
            <div class="full"><label class="fieldLabel">Тип документа<span class="req">*</span></label>
              <TdSelect v-model="kind" :options="kindOptions" style="width: 100%" aria-label="Тип документа" /></div>
            <div class="full"><label class="fieldLabel" for="up-comment">Комментарий</label>
              <q-input for="up-comment" v-model="docComment" outlined dense maxlength="1000" aria-label="Комментарий" hide-bottom-space placeholder="Например, ответ сети от 12.11" /></div>
          </div>
          <div v-if="uploadErr" class="formError" role="alert">{{ uploadErr }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button>
          <button class="tdBtn primary" :disabled="uploading || !file" @click="doUpload"><q-spinner v-if="uploading" size="14px" /><span>Загрузить</span></button></div>
      </div>
    </q-dialog>

    <!-- Архив -->
    <q-dialog v-if="archiveOf" :model-value="true" persistent @hide="archiveOf = null">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Убрать в архив</div><div class="dlgSub">{{ archiveOf.file_name }} останется в истории и в версиях, где он приложен, но не будет предлагаться для новых версий.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody">
          <label class="fieldLabel" for="ar-reason">Причина<span class="req">*</span></label>
          <q-input for="ar-reason" v-model="reason" outlined dense maxlength="1000" aria-label="Причина" hide-bottom-space autofocus />
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button>
          <button class="tdBtn primary" :disabled="busy || !reason.trim()" @click="doArchive">В архив</button></div>
      </div>
    </q-dialog>

    <!-- Просмотр PDF и изображений -->
    <q-dialog v-if="preview" :model-value="true" maximized @hide="preview = null">
      <div class="q-card" style="display: flex; flex-direction: column; background: #fff">
        <div class="dlgHead"><div><div class="dlgTitle">{{ preview.file_name }}</div><div class="dlgSub">{{ DOC_KIND[preview.kind] }} · {{ fmtSize(preview.size) }}</div></div>
          <div class="spacer" /><a class="tdBtn" :href="fileUrl(preview, false)" download><Icon id="download-01" :size="15" /><span>Скачать</span></a>
          <button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div style="flex: 1; min-height: 0; background: #f2f4f7; display: grid; place-items: center">
          <img v-if="preview.mime.startsWith('image/')" :src="fileUrl(preview, true)" :alt="preview.file_name" style="max-width: 100%; max-height: 100%; object-fit: contain" />
          <iframe v-else :src="fileUrl(preview, true)" :title="preview.file_name" style="width: 100%; height: 100%; border: 0" />
        </div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { DOC_KIND, fmtSize, fmtTime } from '../format';
import type { Doc } from '../types';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const props = defineProps<{ campaignId: string; documents: Doc[]; canUpload: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const $q = useQuasar();
const { err, busy, run } = useCommand();
const showArchived = ref(false);
const preview = ref<Doc | null>(null);
const archiveOf = ref<Doc | null>(null);
const reason = ref('');
const uploadDlg = ref(false);
const file = ref<File | null>(null);
const kind = ref('NETWORK_OFFER');
const docComment = ref('');
const uploading = ref(false);
const uploadErr = ref('');

const active = computed(() => props.documents.filter((d) => !d.archived_at));
const archived = computed(() => props.documents.filter((d) => d.archived_at));
const shown = computed(() => (showArchived.value ? props.documents : active.value));
const kindOptions = Object.entries(DOC_KIND).map(([value, label]) => ({ value, label }));
const fileUrl = (d: Doc, inline: boolean) => api.url(`${base()}/campaigns/${props.campaignId}/documents/${d.id}/file${inline ? '?inline=1' : ''}`);

function openUpload() {
  file.value = null; kind.value = 'NETWORK_OFFER'; docComment.value = ''; uploadErr.value = ''; uploadDlg.value = true;
}
function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  uploadErr.value = f && f.size > 50 * 1024 * 1024 ? 'Файл больше 50 МБ.' : '';
  file.value = uploadErr.value ? null : f;
}
async function doUpload() {
  if (!file.value) return;
  uploading.value = true;
  uploadErr.value = '';
  try {
    const form = new FormData();
    form.append('kind', kind.value);
    form.append('comment', docComment.value);
    form.append('file', file.value);
    const r = await api.upload<{ duplicate: boolean }>(`${base()}/campaigns/${props.campaignId}/documents`, form);
    uploadDlg.value = false;
    $q.notify({ type: r.data.duplicate ? 'info' : 'positive', message: r.data.duplicate ? 'Такой файл уже есть в кампании' : 'Документ загружен' });
    emit('changed');
  } catch (e) {
    uploadErr.value = (e as Error).message;
  } finally {
    uploading.value = false;
  }
}
async function doArchive() {
  const r = await run(() => api.post(`${base()}/campaigns/${props.campaignId}/documents/${archiveOf.value!.id}/archive`, { reason: reason.value }));
  if (r) { archiveOf.value = null; emit('changed'); }
}
</script>

<style scoped>
.dropZone { display: flex; align-items: center; gap: 10px; padding: 14px; border: 1px dashed var(--control); border-radius: 8px; cursor: pointer; color: var(--muted); }
.dropZone:hover { background: var(--hover); }
.dropZone.has { border-style: solid; color: var(--text); }
a.linkBtn { text-decoration: none; }
.actionCell .linkBtn + .linkBtn, .actionCell a + .linkBtn, .actionCell .linkBtn + a { margin-left: 14px; }
</style>
