import { ZodError, z } from 'zod';
import { CodesignError } from './codesign-error';
import { ERROR_CODES } from './error-codes';

const REFERENCE_URL_MAX_LENGTH = 4_096;
const INVISIBLE_URL_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;
const EXPLICIT_URL = /(?:https?:\/\/|\/\/)[^\s<>"'“”‘’]+/i;
const HOST_URL = /(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'“”‘’]*)?/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turn a pasted reference into an absolute http(s) URL string.
 * Returns an empty string when the input is blank. Does not accept non-http
 * schemes or private hosts; callers still have to validate those.
 */
export function normalizeReferenceUrlInput(raw: string): string {
  let text = unwrapReferenceUrl(raw.replace(INVISIBLE_URL_CHARS, '').trim());
  if (text.length > REFERENCE_URL_MAX_LENGTH) return text.slice(0, REFERENCE_URL_MAX_LENGTH + 1);
  if (/\s/u.test(text)) {
    const embedded = text.match(EXPLICIT_URL)?.[0] ?? text.match(HOST_URL)?.[0];
    if (embedded) text = embedded;
  }
  text = stripTrailingSentencePunctuation(text);
  if (text.length === 0) return '';
  if (text.startsWith('//')) return `https:${text}`;
  if (!SCHEME.test(text)) return `https://${text}`;
  return text;
}

export const ReferenceUrlField = z.preprocess((value: unknown) => {
  if (typeof value !== 'string') return value;
  const normalized = normalizeReferenceUrlInput(value);
  return normalized.length === 0 ? undefined : normalized;
}, z.string().url().max(REFERENCE_URL_MAX_LENGTH).optional());

const REFERENCE_URL_REJECTION =
  'Reference URL is not a valid web address. Use a link such as https://example.com/page.';

export function parseIpcWithReferenceUrl<T>(
  schema: { parse: (data: unknown) => T },
  raw: unknown,
): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError && isReferenceUrlOnly(error)) {
      throw new CodesignError(REFERENCE_URL_REJECTION, ERROR_CODES.REFERENCE_URL_UNSUPPORTED, {
        cause: error,
      });
    }
    throw error;
  }
}

function isReferenceUrlOnly(error: ZodError): boolean {
  return error.issues.length > 0 && error.issues.every((issue) => issue.path[0] === 'referenceUrl');
}

function unwrapReferenceUrl(value: string): string {
  let text = value;
  for (let depth = 0; depth < 2; depth += 1) {
    const next = stripOneWrapper(text);
    if (next === text) break;
    text = next.trim();
  }
  return text;
}

function stripOneWrapper(value: string): string {
  const pairs: Array<[string, string]> = [
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
  ];
  for (const [open, close] of pairs) {
    if (
      value.startsWith(open) &&
      value.endsWith(close) &&
      value.length > open.length + close.length
    ) {
      return value.slice(open.length, -close.length);
    }
  }
  return value;
}

function stripTrailingSentencePunctuation(value: string): string {
  let text = value.replace(/[.,;]+$/u, '');
  const open = text.split('(').length - 1;
  const close = text.split(')').length - 1;
  if (close > open && text.endsWith(')')) text = text.slice(0, -1);
  return text;
}
