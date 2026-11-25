// Выполнение команды из диалога: ошибки поля, конфликт ревизии (412) с обновлением черновика.
import { reactive, ref } from 'vue';
import { ApiError } from './api';

export function useCommand() {
  const err = reactive({ field: null as string | null, message: '', code: '', details: {} as Record<string, unknown> });
  const busy = ref(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return undefined;
    err.field = null;
    err.message = '';
    err.code = '';
    err.details = {};
    busy.value = true;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412 && e.code === 'STALE_REVISION') {
        err.message = e.details?.owner_changed ? `${e.message} Закройте окно и повторите.` : 'Кампанию изменил другой пользователь. Закройте окно, обновите карточку и повторите.';
        err.details = e.details ?? {};
        err.code = e.code;
      } else if (e instanceof ApiError) {
        err.field = e.field;
        err.message = e.message;
        err.code = e.code;
        err.details = e.details ?? {};
      } else {
        err.message = (e as Error).message;
      }
      return undefined;
    } finally {
      busy.value = false;
    }
  }
  return { err, busy, run };
}
