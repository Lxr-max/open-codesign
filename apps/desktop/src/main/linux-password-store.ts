import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config';
import {
  decideLinuxPasswordStorePin,
  LINUX_PASSWORD_STORE_ENV,
  type PasswordStorePin,
} from './password-store';

export interface PasswordStoreCommandLine {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Read `passwordStore` without the strict preferences parser.
 * A corrupt preferences file must not stop startup; Settings reports that later.
 * Synchronous because Chromium reads `--password-store` before `app.whenReady()`.
 */
export function readPersistedPasswordStoreValue(): unknown {
  try {
    const file = join(configDir(), 'preferences.json');
    if (!existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)['passwordStore'];
  } catch {
    return undefined;
  }
}

/**
 * Pin Electron's Linux safeStorage backend. Call this before `app.whenReady()`.
 * An existing `--password-store` argument wins. Otherwise
 * `OPEN_CODESIGN_PASSWORD_STORE` wins over the saved preference.
 */
export function applyLinuxPasswordStoreSwitch(
  commandLine: PasswordStoreCommandLine,
  options?: {
    platform?: string;
    env?: Record<string, string | undefined>;
    readPersisted?: () => unknown;
  },
): PasswordStorePin {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'linux') return { action: 'skip', reason: 'not-linux' };

  const env = options?.env ?? process.env;
  let persistedValue: unknown;
  try {
    persistedValue = options?.readPersisted
      ? options.readPersisted()
      : readPersistedPasswordStoreValue();
  } catch {
    persistedValue = undefined;
  }
  const decision = decideLinuxPasswordStorePin({
    platform,
    argvAlreadySet: commandLine.hasSwitch('password-store'),
    envValue: env[LINUX_PASSWORD_STORE_ENV],
    persistedValue,
  });
  if (decision.action === 'append') {
    commandLine.appendSwitch('password-store', decision.value);
  }
  return decision;
}
