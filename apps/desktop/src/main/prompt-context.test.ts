import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { omittedMark } from './document-text';
import { preparePromptContext, REFERENCE_URL_TIMEOUT_MS } from './prompt-context';

const VALID_DESIGN_MD = `---
version: alpha
name: Project System
colors:
  primary: "#111111"
typography:
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
rounded:
  sm: 4px
spacing:
  sm: 8px
---

## Overview

Use Inter with compact project density.

## Colors

Use primary for text and key actions.
`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('preparePromptContext', () => {
  const resolvePublicReferenceHost = async () => ['93.184.216.34'];
  const makeReferenceFetcher = (...responses: Response[]) => {
    const pending = [...responses];
    return vi.fn(
      async (
        _safeUrl: string,
        _signal: AbortSignal,
        _resolveReferenceHost: (hostname: string) => Promise<string[]>,
      ) => {
        const next = pending.shift();
        if (!next) throw new Error('unexpected reference fetch');
        return next;
      },
    );
  };

  it('throws a CodesignError when an attachment cannot be read', async () => {
    await expect(
      preparePromptContext({
        attachments: [{ path: 'Z:/missing/brief.md', name: 'brief.md', size: 12 }],
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'ATTACHMENT_READ_FAILED',
    });
  });

  it('resolves workspace-relative attachments against the current workspace root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-relative-attachment-'));
    const relativePath = 'references/brief.md';
    const filePath = path.join(dir, relativePath);
    const text = 'Use the uploaded benchmark chart as the content reference.';
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);

    const result = await preparePromptContext({
      workspaceRoot: dir,
      attachments: [{ path: relativePath, name: 'brief.md', size: Buffer.byteLength(text) }],
    });

    expect(result.attachments[0]).toMatchObject({
      name: 'brief.md',
      path: relativePath,
      excerpt: text,
    });
  });

  it('rebases stale auto-managed workspace attachment paths after a workspace rename', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-renamed-attachment-'));
    const newWorkspace = path.join(parent, '数据对比图页面');
    const relativePath = 'references/shot.png';
    const filePath = path.join(newWorkspace, relativePath);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, pngBytes);

    const stalePath = path.join(parent, 'Untitled-design-1-25', relativePath);
    const result = await preparePromptContext({
      workspaceRoot: newWorkspace,
      attachments: [{ path: stalePath, name: 'shot.png', size: pngBytes.length }],
    });

    expect(result.attachments[0]).toMatchObject({
      name: 'shot.png',
      path: relativePath,
      mediaType: 'image/png',
      imageDataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    });
  });

  it('throws a CodesignError when a text attachment is too large', async () => {
    await expect(
      preparePromptContext({
        attachments: [{ path: 'C:/repo/huge.txt', name: 'huge.txt', size: 300_000 }],
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'ATTACHMENT_TOO_LARGE',
    });
  });

  it('allows binary attachments (png) up to 10MB - 500KB png passes', async () => {
    // Binary attachments (images) can be up to 10MB - allowed larger than text
    await expect(
      preparePromptContext({
        attachments: [{ path: 'C:/repo/image.png', name: 'image.png', size: 543_034 }],
      }),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_READ_FAILED',
    });
    // It fails because the file doesn't exist, but importantly - NOT ATTACHMENT_TOO_LARGE
  });

  it('does not leak absolute host paths into attachment prompt paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-abs-image-'));
    const filePath = path.join(dir, 'shot.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await fs.writeFile(filePath, pngBytes);

    const result = await preparePromptContext({
      attachments: [{ path: filePath, name: 'shot.png', size: pngBytes.length }],
    });

    expect(result.attachments[0]?.path).toBe('shot.png');
    expect(result.attachments[0]?.path).not.toContain(dir);
    expect(path.isAbsolute(result.attachments[0]?.path ?? '')).toBe(false);
    expect(result.attachments[0]?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('reads an explicit attachment before a different same-named workspace image', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-image-source-'));
    const workspaceRoot = path.join(dir, 'workspace');
    const external = path.join(dir, 'external', 'references', 'shot.png');
    const workspaceImage = path.join(workspaceRoot, 'references', 'shot.png');
    const original = Buffer.from('89504e470d0a1a0a00', 'hex');
    try {
      await fs.mkdir(path.dirname(external), { recursive: true });
      await fs.mkdir(path.dirname(workspaceImage), { recursive: true });
      await fs.writeFile(external, original);
      await fs.writeFile(workspaceImage, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const result = await preparePromptContext({
        workspaceRoot,
        attachments: [{ path: external, name: 'shot.png', size: original.length }],
      });
      expect(result.attachments[0]).toMatchObject({
        path: 'shot.png',
        imageDataUrl: `data:image/png;base64,${original.toString('base64')}`,
      });
      const owned = await preparePromptContext({
        workspaceRoot,
        attachments: [{ path: workspaceImage, name: 'shot.png', size: 4 }],
      });
      expect(owned.attachments[0]?.path).toBe('references/shot.png');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('sniffs image bytes when the attachment name has no image extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-sniff-image-'));
    const filePath = path.join(dir, 'clipboard-temp');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await fs.writeFile(filePath, pngBytes);

    const result = await preparePromptContext({
      attachments: [{ path: filePath, name: 'clipboard-temp', size: pngBytes.length }],
    });

    expect(result.attachments[0]).toMatchObject({
      name: 'clipboard-temp',
      path: 'clipboard-temp',
      mediaType: 'image/png',
    });
    expect(result.attachments[0]?.imageDataUrl).toBe(
      `data:image/png;base64,${pngBytes.toString('base64')}`,
    );
  });

  it.each([
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ['image/webp', Buffer.from('524946460400000057454250', 'hex')],
  ])('uses the detected %s MIME type even when the filename ends in .png', async (mediaType, bytes) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-mislabeled-image-'));
    try {
      const filePath = path.join(dir, 'clipboard.png');
      await fs.writeFile(filePath, bytes);
      const result = await preparePromptContext({
        attachments: [{ path: filePath, name: 'clipboard.png', size: bytes.length }],
      });
      expect(result.attachments[0]).toMatchObject({
        mediaType,
        imageDataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('encodes supported image attachments as data URLs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-image-attachment-'));
    const filePath = path.join(dir, 'shot.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await fs.writeFile(filePath, pngBytes);

    const result = await preparePromptContext({
      attachments: [{ path: filePath, name: 'shot.png', size: pngBytes.length }],
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      name: 'shot.png',
      mediaType: 'image/png',
    });
    expect(result.attachments[0]?.imageDataUrl).toBe(
      `data:image/png;base64,${pngBytes.toString('base64')}`,
    );
    expect(result.attachments[0]?.note).toContain('embedded as multimodal content');
    expect(result.attachments[0]?.note).not.toContain('Use the visual content directly');
    expect(result.attachments[0]?.path).toBe('shot.png');
    expect(result.attachments[0]?.excerpt).toBeUndefined();
  });

  it('throws ATTACHMENT_TOO_LARGE for unknown extension text > 256KB', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-attachment-'));
    const filePath = path.join(dir, 'data.bin');
    const text = 'a'.repeat(300_000);
    await fs.writeFile(filePath, text);

    await expect(
      preparePromptContext({
        attachments: [{ path: filePath, name: 'data.bin', size: Buffer.byteLength(text) }],
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'ATTACHMENT_TOO_LARGE',
    });
  });

  it('throws a CodesignError for oversized reference responses', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response('<!doctype html><html><body>too big</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': '300000',
        },
      }),
    );

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/reference',
        resolveReferenceHost: resolvePublicReferenceHost,
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_TOO_LARGE',
    });
  });

  it('still blocks schemeless local and credentialed references before fetch', async () => {
    const fetchReference = vi.fn();

    await expect(
      preparePromptContext({
        referenceUrl: 'localhost/admin',
        fetchReference,
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });
    await expect(
      preparePromptContext({
        referenceUrl: '//127.0.0.1/secret',
        fetchReference,
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });
    await expect(
      preparePromptContext({
        referenceUrl: 'user:pass@example.com/docs',
        fetchReference,
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });

    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('rejects non-http reference URLs before fetch', async () => {
    const fetchReference = vi.fn();

    await expect(
      preparePromptContext({
        referenceUrl: 'file:///Users/me/secret.html',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('rejects reference URLs with embedded credentials before fetch', async () => {
    const fetchReference = vi.fn();

    await expect(
      preparePromptContext({
        referenceUrl: 'https://user:pass@example.com/reference',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('rejects localhost and private-address reference URLs before fetch', async () => {
    const fetchReference = vi.fn();

    await expect(
      preparePromptContext({
        referenceUrl: 'http://localhost.:3000/private',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    await expect(
      preparePromptContext({
        referenceUrl: 'http://192.168.1.20/private',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    await expect(
      preparePromptContext({
        referenceUrl: 'http://198.51.100.10/reference',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    await expect(
      preparePromptContext({
        referenceUrl: 'http://[::ffff:127.0.0.1]/private',
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('follows validated http reference URL redirects manually', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response(null, {
        status: 302,
        headers: { location: '/final' },
      }),
      new Response('<!doctype html><title>Final</title><p>Reference body</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const result = await preparePromptContext({
      referenceUrl: 'https://example.com/start',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference,
    });

    expect(fetchReference).toHaveBeenCalledTimes(2);
    expect(fetchReference.mock.calls[0]?.[0]).toBe('https://example.com/start');
    expect(fetchReference.mock.calls[1]?.[0]).toBe('https://example.com/final');
    expect(result.referenceUrl).toMatchObject({
      url: 'https://example.com/final',
      title: 'Final',
      excerpt: 'Final Reference body',
    });
  });

  it('rejects reference URL redirects to unsupported schemes before following them', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response(null, {
        status: 302,
        headers: { location: 'file:///Users/me/secret.html' },
      }),
    );

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/start',
        resolveReferenceHost: resolvePublicReferenceHost,
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).toHaveBeenCalledTimes(1);
  });

  it('rejects reference URL redirects with embedded credentials before following them', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response(null, {
        status: 302,
        headers: { location: 'https://user:pass@example.com/secret' },
      }),
    );

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/start',
        resolveReferenceHost: resolvePublicReferenceHost,
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).toHaveBeenCalledTimes(1);
  });

  it('rejects reference URLs whose host resolves to a private address before fetch', async () => {
    const fetchReference = vi.fn();

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/reference',
        resolveReferenceHost: async () => ['127.0.0.1'],
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('rejects connection-time DNS rebinding in the default reference fetcher', async () => {
    const resolveReferenceHost = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);

    await expect(
      preparePromptContext({
        referenceUrl: 'http://example.com/reference',
        resolveReferenceHost,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(resolveReferenceHost).toHaveBeenCalledTimes(2);
  });

  it('times out while resolving reference URL hosts before fetch', async () => {
    vi.useFakeTimers();
    const fetchReference = vi.fn();

    const pending = preparePromptContext({
      referenceUrl: 'https://example.com/reference',
      resolveReferenceHost: async () => new Promise<string[]>(() => {}),
      fetchReference,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_FETCH_TIMEOUT',
      message: expect.stringContaining(`${REFERENCE_URL_TIMEOUT_MS / 1000} seconds`),
    });
    await vi.advanceTimersByTimeAsync(REFERENCE_URL_TIMEOUT_MS + 1);

    await assertion;
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('normalizes a schemeless reference URL before fetching it', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response('<!doctype html><title>Brand</title><p>Calm voice</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const result = await preparePromptContext({
      referenceUrl: ' <example.com/brand> ',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference,
    });

    expect(fetchReference.mock.calls[0]?.[0]).toBe('https://example.com/brand');
    expect(result.referenceUrl).toMatchObject({
      url: 'https://example.com/brand',
      title: 'Brand',
      excerpt: 'Brand Calm voice',
    });
  });

  it('reads plain-text and unlabeled HTML reference pages', async () => {
    const plain = makeReferenceFetcher(
      new Response('Brand voice is calm and specific.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    const plainResult = await preparePromptContext({
      referenceUrl: 'https://example.com/voice.txt',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference: plain,
    });
    expect(plainResult.referenceUrl?.excerpt).toBe('Brand voice is calm and specific.');

    const unlabeled = makeReferenceFetcher(
      new Response('<!doctype html><title>Notes</title><p>Use the grid.</p>', {
        status: 200,
      }),
    );
    const unlabeledResult = await preparePromptContext({
      referenceUrl: 'https://example.com/notes',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference: unlabeled,
    });
    expect(unlabeledResult.referenceUrl).toMatchObject({
      title: 'Notes',
      excerpt: 'Notes Use the grid.',
    });
  });

  it('rejects binary reference content with the returned media type', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response('%PDF-1.7', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/spec.pdf',
        resolveReferenceHost: resolvePublicReferenceHost,
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
      message: expect.stringContaining('application/pdf'),
    });
  });

  it('reports a refused reference connection without the raw socket error', async () => {
    const fetchReference = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
        code: 'ECONNREFUSED',
      });
    });

    const error = await preparePromptContext({
      referenceUrl: 'https://example.com/reference',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'REFERENCE_URL_FETCH_FAILED',
      message: expect.stringContaining('connection was refused'),
    });
    expect((error as { message?: string }).message).not.toContain('93.184.216.34');
  });

  it('treats an aborted reference fetch as a timeout even when the error name differs', async () => {
    const fetchReference = vi.fn(async (_safeUrl: string, signal: AbortSignal) => {
      if (signal.aborted) {
        throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));
        });
      });
    });

    vi.useFakeTimers();
    const pending = preparePromptContext({
      referenceUrl: 'https://example.com/reference',
      resolveReferenceHost: resolvePublicReferenceHost,
      fetchReference,
    });
    for (let attempt = 0; attempt < 10 && fetchReference.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(fetchReference).toHaveBeenCalled();
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'REFERENCE_URL_FETCH_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(REFERENCE_URL_TIMEOUT_MS + 1);
    await assertion;
  });

  it('reports an unusable HTTP proxy instead of an opaque fetch failure', async () => {
    const previousHttp = process.env['HTTP_PROXY'];
    const previousHttpLower = process.env['http_proxy'];
    process.env['HTTP_PROXY'] = 'not a proxy';
    process.env['http_proxy'] = 'not a proxy';
    try {
      await expect(
        preparePromptContext({
          referenceUrl: 'http://example.com/reference',
          resolveReferenceHost: resolvePublicReferenceHost,
        }),
      ).rejects.toMatchObject({
        code: 'REFERENCE_URL_FETCH_FAILED',
        message: expect.stringContaining('not a valid proxy address'),
      });
    } finally {
      if (previousHttp === undefined) delete process.env['HTTP_PROXY'];
      else process.env['HTTP_PROXY'] = previousHttp;
      if (previousHttpLower === undefined) delete process.env['http_proxy'];
      else process.env['http_proxy'] = previousHttpLower;
    }
  });

  it('fetches a public reference through the configured HTTP proxy and still blocks private targets', async () => {
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url?.includes('/start')) {
        res.writeHead(302, { location: 'http://127.0.0.1/secret' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Via proxy</title><p>Proxied body</p>');
    });
    proxy.on('connect', (req, socket) => {
      seen.push(`CONNECT ${req.url ?? ''}`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      socket.end();
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address() as AddressInfo;
    const previous = {
      HTTP_PROXY: process.env['HTTP_PROXY'],
      http_proxy: process.env['http_proxy'],
      HTTPS_PROXY: process.env['HTTPS_PROXY'],
      https_proxy: process.env['https_proxy'],
      ALL_PROXY: process.env['ALL_PROXY'],
      all_proxy: process.env['all_proxy'],
      NO_PROXY: process.env['NO_PROXY'],
      no_proxy: process.env['no_proxy'],
    };
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    process.env['HTTP_PROXY'] = proxyUrl;
    process.env['http_proxy'] = proxyUrl;
    process.env['HTTPS_PROXY'] = proxyUrl;
    process.env['https_proxy'] = proxyUrl;
    delete process.env['ALL_PROXY'];
    delete process.env['all_proxy'];
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    try {
      const proxied = await preparePromptContext({
        referenceUrl: 'http://example.com/reference',
        resolveReferenceHost: resolvePublicReferenceHost,
      });
      expect(proxied.referenceUrl).toMatchObject({
        title: 'Via proxy',
        excerpt: expect.stringContaining('Proxied body'),
      });
      expect(seen).toContain('http://example.com/reference');

      seen.length = 0;
      await expect(
        preparePromptContext({
          referenceUrl: 'http://127.0.0.1/secret',
          resolveReferenceHost: resolvePublicReferenceHost,
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });
      expect(seen).toEqual([]);

      seen.length = 0;
      await expect(
        preparePromptContext({
          referenceUrl: 'https://example.com/reference',
          resolveReferenceHost: async () => ['10.0.0.8'],
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });
      expect(seen).toEqual([]);

      seen.length = 0;
      await expect(
        preparePromptContext({
          referenceUrl: 'http://example.com/start',
          resolveReferenceHost: resolvePublicReferenceHost,
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_URL_UNSUPPORTED' });
      expect(seen).toEqual(['http://example.com/start']);

      seen.length = 0;
      await expect(
        preparePromptContext({
          referenceUrl: 'https://example.com/reference',
          resolveReferenceHost: resolvePublicReferenceHost,
        }),
      ).rejects.toMatchObject({
        code: 'REFERENCE_URL_FETCH_FAILED',
        message: expect.stringContaining('Could not fetch'),
      });
      expect(seen.some((entry) => entry.startsWith('CONNECT example.com:443'))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects reference URL redirects to private addresses before following them', async () => {
    const fetchReference = makeReferenceFetcher(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:11434/secret' },
      }),
    );

    await expect(
      preparePromptContext({
        referenceUrl: 'https://example.com/start',
        resolveReferenceHost: resolvePublicReferenceHost,
        fetchReference,
      }),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'REFERENCE_URL_UNSUPPORTED',
    });

    expect(fetchReference).toHaveBeenCalledTimes(1);
  });

  it('loads workspace AGENTS.md, DESIGN.md, and safe project settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-'));
    await fs.mkdir(path.join(dir, '.codesign'), { recursive: true });
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Follow project density rules.', 'utf8');
    await fs.writeFile(path.join(dir, 'DESIGN.md'), VALID_DESIGN_MD, 'utf8');
    await fs.writeFile(
      path.join(dir, '.codesign', 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        preferredSkills: ['chart-rendering'],
        apiKey: 'must-not-enter-prompt',
        arbitrary: 'ignored',
      }),
      'utf8',
    );

    const result = await preparePromptContext({ workspaceRoot: dir });

    expect(result.projectContext.agentsMd).toContain('project density');
    expect(result.projectContext.designMd).toContain('version: alpha');
    expect(result.projectContext.designMd).toContain('Use Inter with compact project density.');
    expect(result.projectContext.settingsJson).toContain('preferredSkills');
    expect(result.projectContext.settingsJson).not.toContain('apiKey');
    expect(result.projectContext.settingsJson).not.toContain('arbitrary');
  });

  it('loads warning-only DESIGN.md as design context while preserving extensions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-extensions-'));
    const raw = VALID_DESIGN_MD.replace('rounded:', 'radius:')
      .replace('fontSize: 16px', 'fontSize: 16px\n    letterSpacing: -.02em')
      .replace('spacing:', 'shadows:\n  card: "0 2px 8px #000000"\nspacing:');
    await fs.writeFile(path.join(dir, 'DESIGN.md'), raw, 'utf8');

    const result = await preparePromptContext({ workspaceRoot: dir });

    expect(result.projectContext.invalidDesignMd).toBeUndefined();
    expect(result.projectContext.designMd).toContain('radius:\n  sm: 4px');
    expect(result.projectContext.designMd).toContain('shadows:\n  card: "0 2px 8px #000000"');
    expect(result.projectContext.designMd).toContain('letterSpacing: -.02em');
    expect(await fs.readFile(path.join(dir, 'DESIGN.md'), 'utf8')).toBe(raw);
  });

  it('passes invalid workspace DESIGN.md as repair context instead of blocking generation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-design-'));
    await fs.writeFile(
      path.join(dir, 'DESIGN.md'),
      `---
project: Studio Loop Welcome Email
version: 1
---

## Brand

Use a deep indigo welcome-email system.
`,
      'utf8',
    );

    const result = await preparePromptContext({ workspaceRoot: dir });

    expect(result.projectContext.designMd).toBeUndefined();
    expect(result.projectContext.invalidDesignMd?.errors).toEqual([
      'name: name is required',
      'version: version must be a string',
    ]);
    expect(result.projectContext.invalidDesignMd?.raw).toContain('project: Studio Loop');
  });

  it('rejects project context files that traverse workspace symlinks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-link-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-out-'));
    await fs.writeFile(path.join(outside, 'AGENTS.md'), 'leaked instruction', 'utf8');
    try {
      await fs.symlink(outside, path.join(dir, 'linked'), 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    await fs.symlink(path.join(outside, 'AGENTS.md'), path.join(dir, 'AGENTS.md'));

    await expect(preparePromptContext({ workspaceRoot: dir })).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'CONFIG_SCHEMA_INVALID',
    });
  });

  it('throws when project settings are malformed JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-project-context-bad-'));
    await fs.mkdir(path.join(dir, '.codesign'), { recursive: true });
    await fs.writeFile(path.join(dir, '.codesign', 'settings.json'), '{bad json', 'utf8');

    await expect(preparePromptContext({ workspaceRoot: dir })).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'CONFIG_PARSE_FAILED',
    });
  });
});

describe('document attachments', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationships = (...items: Array<[id: string, kind: string, target: string]>) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
      .map(
        ([id, kind, target]) =>
          `<Relationship Id="${id}" Type="${RELATIONSHIPS}/${kind}" Target="${target}"/>`,
      )
      .join('')}</Relationships>`;
  const workbook = (...tabs: Array<[name: string, id: string]>) =>
    `<workbook ${S} xmlns:r="${RELATIONSHIPS}"><sheets>${tabs
      .map(([name, id], n) => `<sheet name="${name}" sheetId="${n + 1}" r:id="${id}"/>`)
      .join('')}</sheets></workbook>`;
  const oneCell = (text: string) =>
    `<worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;
  const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const docx = (...paragraphs: string[]) => ({
    'word/document.xml': `<w:document ${W}><w:body>${paragraphs.map(paragraph).join('')}</w:body></w:document>`,
  });
  const slide = (...lines: string[]) =>
    `<p:sld ${A}>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:sld>`;

  async function attach(name: string, files: Record<string, string | Buffer>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-document-attachment-'));
    const zip = new JSZip();
    for (const [part, content] of Object.entries(files)) {
      zip.file(part, content, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, bytes);
    return { path: filePath, name, size: bytes.length };
  }

  it('reads a DOCX as text, under its title', async () => {
    const file = await attach('brief.docx', {
      ...docx('Redesign the pricing page', 'Keep it calm &amp; clear'),
      'docProps/core.xml':
        '<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title>Pricing brief</dc:title></cp:coreProperties>',
    });
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]).toEqual({
      name: 'brief.docx',
      path: 'brief.docx',
      excerpt: 'Title: Pricing brief\n\nRedesign the pricing page\nKeep it calm & clear',
      note: 'Text extracted from a DOCX file; layout, images and charts are not included.',
    });
  });

  it('reads a document that sits in the workspace, from its workspace-relative path and an unknown size', async () => {
    const file = await attach('brief.docx', docx('From the workspace'));
    const workspaceRoot = path.dirname(file.path);
    const { attachments } = await preparePromptContext({
      workspaceRoot,
      attachments: [{ path: 'brief.docx', name: 'brief.docx', size: 0 }],
    });
    expect(attachments[0]).toMatchObject({
      name: 'brief.docx',
      path: 'brief.docx',
      excerpt: 'From the workspace',
    });
  });

  it('reads a PPTX slide by slide', async () => {
    const file = await attach('deck.pptx', {
      'ppt/slides/slide2.xml': slide('Roadmap'),
      'ppt/slides/slide1.xml': slide('Launch plan', 'Q3'),
    });
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toBe('Slide 1:\nLaunch plan\nQ3\n\nSlide 2:\nRoadmap');
  });

  it('reads an XLSX sheet by sheet', async () => {
    const file = await attach('content.xlsx', {
      'xl/workbook.xml': workbook(['Copy', 'rId1']),
      'xl/_rels/workbook.xml.rels': relationships(['rId1', 'worksheet', 'worksheets/sheet1.xml']),
      'xl/sharedStrings.xml': `<sst ${S}><si><t>Headline</t></si><si><t>Ship faster</t></si></sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData><row r="1"><c r="A1" s="1"/><c r="B1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>`,
    });
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toBe('Sheet "Copy":\nHeadline\nShip faster · 42');
  });

  it('gives each sheet name the content of its own worksheet when the tabs are in reverse part order', async () => {
    const file = await attach('finance.xlsx', {
      'xl/workbook.xml': workbook(['Expenses', 'rId2'], ['Revenue', 'rId1']),
      'xl/_rels/workbook.xml.rels': relationships(
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ),
      'xl/worksheets/sheet1.xml': oneCell('Revenue = 1000000'),
      'xl/worksheets/sheet2.xml': oneCell('Expenses = 900000'),
    });
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toBe(
      'Sheet "Expenses":\nExpenses = 900000\n\nSheet "Revenue":\nRevenue = 1000000',
    );
  });

  it('pairs sheet names with worksheets whose part names do not match the tab positions', async () => {
    const file = await attach('regions.xlsx', {
      'xl/workbook.xml': workbook(['North', 'rId4'], ['South', 'rId2'], ['East', 'rId9']),
      'xl/_rels/workbook.xml.rels': relationships(
        ['rId2', 'worksheet', 'worksheets/sheet10.xml'],
        ['rId4', 'worksheet', 'worksheets/sheet3.xml'],
        ['rId9', 'worksheet', '/xl/worksheets/east.xml'],
      ),
      'xl/worksheets/sheet3.xml': oneCell('north data'),
      'xl/worksheets/sheet10.xml': oneCell('south data'),
      'xl/worksheets/east.xml': oneCell('east data'),
    });
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toBe(
      'Sheet "North":\nnorth data\n\nSheet "South":\nsouth data\n\nSheet "East":\neast data',
    );
  });

  it('fails the send, naming the file, when a sheet points at a worksheet the archive lacks', async () => {
    const file = await attach('broken.xlsx', {
      'xl/workbook.xml': workbook(['Revenue', 'rId1'], ['Expenses', 'rId2']),
      'xl/_rels/workbook.xml.rels': relationships(
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ),
      'xl/worksheets/sheet1.xml': oneCell('Sales 5400'),
    });
    await expect(preparePromptContext({ attachments: [file] })).rejects.toMatchObject({
      code: 'ATTACHMENT_READ_FAILED',
      message: expect.stringContaining(
        '"broken.xlsx" as a XLSX file: it has no xl/worksheets/sheet2.xml.',
      ),
    });
  });

  it('fails the send when the workbook has no relationships part', async () => {
    const file = await attach('bare.xlsx', {
      'xl/workbook.xml': workbook(['Revenue', 'rId1']),
      'xl/worksheets/sheet1.xml': oneCell('Sales 5400'),
    });
    await expect(preparePromptContext({ attachments: [file] })).rejects.toMatchObject({
      code: 'ATTACHMENT_READ_FAILED',
      message: expect.stringContaining('it has no xl/_rels/workbook.xml.rels.'),
    });
  });

  it('says what the limits left out of the text the model gets', async () => {
    const paragraphs = Array.from({ length: 450 }, (_, n) => `Paragraph ${n}`);
    const file = await attach('long.docx', docx(...paragraphs));
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toContain('Paragraph 399');
    expect(attachments[0]?.excerpt).not.toContain('Paragraph 400');
    expect(attachments[0]?.excerpt?.endsWith(omittedMark(50, 'paragraph'))).toBe(true);
    expect(attachments[0]?.note).not.toContain('truncated');
  });

  it('cuts the excerpt at the character limit and says so', async () => {
    const file = await attach(
      'wide.docx',
      docx(...Array.from({ length: 60 }, () => 'x'.repeat(480))),
    );
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]?.excerpt).toHaveLength(6_000);
    expect(attachments[0]?.note).toContain('Excerpt truncated to the first 6000 characters.');
  });

  it('says a document with no text has none', async () => {
    const file = await attach('empty.docx', docx());
    const { attachments } = await preparePromptContext({ attachments: [file] });
    expect(attachments[0]).toEqual({
      name: 'empty.docx',
      path: 'empty.docx',
      note: 'DOCX file with no text in it.',
    });
  });

  describe('a file that cannot be read as the format it claims', () => {
    it('fails with the file named when it is not an archive', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-document-attachment-'));
      const filePath = path.join(dir, 'renamed.docx');
      await fs.writeFile(filePath, 'this is plain text');
      await expect(
        preparePromptContext({ attachments: [{ path: filePath, name: 'renamed.docx', size: 18 }] }),
      ).rejects.toMatchObject({
        code: 'ATTACHMENT_READ_FAILED',
        message: 'Could not read "renamed.docx" as a DOCX file.',
        cause: expect.any(Error),
      });
    });

    it('checks the size on disk, not the size the renderer reports', async () => {
      const file = await attach('big.docx', {
        'word/document.xml': randomBytes(11_000_000),
      });
      await expect(
        preparePromptContext({ attachments: [{ ...file, size: 1_000 }] }),
      ).rejects.toMatchObject({
        code: 'ATTACHMENT_TOO_LARGE',
        message: expect.stringContaining('Binary attachment "big.docx" is too large'),
      });
    });

    it('fails with the missing part named when the archive lacks it', async () => {
      const file = await attach('odd.pptx', { 'unrelated.txt': 'x' });
      await expect(preparePromptContext({ attachments: [file] })).rejects.toMatchObject({
        code: 'ATTACHMENT_READ_FAILED',
        message: 'Could not read "odd.pptx" as a PPTX file: it has no ppt/slides/slide1.xml.',
      });
    });

    it('fails as too large when the archive unpacks past the limit, without unpacking it', async () => {
      const file = await attach('bomb.docx', {
        'word/document.xml': Buffer.alloc(40 * 1024 * 1024, 0x20),
      });
      expect(file.size).toBeLessThan(1024 * 1024);
      const start = performance.now();
      await expect(preparePromptContext({ attachments: [file] })).rejects.toMatchObject({
        code: 'ATTACHMENT_TOO_LARGE',
        message: expect.stringContaining('holds more than 32MB of text once unpacked'),
      });
      expect(performance.now() - start).toBeLessThan(5_000);
    });

    it('fails the whole send, naming the file, when only one of several attachments is bad', async () => {
      const good = await attach('good.docx', docx('Fine'));
      const bad = await attach('bad.xlsx', { 'unrelated.txt': 'x' });
      await expect(preparePromptContext({ attachments: [good, bad] })).rejects.toMatchObject({
        code: 'ATTACHMENT_READ_FAILED',
        message: expect.stringContaining('"bad.xlsx"'),
      });
    });
  });

  it('keeps the filename note for formats it does not read, so they are not reported as broken', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-document-attachment-'));
    const files = [];
    for (const name of ['report.pdf', 'old.doc', 'old.ppt', 'old.xls']) {
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, Buffer.from([0x25, 0x50, 0x00, 0x01, 0x02]));
      files.push({ path: filePath, name, size: 5 });
    }
    const { attachments } = await preparePromptContext({ attachments: files });
    expect(attachments.map((attachment) => attachment.note)).toEqual([
      'Binary or unsupported format (.pdf). Use the filename as a hint, not quoted content.',
      'Binary or unsupported format (.doc). Use the filename as a hint, not quoted content.',
      'Binary or unsupported format (.ppt). Use the filename as a hint, not quoted content.',
      'Binary or unsupported format (.xls). Use the filename as a hint, not quoted content.',
    ]);
  });

  it('loads the document reader only when a document is attached', async () => {
    const source = await fs.readFile(path.join(__dirname, 'prompt-context.ts'), 'utf8');
    const staticImports = source.split('\n').filter((line) => /^import\b(?!\s+type)/.test(line));
    expect(staticImports.filter((line) => /document-text|jszip/.test(line))).toEqual([]);
    expect(source).toMatch(/await import\(\s*'\.\/document-text'\s*\)/);
  });
});
