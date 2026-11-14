import { describe, expect, it } from 'vitest';
import {
  basicTextPasswordStoreMessage,
  decideLinuxPasswordStorePin,
  isLinuxUserAgent,
  linuxDesktopLabel,
  linuxPasswordStoreLogFields,
  OS_SECRET_SERVICE_UNAVAILABLE_MESSAGE,
  parsePasswordStoreSetting,
  readSelectedPasswordBackend,
  shouldShowPasswordStoreSetting,
} from './password-store';

describe('decideLinuxPasswordStorePin', () => {
  it('pins the env store ahead of a saved preference', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: '  kwallet6  ',
        persistedValue: 'gnome-libsecret',
      }),
    ).toEqual({ action: 'append', value: 'kwallet6', source: 'env' });
  });

  it('does not fall through to a preference when the env value is not a real backend', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: 'basic',
        persistedValue: 'gnome-libsecret',
      }),
    ).toEqual({ action: 'skip', reason: 'invalid-env' });
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: 'gnome_libsecret',
        persistedValue: 'kwallet5',
      }),
    ).toEqual({ action: 'skip', reason: 'invalid-env' });
  });

  it('uses a saved preference when the env var is unset or blank', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: '   ',
        persistedValue: 'gnome-libsecret',
      }),
    ).toEqual({ action: 'append', value: 'gnome-libsecret', source: 'preference' });
  });

  it('leaves detection alone when nothing is pinned', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: undefined,
        persistedValue: '',
      }),
    ).toEqual({ action: 'skip', reason: 'unset' });
  });

  it('refuses to pin basic_text from preferences', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: false,
        envValue: undefined,
        persistedValue: 'basic',
      }),
    ).toEqual({ action: 'skip', reason: 'invalid-preference' });
  });

  it('keeps an explicit command-line switch in charge', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'linux',
        argvAlreadySet: true,
        envValue: 'gnome-libsecret',
        persistedValue: 'kwallet6',
      }),
    ).toEqual({ action: 'skip', reason: 'argv' });
  });

  it('does nothing off Linux', () => {
    expect(
      decideLinuxPasswordStorePin({
        platform: 'darwin',
        argvAlreadySet: false,
        envValue: 'gnome-libsecret',
        persistedValue: 'kwallet6',
      }),
    ).toEqual({ action: 'skip', reason: 'not-linux' });
  });
});

describe('password store errors and desktop labels', () => {
  it('names selection failure and the detected desktop for basic_text', () => {
    const message = basicTextPasswordStoreMessage('niri');
    expect(message).toContain('basic_text');
    expect(message).toContain('desktop "niri"');
    expect(message).toContain('was not mapped to libsecret or KWallet');
    expect(message).toContain('preferences.json');
    expect(message).toContain('OPEN_CODESIGN_PASSWORD_STORE=gnome-libsecret');
    expect(message).not.toContain('enable your OS secret service');
    expect(OS_SECRET_SERVICE_UNAVAILABLE_MESSAGE).toContain('enable your OS secret service');
    expect(OS_SECRET_SERVICE_UNAVAILABLE_MESSAGE).not.toContain('basic_text');
  });

  it('prefers XDG_CURRENT_DESKTOP and falls back to the session desktop', () => {
    expect(
      linuxDesktopLabel({
        XDG_CURRENT_DESKTOP: 'niri',
        XDG_SESSION_DESKTOP: 'sway',
      }),
    ).toBe('niri');
    expect(
      linuxDesktopLabel({ XDG_CURRENT_DESKTOP: ' \n ', XDG_SESSION_DESKTOP: 'Hyprland' }),
    ).toBe('Hyprland');
    expect(linuxDesktopLabel({})).toBe('unreported');
  });

  it('drops control characters from the desktop label', () => {
    expect(linuxDesktopLabel({ XDG_CURRENT_DESKTOP: 'ni\nri\u0000' })).toBe('ni ri');
  });

  it('treats only basic_text as the insecure backend', () => {
    expect(readSelectedPasswordBackend({ getSelectedStorageBackend: () => 'basic_text' })).toBe(
      'basic_text',
    );
    expect(
      readSelectedPasswordBackend({ getSelectedStorageBackend: () => 'gnome_libsecret' }),
    ).toBe('gnome_libsecret');
    expect(
      readSelectedPasswordBackend({
        getSelectedStorageBackend: () => {
          throw new Error('not ready');
        },
      }),
    ).toBeNull();
    expect(readSelectedPasswordBackend({})).toBeNull();
  });
});

describe('password store setting visibility', () => {
  it('accepts only the documented encrypting backends', () => {
    expect(parsePasswordStoreSetting(' gnome-libsecret ')).toEqual({
      ok: true,
      value: 'gnome-libsecret',
    });
    expect(parsePasswordStoreSetting('')).toEqual({ ok: true, value: '' });
    expect(parsePasswordStoreSetting(undefined)).toEqual({ ok: true, value: '' });
    expect(parsePasswordStoreSetting('basic').ok).toBe(false);
    expect(parsePasswordStoreSetting('gnome_libsecret').ok).toBe(false);
  });

  it('shows the control on Linux and when a pin is already saved', () => {
    expect(isLinuxUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit Chrome Electron')).toBe(
      true,
    );
    expect(isLinuxUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(shouldShowPasswordStoreSetting('Mozilla/5.0 (Windows NT 10.0)', '')).toBe(false);
    expect(shouldShowPasswordStoreSetting('Mozilla/5.0 (Windows NT 10.0)', 'kwallet6')).toBe(true);
    expect(shouldShowPasswordStoreSetting('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit', '')).toBe(
      true,
    );
  });

  it('logs the pin source without echoing an invalid value', () => {
    expect(
      linuxPasswordStoreLogFields({ action: 'skip', reason: 'invalid-env' }, 'basic_text', 'niri'),
    ).toEqual({
      backend: 'basic_text',
      desktop: 'niri',
      pin: '',
      pinSource: 'invalid-env',
    });
  });
});
