/**
 * Linux password-store choice shared by the main process and Settings.
 *
 * Electron maps only a short list of desktops onto libsecret or KWallet.
 * Everywhere else it selects `basic_text`, which cannot protect API keys.
 * The values below are the `--password-store` flags Electron documents as
 * selecting a real backend. `basic` is intentionally absent: pinning it would
 * keep writes fail-closed.
 */
export const LINUX_PASSWORD_STORES = [
  'gnome-libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
] as const;

export type LinuxPasswordStore = (typeof LINUX_PASSWORD_STORES)[number];

/** Session override. A saved preference applies on later launches without this. */
export const LINUX_PASSWORD_STORE_ENV = 'OPEN_CODESIGN_PASSWORD_STORE';

export const OS_SECRET_SERVICE_UNAVAILABLE_MESSAGE =
  'OS keychain (secure storage) is not available. API keys cannot be stored. Finish installing the app (do not run from a mounted DMG) or enable your OS secret service, then try again.';

export type PasswordStorePin =
  | { action: 'append'; value: LinuxPasswordStore; source: 'env' | 'preference' }
  | {
      action: 'skip';
      reason: 'not-linux' | 'argv' | 'unset' | 'invalid-env' | 'invalid-preference';
    };

const STORE_LIST = LINUX_PASSWORD_STORES as readonly string[];

export function isLinuxPasswordStore(value: string): value is LinuxPasswordStore {
  return STORE_LIST.includes(value);
}

/**
 * `''` means leave Electron's desktop detection alone.
 * `undefined` is the same choice when a preferences file has no field yet.
 */
export function parsePasswordStoreSetting(
  value: unknown,
): { ok: true; value: LinuxPasswordStore | '' } | { ok: false } {
  if (value === undefined) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: '' };
  if (isLinuxPasswordStore(trimmed)) return { ok: true, value: trimmed };
  return { ok: false };
}

export function parsePasswordStoreEnv(
  value: string | undefined,
): { state: 'unset' } | { state: 'valid'; value: LinuxPasswordStore } | { state: 'invalid' } {
  if (value === undefined) return { state: 'unset' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { state: 'unset' };
  if (isLinuxPasswordStore(trimmed)) return { state: 'valid', value: trimmed };
  return { state: 'invalid' };
}

export function decideLinuxPasswordStorePin(input: {
  platform: string;
  argvAlreadySet: boolean;
  envValue: string | undefined;
  persistedValue: unknown;
}): PasswordStorePin {
  if (input.platform !== 'linux') return { action: 'skip', reason: 'not-linux' };
  if (input.argvAlreadySet) return { action: 'skip', reason: 'argv' };
  const env = parsePasswordStoreEnv(input.envValue);
  if (env.state === 'invalid') return { action: 'skip', reason: 'invalid-env' };
  if (env.state === 'valid') return { action: 'append', value: env.value, source: 'env' };
  const persisted = parsePasswordStoreSetting(input.persistedValue);
  if (!persisted.ok) return { action: 'skip', reason: 'invalid-preference' };
  if (persisted.value === '') return { action: 'skip', reason: 'unset' };
  return { action: 'append', value: persisted.value, source: 'preference' };
}

export function readSelectedPasswordBackend(storage: {
  getSelectedStorageBackend?: () => string;
}): string | null {
  const getter = storage.getSelectedStorageBackend;
  if (typeof getter !== 'function') return null;
  try {
    const value = getter.call(storage);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function linuxDesktopLabel(env: {
  XDG_CURRENT_DESKTOP?: string | undefined;
  XDG_SESSION_DESKTOP?: string | undefined;
}): string {
  return (
    sanitizeDesktop(env.XDG_CURRENT_DESKTOP) ??
    sanitizeDesktop(env.XDG_SESSION_DESKTOP) ??
    'unreported'
  );
}

function sanitizeDesktop(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code <= 31 || code === 127 ? ' ' : char;
  }
  const trimmed = cleaned.trim().slice(0, 80).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function basicTextPasswordStoreMessage(desktop: string): string {
  return (
    `Electron selected the basic_text password store for desktop "${desktop}", so the API key was not saved. ` +
    'basic_text does not protect secrets. This desktop was not mapped to libsecret or KWallet. ' +
    'Choose gnome-libsecret or kwallet6 in Settings > Advanced > Password store and restart. ' +
    'That choice is saved in preferences.json (next to config.toml) and applied on later launches. ' +
    `${LINUX_PASSWORD_STORE_ENV}=gnome-libsecret sets the same store for one launch.`
  );
}

export function linuxPasswordStoreLogFields(
  pin: PasswordStorePin,
  backend: string | null,
  desktop: string,
): { backend: string; desktop: string; pin: string; pinSource: string } {
  return {
    backend: backend ?? 'unknown',
    desktop,
    pin: pin.action === 'append' ? pin.value : '',
    pinSource: pin.action === 'append' ? pin.source : pin.reason,
  };
}

export function isLinuxUserAgent(userAgent: string): boolean {
  return /\bLinux\b/i.test(userAgent) && !/\bAndroid\b/i.test(userAgent);
}

export function shouldShowPasswordStoreSetting(userAgent: string, currentValue: string): boolean {
  return isLinuxUserAgent(userAgent) || currentValue.trim().length > 0;
}
