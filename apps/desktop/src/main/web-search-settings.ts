import {
  CodesignError,
  type Config,
  ERROR_CODES,
  hydrateConfig,
  SaveWebSearchSettingsInput,
  type SaveWebSearchSettingsResult,
  toPersistedV3,
  type WebSearchSettingsState,
  type WebSearchTestResult,
} from '@open-codesign/shared';
import { writeConfig } from './config';
import { buildSecretRef, decryptSecret } from './keychain';
import { getCachedConfig, setCachedConfig } from './onboarding/config-cache';
import { testTavilyConnection } from './web-research-network';

export function getWebSearchSettings(): WebSearchSettingsState {
  return settingsState(getCachedConfig());
}

function settingsState(config: Config | null): WebSearchSettingsState {
  return {
    enabled: config?.webSearch?.enabled ?? false,
    hasKey: config?.secrets['tavily'] !== undefined,
  };
}

let pendingSave: Promise<unknown> = Promise.resolve();

export function saveWebSearchSettings(raw: unknown): Promise<WebSearchSettingsState> {
  const parsed = SaveWebSearchSettingsInput.safeParse(raw);
  if (!parsed.success) {
    // Validation errors can include the input: never send them over IPC.
    return Promise.reject(
      new CodesignError('Invalid web search settings.', ERROR_CODES.IPC_BAD_INPUT),
    );
  }
  const input = parsed.data;
  const save = pendingSave.then(async () => {
    try {
      const current = getCachedConfig();
      const config = current
        ? toPersistedV3(current)
        : { version: 3 as const, activeProvider: '', activeModel: '', providers: {}, secrets: {} };
      const secrets = { ...config.secrets };
      if (input.clearKey === true) delete secrets['tavily'];
      else if (input.apiKey !== undefined) secrets['tavily'] = buildSecretRef(input.apiKey);
      const next = hydrateConfig({
        ...config,
        secrets,
        ...(input.enabled !== undefined
          ? {
              webSearch: {
                maxCalls: 12,
                timeoutMs: 15000,
                maxChars: 10000,
                ...config.webSearch,
                enabled: input.enabled,
              },
            }
          : {}),
      });
      await writeConfig(next);
      setCachedConfig(next);
      return settingsState(next);
    } catch (err) {
      // Preserve keychain failures so Settings can show the keyed KEYCHAIN_UNAVAILABLE copy.
      if (err instanceof CodesignError && err.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE) {
        throw err;
      }
      // OS encryption and persistence errors must not expose the key or payload.
      throw new CodesignError('Could not save web search settings.', 'WEB_SEARCH_SAVE_FAILED');
    }
  });
  pendingSave = save.catch(() => undefined);
  return save;
}

export async function saveWebSearchSettingsForIpc(
  raw: unknown,
): Promise<SaveWebSearchSettingsResult> {
  try {
    return { ok: true, settings: await saveWebSearchSettings(raw) };
  } catch (err) {
    // Only allow fixed error codes across the bridge, never credential-bearing messages/causes.
    const code =
      err instanceof CodesignError &&
      (err.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE || err.code === ERROR_CODES.IPC_BAD_INPUT)
        ? err.code
        : 'WEB_SEARCH_SAVE_FAILED';
    return { ok: false, code };
  }
}

export async function testWebSearchSettings(): Promise<WebSearchTestResult> {
  const config = getCachedConfig();
  const stored = config?.secrets['tavily'];
  if (!stored) return { status: 'missing-key' };
  let apiKey: string;
  try {
    apiKey = decryptSecret(stored.ciphertext);
  } catch {
    return { status: 'unreadable-key' };
  }
  // This is a user-triggered diagnostic, not a task tool or authorization grant.
  return testTavilyConnection(apiKey, config?.webSearch?.timeoutMs ?? 15000);
}
