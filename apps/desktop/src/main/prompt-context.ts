import { lookup as dnsLookup } from 'node:dns/promises';
import { open, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { extname, isAbsolute, relative as relativePath, sep } from 'node:path';
import type { AttachmentContext, ProjectContext, ReferenceUrlContext } from '@open-codesign/core';
import {
  CodesignError,
  ERROR_CODES,
  formatDesignMdForPrompt,
  type LocalInputFile,
  normalizeReferenceUrlInput,
  type StoredDesignSystem,
  validateDesignMd,
} from '@open-codesign/shared';
import {
  collapseWhitespace,
  extractHtmlElementInner,
  getHtmlAttribute,
  removeHtmlElementBlocks,
  stripHtmlTags,
} from '@open-codesign/shared/html-utils';
import type { DocumentTextLimits, OoxmlFormat } from './document-text';
import { resolveSafeWorkspaceChildPath } from './workspace-reader';

const TEXT_EXTS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.less',
  '.md',
  '.mjs',
  '.scss',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sniffImageMimeType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    buffer.length >= 6 &&
    (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

const MAX_ATTACHMENT_CHARS = 6_000;
const MAX_TEXT_ATTACHMENT_BYTES = 256_000;
const MAX_BINARY_ATTACHMENT_BYTES = 10_000_000; // 10MB - images get a full read for the data URL, Office documents a full read for their text; other binary files stay filename-only
// Only MAX_ATTACHMENT_CHARS of a document reach the prompt, so these bound the work of reading it,
// not what the model sees. They are the attachment's own numbers: the Files tab preview keeps its own.
const DOCUMENT_ATTACHMENT_LIMITS: DocumentTextLimits = {
  maxSections: 30,
  maxParagraphs: 400,
  maxLinesPerSlide: 40,
  maxRowsPerSheet: 200,
  maxCellsPerRow: 20,
  maxLineChars: 500,
  maxUnpackedBytes: 32 * 1024 * 1024,
  markCuts: true,
};
const DOCUMENT_FORMATS: Record<string, OoxmlFormat> = {
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
};
const MAX_URL_EXCERPT_CHARS = 1_200;
const MAX_URL_RESPONSE_BYTES = 256_000;
const MAX_REFERENCE_URL_REDIRECTS = 3;
const MAX_PROJECT_CONTEXT_CHARS = 10_000;
const MAX_PROJECT_SETTINGS_CHARS = 4_000;
/** Whole-inspection budget, including DNS, redirects, and a slow first byte. */
export const REFERENCE_URL_TIMEOUT_MS = 15_000;
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/html']);
const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/xml',
  'text/x-markdown',
]);
const REFERENCE_REQUEST_HEADERS = {
  accept:
    'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.8,*/*;q=0.1',
  'accept-encoding': 'identity',
  'user-agent': 'OpenCoDesign (local desktop app; reference context)',
};
const ALLOWED_PROJECT_SETTING_KEYS = new Set([
  'schemaVersion',
  'artifactType',
  'brandRef',
  'defaultBrandRef',
  'density',
  'designSystemPath',
  'fidelity',
  'language',
  'preferredSkills',
  'theme',
  'viewport',
]);

type ReferenceHostResolver = (hostname: string) => Promise<string[]>;
type ReferenceFetcher = (
  safeUrl: string,
  signal: AbortSignal,
  resolveReferenceHost: ReferenceHostResolver,
) => Promise<Response>;

async function defaultResolveReferenceHost(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

function parseReferenceHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new CodesignError(
      'Reference URL is not a valid HTTP(S) URL',
      ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
      { cause: error },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CodesignError(
      `Unsupported reference URL protocol "${parsed.protocol || 'unknown'}"`,
      ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
    );
  }
  if (parsed.username || parsed.password) {
    throw new CodesignError(
      'Reference URL must not include embedded credentials',
      ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
    );
  }
  if (isPrivateReferenceHostname(parsed.hostname)) {
    throw new CodesignError(
      `Reference URL host "${parsed.hostname}" is not allowed. Private and local addresses are blocked.`,
      ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
    );
  }
  return parsed;
}

function isPrivateReferenceHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);
  return false;
}

