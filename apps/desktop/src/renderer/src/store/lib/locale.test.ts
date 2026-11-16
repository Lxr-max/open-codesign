import { describe, expect, it } from 'vitest';
import { normalizeReferenceUrl } from './locale';

describe('normalizeReferenceUrl', () => {
  it('returns undefined for a blank reference', () => {
    expect(normalizeReferenceUrl(undefined)).toBeUndefined();
    expect(normalizeReferenceUrl('   ')).toBeUndefined();
  });

  it('adds https to a pasted host and keeps an explicit http URL', () => {
    expect(normalizeReferenceUrl(' example.com/docs ')).toBe('https://example.com/docs');
    expect(normalizeReferenceUrl('http://example.com/docs')).toBe('http://example.com/docs');
  });

  it('keeps a non-web scheme so the main process can reject it visibly', () => {
    expect(normalizeReferenceUrl('file:///tmp/secret.html')).toBe('file:///tmp/secret.html');
  });
});
