<template>
  <div class="panel">
    <div class="panelHead"><div class="panelTitle">Переписка</div><div class="spacer" /><span v-if="items.length" class="note">{{ items.length }}</span></div>
    <div class="panelBody">
      <div v-if="!items.length" class="muted" style="margin-bottom: 10px">Обсуждение кампании с руководителями и согласующими. Упомяните коллегу через @ — он получит уведомление.</div>
      <div ref="feed" class="feed">
        <div v-for="c in items" :key="c.id" class="msg" :class="{ mine: c.mine }">
          <div class="msgHead"><b>{{ c.author_name }}</b><time>{{ fmtTime(c.created_at) }}</time></div>
          <div class="msgBody"><template v-for="(part, i) in highlight(c.body, c.mentioned)" :key="i"><span v-if="part.m" class="mention">{{ part.t }}</span><template v-else>{{ part.t }}</template></template></div>
        </div>
      </div>
      <div class="composer">
        <q-input ref="inputRef" v-model="text" type="textarea" autogrow outlined dense maxlength="4000" hide-bottom-space placeholder="Написать… (@ — упомянуть)" aria-label="Сообщение"
          @update:model-value="onInput" @keydown.enter.ctrl.prevent="send" @keydown.enter.meta.prevent="send" />
        <q-menu v-model="mentionOpen" no-focus no-refocus fit :offset="[0, 4]">
          <q-list dense style="min-width: 220px">
            <q-item v-for="p in mentionOptions" :key="p.id" clickable @click="pickMention(p)"><q-item-section>{{ p.name }}</q-item-section></q-item>
            <q-item v-if="!mentionOptions.length"><q-item-section class="muted">Нет участников с таким именем</q-item-section></q-item>
          </q-list>
        </q-menu>
        <div class="toolbar" style="margin-top: 6px">
          <span class="note">Ctrl + Enter — отправить</span>
          <div class="spacer" />
          <button class="tdBtn primary" :disabled="busy || !text.trim()" @click="send">Отправить</button>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { fmtTime } from '../format';

const props = defineProps<{ campaignId: string }>();
interface Person { id: string; name: string }
interface Comment { id: string; body: string; created_at: string; author_name: string; mine: boolean; mentioned: Person[] }
const items = ref<Comment[]>([]);
const people = ref<Person[]>([]);
const text = ref('');
const mentioned = ref<Person[]>([]);
const mentionOpen = ref(false);
const query = ref('');
const feed = ref<HTMLElement | null>(null);
const { err, busy, run } = useCommand();
const mentionOptions = computed(() => people.value.filter((p) => p.name.toLowerCase().includes(query.value.toLowerCase())).slice(0, 8));

async function load() {
  const r = await api.get<{ items: Comment[]; participants: Person[] }>(`${base()}/campaigns/${props.campaignId}/comments`);
  items.value = r.items;
  people.value = r.participants;
  await nextTick();
  if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
}
/** Открывает подсказку, если курсор стоит после «@слово». */
function onInput(v: string | number | null) {
  const s = String(v ?? '');
  const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(s);
  query.value = m ? m[1]! : '';
  mentionOpen.value = Boolean(m);
}
function pickMention(p: Person) {
  text.value = text.value.replace(/@([^\s@]{0,30})$/, `@${p.name} `);
  if (!mentioned.value.some((x) => x.id === p.id)) mentioned.value.push(p);
  mentionOpen.value = false;
}
function highlight(body: string, ms: Person[]) {
  if (!ms.length) return [{ t: body, m: false }];
  const names = ms.map((m) => `@${m.name}`).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return body.split(re).filter(Boolean).map((t) => ({ t, m: names.includes(t) }));
}
async function send() {
  if (!text.value.trim()) return;
  const ids = mentioned.value.filter((p) => text.value.includes(`@${p.name}`)).map((p) => p.id);
  if (await run(() => api.post(`${base()}/campaigns/${props.campaignId}/comments`, { body: text.value, mention_ids: ids }))) {
    text.value = '';
    mentioned.value = [];
    await load();
  }
}
onMounted(load);
</script>

<style scoped>
.feed { display: grid; gap: 8px; max-height: 360px; overflow-y: auto; margin-bottom: 10px; }
.msg { padding: 8px 10px; border-radius: 8px; background: #f9fafb; }
.msg.mine { background: var(--purple-soft); }
.msgHead { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.msgHead time { color: var(--muted); font-size: 11px; }
.msgBody { white-space: pre-wrap; color: var(--text); margin-top: 2px; }
.mention { color: var(--purple); font-weight: 600; }
.composer { position: relative; }
</style>
