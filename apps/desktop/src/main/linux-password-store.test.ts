import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLinuxPasswordStoreSwitch,
  type PasswordStoreCommandLine,
} from './linux-password-store';
import { initStorageSettings } from './storage-settings';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  initStorageSettings(tempDir('codesign-storage-reset-'));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function commandLine(options?: { alreadySet?: boolean }): PasswordStoreCommandLine & {
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    hasSwitch: (name: string) => {
      events.push(`has:${name}`);
      return options?.alreadySet ?? false;
    },
    appendSwitch: (name: string, value?: string) => {
      events.push(`append:${name}=${value ?? ''}`);
    },
  };
}

describe('applyLinuxPasswordStoreSwitch', () => {
  it('appends the switch synchronously before the caller reaches app.whenReady', () => {
    const line = commandLine();
    const decision = applyLinuxPasswordStoreSwitch(line, {
      platform: 'linux',
      env: { OPEN_CODESIGN_PASSWORD_STORE: 'gnome-libsecret' },
      readPersisted: () => 'kwallet6',
    });
    const ready = () => {
      line.events.push('whenReady');
      return Promise.resolve();
    };
    void ready();

    expect(decision).toEqual({ action: 'append', value: 'gnome-libsecret', source: 'env' });
    expect(line.events).toEqual([
      'has:password-store',
      'append:password-store=gnome-libsecret',
      'whenReady',
    ]);
  });

  it('does not append when --password-store is already on the command line', () => {
    const line = commandLine({ alreadySet: true });
    const decision = applyLinuxPasswordStoreSwitch(line, {
      platform: 'linux',
      env: { OPEN_CODESIGN_PASSWORD_STORE: 'gnome-libsecret' },
      readPersisted: () => 'kwallet5',
    });
    expect(decision).toEqual({ action: 'skip', reason: 'argv' });
    expect(line.events).toEqual(['has:password-store']);
  });

  it('does not touch the command line off Linux', () => {
    const line = commandLine();
    const decision = applyLinuxPasswordStoreSwitch(line, {
      platform: 'win32',
      env: { OPEN_CODESIGN_PASSWORD_STORE: 'gnome-libsecret' },
      readPersisted: () => {
        throw new Error('preferences must not be read off Linux');
      },
    });
    expect(decision).toEqual({ action: 'skip', reason: 'not-linux' });
    expect(line.events).toEqual([]);
  });

  it('ignores a throwing preferences read instead of blocking startup', () => {
    const line = commandLine();
    const decision = applyLinuxPasswordStoreSwitch(line, {
      platform: 'linux',
      env: {},
      readPersisted: () => {
        throw new Error('EACCES');
      },
    });
    expect(decision).toEqual({ action: 'skip', reason: 'unset' });
    expect(line.events).toEqual(['has:password-store']);
  });

  it('reads the saved store from the active config directory, including a relocated one', () => {
    const xdg = tempDir('codesign-xdg-');
    const relocated = tempDir('codesign-config-');
    const userData = tempDir('codesign-user-data-');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    mkdirSync(join(xdg, 'open-codesign'), { recursive: true });
    writeFileSync(
      join(xdg, 'open-codesign', 'preferences.json'),
      JSON.stringify({ schemaVersion: 10, passwordStore: 'gnome-libsecret' }),
      'utf8',
    );

    initStorageSettings(userData);
    const fromXdg = commandLine();
    expect(applyLinuxPasswordStoreSwitch(fromXdg, { platform: 'linux', env: {} })).toEqual({
      action: 'append',
      value: 'gnome-libsecret',
      source: 'preference',
    });
    expect(fromXdg.events).toContain('append:password-store=gnome-libsecret');

    writeFileSync(
      join(userData, 'storage-settings.json'),
      JSON.stringify({ schemaVersion: 1, configDir: relocated }),
      'utf8',
    );
    initStorageSettings(userData);
    writeFileSync(
      join(relocated, 'preferences.json'),
      JSON.stringify({ schemaVersion: 10, passwordStore: 'kwallet6' }),
      'utf8',
    );
    const fromRelocated = commandLine();
    expect(applyLinuxPasswordStoreSwitch(fromRelocated, { platform: 'linux', env: {} })).toEqual({
      action: 'append',
      value: 'kwallet6',
      source: 'preference',
    });
  });

  it('does not pin basic_text from a corrupt or disallowed preferences file', () => {
    const xdg = tempDir('codesign-xdg-bad-');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const dir = join(xdg, 'open-codesign');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preferences.json'), '{', 'utf8');
    initStorageSettings(tempDir('codesign-user-data-bad-'));

    const corrupt = commandLine();
    expect(applyLinuxPasswordStoreSwitch(corrupt, { platform: 'linux', env: {} })).toEqual({
      action: 'skip',
      reason: 'unset',
    });
    expect(corrupt.events.some((event) => event.startsWith('append:'))).toBe(false);

    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ schemaVersion: 10, passwordStore: 'basic' }),
      'utf8',
    );
    const basic = commandLine();
    expect(applyLinuxPasswordStoreSwitch(basic, { platform: 'linux', env: {} })).toEqual({
      action: 'skip',
      reason: 'invalid-preference',
    });
    expect(basic.events).toEqual(['has:password-store']);
  });
});

describe('password store boot order', () => {
  it('applies the switch after storage settings init and before app.whenReady', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const storageAt = src.indexOf('initStorageSettings(');
    const applyAt = src.indexOf('applyLinuxPasswordStoreSwitch(');
    const readyAt = src.indexOf('app.whenReady(');
    expect(storageAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(storageAt);
    expect(readyAt).toBeGreaterThan(applyAt);
    const readyBlock = src.slice(readyAt, readyAt + 400);
    expect(readyBlock).not.toContain('applyLinuxPasswordStoreSwitch');
  });
});
