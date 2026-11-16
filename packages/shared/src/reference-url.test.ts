import { describe, expect, it } from 'vitest';
import { CodesignError } from './codesign-error';
import { ApplyCommentPayload, GeneratePayloadV1 } from './index';
import { normalizeReferenceUrlInput, parseIpcWithReferenceUrl } from './reference-url';

const BASE_VALID = {
  schemaVersion: 1 as const,
  prompt: 'Design a landing page',
  history: [],
  model: { provider: 'anthropic' as const, modelId: 'claude-sonnet-4-6' },
  generationId: 'gen-abc123',
  designId: 'design-abc123',
};

describe('normalizeReferenceUrlInput', () => {
  it.each([
    ['example.com/docs', 'https://example.com/docs'],
    ['  example.com/docs  ', 'https://example.com/docs'],
    ['<https://example.com/docs>', 'https://example.com/docs'],
    ['"https://example.com/docs"', 'https://example.com/docs'],
    ['//cdn.example.com/brand', 'https://cdn.example.com/brand'],
    ['https://example.com/docs', 'https://example.com/docs'],
    ['http://example.com/docs', 'http://example.com/docs'],
    ['see https://example.com/docs.', 'https://example.com/docs'],
    [
      'https://en.wikipedia.org/wiki/URL_(disambiguation)',
      'https://en.wikipedia.org/wiki/URL_(disambiguation)',
    ],
    ['https://exa\u200Bmple.com/docs', 'https://example.com/docs'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['file:///tmp/secret.html', 'file:///tmp/secret.html'],
    ['http://127.0.0.1/private', 'http://127.0.0.1/private'],
    ['https://user:pass@example.com/docs', 'https://user:pass@example.com/docs'],
    ['   ', ''],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeReferenceUrlInput(input)).toBe(expected);
  });
});

describe('reference URL IPC payloads', () => {
  it('accepts a schemeless reference URL on generate', () => {
    const result = GeneratePayloadV1.parse({
      ...BASE_VALID,
      referenceUrl: ' example.com/docs ',
    });
    expect(result.referenceUrl).toBe('https://example.com/docs');
  });

  it('drops a blank reference URL instead of failing validation', () => {
    const result = GeneratePayloadV1.parse({
      ...BASE_VALID,
      referenceUrl: '   ',
    });
    expect(result.referenceUrl).toBeUndefined();
  });

  it('normalizes a reference URL on apply-comment payloads', () => {
    const result = ApplyCommentPayload.parse({
      designId: 'design-abc123',
      artifactSource: '<main />',
      comment: 'Make the heading warmer',
      selection: {
        selector: 'h1',
        tag: 'h1',
        outerHTML: '<h1>Hi</h1>',
        rect: { top: 0, left: 0, width: 10, height: 10 },
      },
      generationId: 'gen-abc123',
      referenceUrl: '<example.com/brand>',
    });
    expect(result.referenceUrl).toBe('https://example.com/brand');
  });

  it('turns an unusable reference URL into a reference-url error', () => {
    expect(() =>
      parseIpcWithReferenceUrl(GeneratePayloadV1, {
        ...BASE_VALID,
        referenceUrl: 'not a url',
      }),
    ).toThrow(CodesignError);
    try {
      parseIpcWithReferenceUrl(GeneratePayloadV1, {
        ...BASE_VALID,
        referenceUrl: 'not a url',
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'REFERENCE_URL_UNSUPPORTED',
        message: expect.stringContaining('https://example.com/page'),
      });
    }
  });

  it('still rejects unrelated payload errors as schema errors', () => {
    expect(() =>
      parseIpcWithReferenceUrl(GeneratePayloadV1, {
        ...BASE_VALID,
        prompt: '',
        referenceUrl: 'https://example.com',
      }),
    ).toThrow(/too_small|expected string|at least 1/i);
  });
});
