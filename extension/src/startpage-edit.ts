import { wx } from './wx.js';
import * as api from './api.js';
import { getLocal, setLocal, KEYS } from './storage.js';
import { exclusive, MAIN_LOCK } from './locks.js';
import { acceptStartPage, cacheKey } from './startpage-cache.js';
import {
  normalizeCustom, customBlocks, topSites,
  type CustomDraft, type CustomSaveReply,
} from './core/startpage.js';
import type { ServerSession } from './types.js';

const DRAFTS = 'startpageCustomDrafts';

export async function localTopSites(
  enabled: boolean,
): Promise<{ title: string; url: string }[]> {
  if (!enabled || wx.extension?.inIncognitoContext || !wx.topSites) return [];
  try {
    if (!(await wx.permissions.contains({ permissions: ['topSites'] }))) return [];
    return topSites(await wx.topSites.get());
  } catch { return []; }
}
export async function getCustomDraft(): Promise<CustomDraft | null> {
  const session = await getLocal<ServerSession | null>(KEYS.server, null);
  if (!session) return null;
  return (await getLocal<Record<string, CustomDraft>>(DRAFTS, {}))[cacheKey(session)] ?? null;
}
export async function discardCustomDraft(key: string, id: string): Promise<void> {
  await exclusive(MAIN_LOCK, async () => {
    const drafts = await getLocal<Record<string, CustomDraft>>(DRAFTS, {});
    if (drafts[key]?.id === id) {
      delete drafts[key];
      await setLocal({ [DRAFTS]: drafts });
    }
  });
}
export async function saveCustomDraft(request: CustomDraft): Promise<CustomSaveReply> {
  return exclusive('frogsync-custom-edit', async () => {
    let session: ServerSession;
    let draft: CustomDraft;
    try {
      const prepared = await exclusive(MAIN_LOCK, async () => {
        const current = await getLocal<ServerSession | null>(KEYS.server, null);
        if (!current || cacheKey(current) !== request.key)
          throw new Error('Sesja zmieniła się. Wróć do aktualnej strony startowej.');
        if (!request.id || request.id.length > 64 ||
            !Number.isSafeInteger(request.settingsVersion) || request.settingsVersion < 0)
          throw new Error('Niepoprawna wersja formularza.');
        const drafts = await getLocal<Record<string, CustomDraft>>(DRAFTS, {});
        if (drafts[request.key] && drafts[request.key].id !== request.id)
          throw new Error('Najpierw wznów albo odrzuć wcześniejszą niezapisaną zmianę własnych kafelków.');
        const normalized: CustomDraft = {
          ...request, blocks: normalizeCustom(request.blocks), at: Date.now(),
        };
        if (new TextEncoder().encode(JSON.stringify({
          generation: current.generation,
          settingsVersion: request.settingsVersion, blocks: normalized.blocks,
        })).length > 64 * 1024)
          throw new Error('Własne kafelki przekraczają limit 64 KB.');
        drafts[request.key] = normalized;
        await setLocal({ [DRAFTS]: drafts });
        return { session: current, draft: normalized };
      });
      session = prepared.session;
      draft = prepared.draft;
      let snapshot;
      try {
        snapshot = await api.saveStartPageCustom(
          session, draft.settingsVersion, draft.blocks);
      } catch (error) {
        if (!(error instanceof api.StartPageConflict)) throw error;
        if (error.current.profileId !== session.profile.id ||
            error.current.generation !== session.generation)
          throw new Error('Generacja serwera zmieniła się. Najpierw uruchom synchronizację.');
        const alreadyApplied =
          JSON.stringify(normalizeCustom(customBlocks(error.current))) === JSON.stringify(draft.blocks);
        await exclusive(MAIN_LOCK, async () => {
          const current = await getLocal<ServerSession | null>(KEYS.server, null);
          if (current?.token === session.token && cacheKey(current) === draft.key)
            await acceptStartPage(current, error.current);
        });
        if (!alreadyApplied) return {
          saved: false,
          message: 'Konflikt wersji. Porównaj obie listy przed ponownym zapisem.',
          current: error.current,
        };
        snapshot = error.current;
      }
      return exclusive(MAIN_LOCK, async () => {
        const current = await getLocal<ServerSession | null>(KEYS.server, null);
        if (!current || current.token !== session.token || cacheKey(current) !== draft.key)
          return {
            saved: false,
            message: 'Sesja zmieniła się. Kopia Twojej zmiany pozostaje zapisana lokalnie.',
          };
        await acceptStartPage(current, snapshot);
        const drafts = await getLocal<Record<string, CustomDraft>>(DRAFTS, {});
        if (drafts[draft.key]?.id === draft.id) {
          delete drafts[draft.key];
          await setLocal({ [DRAFTS]: drafts });
        }
        return { saved: true, message: 'Zapisano własne kafelki.', current: snapshot };
      });
    } catch (error) {
      return {
        saved: false,
        message: (error instanceof Error ? error.message : String(error)) +
          ' Formularz pozostaje zachowany; ponów zapis po przywróceniu połączenia.',
      };
    }
  });
}