async function validateResolvedReferenceHost(
  parsedUrl: URL,
  resolveReferenceHost: ReferenceHostResolver,
  signal: AbortSignal,
): Promise<void> {
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  if (net.isIP(hostname)) return;

  try {
    await resolvePublicReferenceAddresses(hostname, resolveReferenceHost, signal);
  } catch (cause) {
    if (cause instanceof CodesignError) throw cause;
    throw new CodesignError(
      `Reference URL host "${parsedUrl.hostname}" could not be resolved`,
      ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      { cause },
    );
  }
}

async function resolvePublicReferenceAddresses(
  hostname: string,
  resolveReferenceHost: ReferenceHostResolver,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) {
    throw new CodesignError(
      `Fetching the reference URL timed out after ${REFERENCE_URL_TIMEOUT_MS / 1000} seconds while resolving ${hostname}. Try again or use a different page.`,
      ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        new CodesignError(
          `Fetching the reference URL timed out after ${REFERENCE_URL_TIMEOUT_MS / 1000} seconds while resolving ${hostname}. Try again or use a different page.`,
          ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    resolveReferenceHost(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          reject(
            new CodesignError(
              `Reference URL host "${hostname}" resolved to no addresses`,
              ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
            ),
          );
          return;
        }
        const blocked = addresses.find((address) => isPrivateReferenceHostname(address));
        if (blocked !== undefined) {
          reject(
            new CodesignError(
              `Reference URL host "${hostname}" resolved to a blocked address`,
              ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
            ),
          );
          return;
        }
        resolve(addresses);
      }, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === '::' || hostname === '::1') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(hostname)) return true;
  if (hostname.startsWith('ff')) return true;
  if (hostname.startsWith('2001:db8')) return true;
  if (!hostname.startsWith('::ffff:')) return false;

  const suffix = hostname.slice('::ffff:'.length);
  if (suffix.includes('.')) return isPrivateIpv4(suffix);
  const hextets = suffix.split(':');
  if (hextets.length !== 2) return true;
  if (!hextets.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return true;
  const high = Number.parseInt(hextets[0] ?? '', 16);
  const low = Number.parseInt(hextets[1] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return true;
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return true;
  return isPrivateIpv4(
    [high >> 8, high & 0xff, low >> 8, low & 0xff].map((part) => String(part)).join('.'),
  );
}

function cleanText(raw: string, maxChars: number): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

function stripHtml(raw: string): string {
  return collapseWhitespace(
    stripHtmlTags(removeHtmlElementBlocks(removeHtmlElementBlocks(raw, 'script'), 'style')),
  ).trim();
}

function metaDescription(html: string): string | undefined {
  let description: string | undefined;
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf('<meta', cursor);
    if (start < 0) break;
    const next = lower[start + 5] ?? '';
    if (next !== '>' && next.trim().length !== 0) {
      cursor = start + 5;
      continue;
    }
    const end = html.indexOf('>', start);
    if (end < 0) break;
    const attrs = html.slice(start + 5, end);
    const name = getHtmlAttribute(attrs, 'name')?.toLowerCase();
    const property = getHtmlAttribute(attrs, 'property')?.toLowerCase();
    if (name === 'description' || property === 'og:description') {
      const content = getHtmlAttribute(attrs, 'content');
      if (content) description = content;
    }
    cursor = end + 1;
  }
  return description;
}

function isProbablyText(buffer: Buffer, extension: string): boolean {
  if (TEXT_EXTS.has(extension)) return true;
  const probe = buffer.subarray(0, 512);
  return !probe.includes(0);
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readWorkspaceText(
  workspaceRoot: string,
  relativePath: string,
  maxChars: number,
): Promise<string | undefined> {
  let filePath: string;
  try {
    filePath = await resolveSafeWorkspaceChildPath(workspaceRoot, relativePath);
  } catch (cause) {
    throw new CodesignError(
      `Project context path is invalid: ${relativePath}`,
      ERROR_CODES.CONFIG_SCHEMA_INVALID,
      { cause },
    );
  }
  try {
    const text = await readFile(filePath, 'utf8');
    return cleanText(text, maxChars);
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw new CodesignError(
      `Failed to read project context file "${relativePath}"`,
      ERROR_CODES.CONFIG_READ_FAILED,
      { cause: err },
    );
  }
}

async function readWorkspaceRawText(
  workspaceRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  let filePath: string;
  try {
    filePath = await resolveSafeWorkspaceChildPath(workspaceRoot, relativePath);
  } catch (cause) {
    throw new CodesignError(
      `Project context path is invalid: ${relativePath}`,
      ERROR_CODES.CONFIG_SCHEMA_INVALID,
      { cause },
    );
  }
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw new CodesignError(
      `Failed to read project context file "${relativePath}"`,
      ERROR_CODES.CONFIG_READ_FAILED,
      { cause: err },
    );
  }
}

function designMdContext(raw: string): Pick<ProjectContext, 'designMd' | 'invalidDesignMd'> {
  const findings = validateDesignMd(raw);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    return {
      invalidDesignMd: {
        errors: errors.map((finding) => `${finding.path}: ${finding.message}`).slice(0, 10),
        raw: cleanText(raw, MAX_PROJECT_CONTEXT_CHARS),
      },
    };
  }
  try {
    return { designMd: formatDesignMdForPrompt(raw) };
  } catch (cause) {
    return {
      invalidDesignMd: {
        errors: [
          `DESIGN.md could not be prepared for prompt context: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ],
        raw: cleanText(raw, MAX_PROJECT_CONTEXT_CHARS),
      },
    };
  }
}

function safeProjectSettings(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CodesignError(
      '.codesign/settings.json is not valid JSON',
      ERROR_CODES.CONFIG_PARSE_FAILED,
      { cause: err },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CodesignError(
      '.codesign/settings.json must contain an object',
      ERROR_CODES.CONFIG_SCHEMA_INVALID,
    );
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!ALLOWED_PROJECT_SETTING_KEYS.has(key)) continue;
    if (/key|secret|token|password/i.test(key)) continue;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    ) {
      safe[key] = value;
    }
  }
  const text = JSON.stringify(safe, null, 2);
  return text === '{}' ? undefined : cleanText(text, MAX_PROJECT_SETTINGS_CHARS);
}

async function readProjectContext(workspaceRoot: string | undefined): Promise<ProjectContext> {
  if (!workspaceRoot) return {};
  const [agentsMd, rawDesignMd, rawSettings] = await Promise.all([
    readWorkspaceText(workspaceRoot, 'AGENTS.md', MAX_PROJECT_CONTEXT_CHARS),
    readWorkspaceRawText(workspaceRoot, 'DESIGN.md'),
    readWorkspaceText(workspaceRoot, '.codesign/settings.json', MAX_PROJECT_SETTINGS_CHARS),
  ]);
  const settingsJson = rawSettings === undefined ? undefined : safeProjectSettings(rawSettings);
  const designMd = rawDesignMd === undefined ? {} : designMdContext(rawDesignMd);
  return {
    ...(agentsMd !== undefined ? { agentsMd } : {}),
    ...designMd,
    ...(settingsJson !== undefined ? { settingsJson } : {}),
  };
}

const WORKSPACE_ATTACHMENT_DIRS = ['references', 'assets'] as const;

function normalizePromptPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function workspaceAttachmentRelativePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const alreadyRelative = normalizePromptPath(normalized);
  if (WORKSPACE_ATTACHMENT_DIRS.some((dir) => alreadyRelative.startsWith(`${dir}/`))) {
    return alreadyRelative;
  }

  for (const dir of WORKSPACE_ATTACHMENT_DIRS) {
    const marker = `/${dir}/`;
    const index = normalized.lastIndexOf(marker);
    if (index !== -1) return normalized.slice(index + 1);
  }
  return null;
}

async function openAttachment(
  file: LocalInputFile,
  workspaceRoot: string | undefined,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; promptPath: string }> {
  const candidates: Array<{ readPath: string; promptPath: string }> = [];

  if (!isAbsolute(file.path)) {
    if (workspaceRoot !== undefined) {
      const promptPath = normalizePromptPath(file.path);
      candidates.push({
        readPath: await resolveSafeWorkspaceChildPath(workspaceRoot, promptPath),
        promptPath,
      });
    } else {
      candidates.push({ readPath: file.path, promptPath: file.path });
    }
  } else {
    const relative = workspaceRoot === undefined ? null : relativePath(workspaceRoot, file.path);
    const ownedPromptPath =
      relative !== null &&
      relative.length > 0 &&
      relative !== '..' &&
      !relative.startsWith(`..${sep}`) &&
      !isAbsolute(relative)
        ? normalizePromptPath(relative)
        : file.name;
    // An explicit existing attachment wins over a same-named workspace file.
    // Keep host paths out of prompt text without changing which bytes are read.
    candidates.push({ readPath: file.path, promptPath: ownedPromptPath });
    if (workspaceRoot !== undefined) {
      const rebasedPath = workspaceAttachmentRelativePath(file.path);
      if (rebasedPath !== null) {
        candidates.push({
          readPath: await resolveSafeWorkspaceChildPath(workspaceRoot, rebasedPath),
          promptPath: rebasedPath,
        });
      }
    }
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return { handle: await open(candidate.readPath, 'r'), promptPath: candidate.promptPath };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * A DOCX, PPTX or XLSX attachment as text. A file that cannot be read as that format fails the
 * attachment, with a message that names the file, and so the send, before any model request:
 * the model is never left to plan around a file it did not read. Formats this does not read
 * (PDF, the legacy binary Office formats) keep the filename note.
 */
async function readDocumentAttachment(
  file: LocalInputFile,
  workspaceRoot: string | undefined,
  format: OoxmlFormat,
): Promise<AttachmentContext> {
  const label = format.toUpperCase();
  let bytes: Buffer;
  let promptPath = file.path;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const opened = await openAttachment(file, workspaceRoot);
    handle = opened.handle;
    promptPath = opened.promptPath;
    const { size } = await handle.stat();
    if (size > MAX_BINARY_ATTACHMENT_BYTES) {
      throw new CodesignError(
        `Binary attachment "${file.name}" is too large (${size} bytes). Maximum is ${MAX_BINARY_ATTACHMENT_BYTES / 1_000_000}MB.`,
        ERROR_CODES.ATTACHMENT_TOO_LARGE,
      );
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof CodesignError) throw error;
    throw new CodesignError(
      `Failed to read attachment "${file.path}"`,
      ERROR_CODES.ATTACHMENT_READ_FAILED,
      { cause: error },
    );
  } finally {
    await handle?.close();
  }

  // Loaded on first use: JSZip and the parsers are not needed until someone attaches a document.
  const { DocumentTooLargeError, formatDocumentText, readOoxmlText } = await import(
    './document-text'
  );
  let text: Awaited<ReturnType<typeof readOoxmlText>>;
  try {
    text = await readOoxmlText(bytes, format, DOCUMENT_ATTACHMENT_LIMITS);
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw new CodesignError(
        `${label} attachment "${file.name}" holds more than ${DOCUMENT_ATTACHMENT_LIMITS.maxUnpackedBytes / (1024 * 1024)}MB of text once unpacked. Attach a smaller file.`,
        ERROR_CODES.ATTACHMENT_TOO_LARGE,
        { cause: error },
      );
    }
    throw new CodesignError(
      `Could not read "${file.name}" as a ${label} file.`,
      ERROR_CODES.ATTACHMENT_READ_FAILED,
      { cause: error },
    );
  }
  if (text.missingPart !== null) {
    throw new CodesignError(
      `Could not read "${file.name}" as a ${label} file: it has no ${text.missingPart}.`,
      ERROR_CODES.ATTACHMENT_READ_FAILED,
    );
  }

  const full = cleanText(formatDocumentText(text, format), Number.MAX_SAFE_INTEGER);
  if (full.length === 0) {
    return { name: file.name, path: promptPath, note: `${label} file with no text in it.` };
  }
  const truncated = full.length > MAX_ATTACHMENT_CHARS;
  return {
    name: file.name,
    path: promptPath,
    excerpt: full.slice(0, MAX_ATTACHMENT_CHARS),
    note: `Text extracted from a ${label} file; layout, images and charts are not included.${
      truncated ? ` Excerpt truncated to the first ${MAX_ATTACHMENT_CHARS} characters.` : ''
    }`,
  };
}

async function readAttachment(
  file: LocalInputFile,
  workspaceRoot: string | undefined,
): Promise<AttachmentContext> {
  const extension = extname(file.name).toLowerCase();
  const imageMimeType = IMAGE_MIME_TYPES[extension];

  // Binary attachments (images, etc) - images need full content for data URL
  // So allow larger size limit than text
  const isKnownTextExtension = TEXT_EXTS.has(extension);
  const maxFileBytes = isKnownTextExtension
    ? MAX_TEXT_ATTACHMENT_BYTES
    : MAX_BINARY_ATTACHMENT_BYTES;
  if (file.size > maxFileBytes) {
    throw new CodesignError(
      isKnownTextExtension
        ? `Text attachment "${file.name}" is too large (${file.size} bytes). Maximum is ${MAX_TEXT_ATTACHMENT_BYTES} bytes.`
        : `Binary attachment "${file.name}" is too large (${file.size} bytes). Maximum is ${MAX_BINARY_ATTACHMENT_BYTES / 1_000_000}MB.`,
      ERROR_CODES.ATTACHMENT_TOO_LARGE,
    );
  }

  const documentFormat = DOCUMENT_FORMATS[extension];
  if (documentFormat !== undefined)
    return readDocumentAttachment(file, workspaceRoot, documentFormat);

  let buffer: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let promptPath = file.path;
  try {
    const opened = await openAttachment(file, workspaceRoot);
    handle = opened.handle;
    promptPath = opened.promptPath;

    // Always read a small probe first to detect if it's actually text
    const probeBytes = 512;
    const probeBuffer = Buffer.alloc(probeBytes);
    const { bytesRead: probeRead } = await handle.read(probeBuffer, 0, probeBytes, 0);
    const probe = probeBuffer.subarray(0, probeRead);

    const looksText = isProbablyText(probe, extension);
    if (looksText && file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      // Any file that looks like text must obey the text size limit regardless of extension
      throw new CodesignError(
        `Text attachment "${file.name}" is too large (${file.size} bytes). Maximum is ${MAX_TEXT_ATTACHMENT_BYTES} bytes.`,
        ERROR_CODES.ATTACHMENT_TOO_LARGE,
      );
    }

    if (!looksText) {
      // Read the full binary when the extension is a known image OR the probe
      // looks like image bytes (clipboard pastes sometimes lack a useful name).
      if (imageMimeType || sniffImageMimeType(probe) !== null) {
        const length = Math.max(
          1,
          Math.min(file.size || MAX_BINARY_ATTACHMENT_BYTES, maxFileBytes),
        );
        const fullBuffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(fullBuffer, 0, fullBuffer.length, 0);
        buffer = fullBuffer.subarray(0, bytesRead);
      } else {
        // Non-image binary files stay filename-only for now.
        buffer = probe;
      }
    } else {
      // It looks like text and fits within limit - read the whole thing
      const length = Math.max(
        1,
        Math.min(file.size || MAX_TEXT_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES),
      );
      const fullBuffer = Buffer.alloc(length);
      // Read from start (we already have the probe, but just re-read for simplicity)
      const { bytesRead } = await handle.read(fullBuffer, 0, fullBuffer.length, 0);
      buffer = fullBuffer.subarray(0, bytesRead);
    }
  } catch (error) {
    if (error instanceof CodesignError) {
      // Already a properly coded error - rethrow directly
      throw error;
    }
    throw new CodesignError(
      `Failed to read attachment "${file.path}"`,
      ERROR_CODES.ATTACHMENT_READ_FAILED,
      {
        cause: error,
      },
    );
  } finally {
    await handle?.close();
  }

  if (!isProbablyText(buffer, extension)) {
    const resolvedImageMime = sniffImageMimeType(buffer) ?? imageMimeType;
    if (resolvedImageMime) {
      return {
        name: file.name,
        path: promptPath,
        note: 'Image bytes are embedded as multimodal content when the active model accepts image input; otherwise only the filename is available as a hint.',
        mediaType: resolvedImageMime,
        imageDataUrl: `data:${resolvedImageMime};base64,${buffer.toString('base64')}`,
      };
    }
    return {
      name: file.name,
      path: promptPath,
      note: `Binary or unsupported format (${extension || 'unknown'}). Use the filename as a hint, not quoted content.`,
    };
  }

  const fullText = buffer.toString('utf8');
  return {
    name: file.name,
    path: promptPath,
    excerpt: cleanText(fullText, MAX_ATTACHMENT_CHARS),
    note:
      Buffer.byteLength(fullText, 'utf8') > MAX_ATTACHMENT_CHARS
        ? 'Excerpt truncated to the most relevant leading content.'
        : undefined,
  };
}

async function readResponseText(response: Response, url: string): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_URL_RESPONSE_BYTES) {
    throw new CodesignError(
      `Reference URL response is too large (${contentLength} bytes) for ${url}`,
      ERROR_CODES.REFERENCE_URL_TOO_LARGE,
    );
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_URL_RESPONSE_BYTES) {
      throw new CodesignError(
        `Reference URL response is too large for ${url}`,
        ERROR_CODES.REFERENCE_URL_TOO_LARGE,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_URL_RESPONSE_BYTES) {
        throw new CodesignError(
          `Reference URL response is too large for ${url}`,
          ERROR_CODES.REFERENCE_URL_TOO_LARGE,
        );
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function referenceMediaType(contentType: string): string {
  return contentType.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function isBlockedReferenceMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith('image/') ||
    mediaType.startsWith('video/') ||
    mediaType.startsWith('audio/') ||
    mediaType.startsWith('font/') ||
    mediaType === 'application/pdf' ||
    mediaType === 'application/zip' ||
    mediaType === 'application/gzip' ||
    mediaType === 'application/x-gzip' ||
    mediaType === 'application/wasm'
  );
}

function looksLikeHtmlDocument(body: string): boolean {
  const head = body
    .replace(/^\uFEFF/u, '')
    .slice(0, 2_048)
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  );
}

function looksLikeReadableText(body: string): boolean {
  const sample = body.slice(0, 8_192);
  if (sample.length === 0 || sample.includes('\0')) return false;
  let controls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
  }
  return controls / sample.length < 0.02;
}

function referenceDocumentKind(contentType: string, body: string): 'html' | 'text' {
  const mediaType = referenceMediaType(contentType);
  if (isBlockedReferenceMediaType(mediaType)) {
    throw unsupportedReferenceContent(mediaType);
  }
  if (HTML_MEDIA_TYPES.has(mediaType) || looksLikeHtmlDocument(body)) return 'html';
  if (mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)) return 'text';
  if (
    (mediaType.length === 0 ||
      mediaType === 'application/octet-stream' ||
      mediaType === 'binary/octet-stream') &&
    looksLikeReadableText(body)
  ) {
    return 'text';
  }
  throw unsupportedReferenceContent(mediaType);
}

function unsupportedReferenceContent(mediaType: string): CodesignError {
  const label = mediaType.length > 0 ? mediaType : 'unknown';
  return new CodesignError(
    `Reference URL content type "${label}" is not supported. Use an HTML or text page.`,
    ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
  );
}

function publicReferenceLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    const label = url.toString();
    return label.length > 180 ? `${label.slice(0, 177)}...` : label;
  } catch {
    return 'the reference URL';
  }
}

function networkErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  return networkErrorCode((error as { cause?: unknown }).cause, depth + 1);
}

function referenceFetchFailureDetail(error: unknown): string {
  const code = networkErrorCode(error);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host could not be resolved';
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'the connection was reset';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_NONAME') {
    return 'the network is unreachable';
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return 'the connection timed out';
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return 'the TLS certificate could not be verified';
  }
  return 'the network request failed';
}

function isNoProxyHost(rawHostname: string): boolean {
  const raw = process.env['NO_PROXY'] ?? process.env['no_proxy'];
  if (!raw) return false;
  const host = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '');
  for (const entry of raw.split(',')) {
    const token = entry.trim().toLowerCase();
    if (token.length === 0) continue;
    if (token === '*') return true;
    const bare = token.replace(/^\*\./, '').replace(/^\./, '');
    if (bare.length === 0) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function configuredReferenceProxy(target: URL): URL | null {
  if (isNoProxyHost(target.hostname)) return null;
  const specific =
    target.protocol === 'https:'
      ? (process.env['HTTPS_PROXY'] ?? process.env['https_proxy'])
      : (process.env['HTTP_PROXY'] ?? process.env['http_proxy']);
  const raw = (specific ?? process.env['ALL_PROXY'] ?? process.env['all_proxy'] ?? '').trim();
  if (raw.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let proxy: URL;
  try {
    proxy = new URL(withScheme);
  } catch (error) {
    throw new CodesignError(
      'The HTTP proxy in Settings is not a valid proxy address. Use a link such as http://127.0.0.1:7890.',
      ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      { cause: error },
    );
  }
  if ((proxy.protocol !== 'http:' && proxy.protocol !== 'https:') || proxy.hostname.length === 0) {
    throw new CodesignError(
      'The HTTP proxy in Settings must be an http or https proxy, for example http://127.0.0.1:7890.',
      ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
    );
  }
  return proxy;
}

async function fetchReferenceThroughProxy(
  safeUrl: string,
  proxy: URL,
  signal: AbortSignal,
): Promise<Response> {
  // The proxy dials the destination, so the pinned lookup used on the direct
  // path cannot be applied here. Private hosts are still rejected before this
  // call, including hosts that resolve only to private addresses.
  const { ProxyAgent, fetch: undiciFetch } = await import('undici');
  const agent = new ProxyAgent(proxy.toString());
  try {
    const upstream = await undiciFetch(safeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: REFERENCE_REQUEST_HEADERS,
      dispatcher: agent,
    });
    const buffered = await bufferReferenceBody(upstream, safeUrl);
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
      headers.append(key, value);
    });
    return new Response(buffered, { status: upstream.status, headers });
  } finally {
    await agent.close().catch(() => undefined);
  }
}

async function bufferReferenceBody(
  upstream: { status: number; body: ReadableStream<Uint8Array> | null },
  url: string,
): Promise<Uint8Array | null> {
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return null;
  }
  if (!upstream.body) return new Uint8Array();
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_URL_RESPONSE_BYTES) {
        throw new CodesignError(
          `Reference URL response is too large for ${publicReferenceLabel(url)}`,
          ERROR_CODES.REFERENCE_URL_TOO_LARGE,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function defaultFetchReference(
  safeUrl: string,
  signal: AbortSignal,
  resolveReferenceHost: ReferenceHostResolver,
): Promise<Response> {
  const parsedUrl = new URL(safeUrl);
  const proxy = configuredReferenceProxy(parsedUrl);
  if (proxy) return fetchReferenceThroughProxy(safeUrl, proxy, signal);
  const client = parsedUrl.protocol === 'https:' ? https : http;
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  const lookup: http.RequestOptions['lookup'] | undefined = net.isIP(hostname)
    ? undefined
    : (lookupHostname, _options, callback) => {
        resolvePublicReferenceAddresses(lookupHostname, resolveReferenceHost, signal).then(
          (addresses) => {
            const address = addresses[0];
            const family = address ? net.isIP(address) : 0;
            if (!address || family === 0) {
              callback(
                new Error(`Reference URL host "${lookupHostname}" resolved to no IP address`),
                '',
                0,
              );
              return;
            }
            callback(null, address, family);
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)), '', 0);
          },
        );
      };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const settleResolve = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const req = client.request(
      parsedUrl,
      {
        method: 'GET',
        headers: REFERENCE_REQUEST_HEADERS,
        lookup,
        signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          } else if (value !== undefined) {
            headers.set(key, String(value));
          }
        }

        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          settleResolve(new Response(null, { status, headers }));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_URL_RESPONSE_BYTES) {
            res.destroy(
              new CodesignError(
                `Reference URL response is too large for ${safeUrl}`,
                ERROR_CODES.REFERENCE_URL_TOO_LARGE,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settleResolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status, headers }));
        });
        res.on('error', settleReject);
      },
    );
    req.on('error', settleReject);
    req.end();
  });
}

async function fetchReferenceUrl(
  rawUrl: string,
  signal: AbortSignal,
  resolveReferenceHost: ReferenceHostResolver,
  fetchReference: ReferenceFetcher,
  redirectCount = 0,
): Promise<{ response: Response; url: string }> {
  const parsedUrl = parseReferenceHttpUrl(rawUrl);
  await validateResolvedReferenceHost(parsedUrl, resolveReferenceHost, signal);
  const safeUrl = parsedUrl.toString();
  const response = await fetchReference(safeUrl, signal, resolveReferenceHost);

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_REFERENCE_URL_REDIRECTS) {
      throw new CodesignError(
        `Reference URL redirected too many times for ${safeUrl}`,
        ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      );
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new CodesignError(
        `Reference URL redirect missing Location header for ${safeUrl}`,
        ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      );
    }
    const nextUrl = new URL(location, safeUrl).toString();
    return fetchReferenceUrl(
      nextUrl,
      signal,
      resolveReferenceHost,
      fetchReference,
      redirectCount + 1,
    );
  }

  return { response, url: safeUrl };
}

async function inspectReferenceUrl(
  url: string,
  resolveReferenceHost: ReferenceHostResolver,
  fetchReference: ReferenceFetcher,
): Promise<ReferenceUrlContext> {
  const initialSafeUrl = parseReferenceHttpUrl(url).toString();
  const label = publicReferenceLabel(initialSafeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFERENCE_URL_TIMEOUT_MS);
  try {
    const { response, url: fetchedUrl } = await fetchReferenceUrl(
      initialSafeUrl,
      controller.signal,
      resolveReferenceHost,
      fetchReference,
    );
    const fetchedLabel = publicReferenceLabel(fetchedUrl);
    if (!response.ok) {
      throw new CodesignError(
        `The reference page at ${fetchedLabel} returned HTTP ${response.status}. Check that the page is public and reachable.`,
        ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      );
    }

    const rawBody = (await readResponseText(response, fetchedUrl)).replace(/^\uFEFF/u, '');
    const contentType = response.headers.get('content-type') ?? '';
    const kind = referenceDocumentKind(contentType, rawBody);
    const title = kind === 'html' ? extractHtmlElementInner(rawBody, 'title')?.trim() : undefined;
    const description = kind === 'html' ? metaDescription(rawBody) : undefined;
    const excerpt = cleanText(
      kind === 'html' ? stripHtml(rawBody) : rawBody,
      MAX_URL_EXCERPT_CHARS,
    );
    if (excerpt.length === 0 && !title && !description) {
      throw new CodesignError(
        `The reference page at ${fetchedLabel} returned no readable text. JavaScript-only pages are not supported.`,
        ERROR_CODES.REFERENCE_URL_UNSUPPORTED,
      );
    }

    return {
      url: fetchedUrl,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      excerpt,
    };
  } catch (error) {
    if (error instanceof CodesignError) throw error;
    if (controller.signal.aborted) {
      throw new CodesignError(
        `Fetching the reference URL timed out after ${REFERENCE_URL_TIMEOUT_MS / 1000} seconds. Try again or use a different page.`,
        ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
        { cause: error },
      );
    }
    throw new CodesignError(
      `Could not fetch ${label} (${referenceFetchFailureDetail(error)}). Check the address, your network, and the HTTP proxy in Settings if you use one.`,
      ERROR_CODES.REFERENCE_URL_FETCH_FAILED,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface PreparedPromptContext {
  designSystem: StoredDesignSystem | null;
  attachments: AttachmentContext[];
  referenceUrl: ReferenceUrlContext | null;
  projectContext: ProjectContext;
}

export async function preparePromptContext(input: {
  attachments?: LocalInputFile[] | undefined;
  referenceUrl?: string | undefined;
  designSystem?: StoredDesignSystem | null | undefined;
  resolveReferenceHost?: ReferenceHostResolver | undefined;
  fetchReference?: ReferenceFetcher | undefined;
  workspaceRoot?: string | undefined;
}): Promise<PreparedPromptContext> {
  const attachments = await Promise.all(
    (input.attachments ?? []).map((file) => readAttachment(file, input.workspaceRoot)),
  );
  const normalizedReferenceUrl =
    typeof input.referenceUrl === 'string' ? normalizeReferenceUrlInput(input.referenceUrl) : '';
  const referenceUrl =
    normalizedReferenceUrl.length > 0
      ? await inspectReferenceUrl(
          normalizedReferenceUrl,
          input.resolveReferenceHost ?? defaultResolveReferenceHost,
          input.fetchReference ?? defaultFetchReference,
        )
      : null;
  const projectContext = await readProjectContext(input.workspaceRoot);

  return {
    designSystem: input.designSystem ?? null,
    attachments,
    referenceUrl,
    projectContext,
  };
}
