import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DesignSessionBriefV1,
  normalizeDesignSessionBrief,
  SessionManager,
} from '@open-codesign/core';
import type {
  ChatAppendInput,
  ChatMessageKind,
  ChatMessageRow,
  ChatToolCallPayload,
  CommentCreateInput,
  CommentRow,
  CommentUpdateInput,
  DesignRunPreferencesV1,
} from '@open-codesign/shared';
import {
  ActiveRunMessageV1,
  CodesignError,
  type CommentApplyResultV1,
  type CommentContentExpectations,
  CommentRowV1,
  commentContentFingerprint,
  DesignRunPreferencesV1 as DesignRunPreferencesV1Schema,
} from '@open-codesign/shared';
import { compactToolResultForHistory } from './ipc/tool-log';
import { type Database, getDesign, listSnapshots, touchDesignActivity } from './snapshots-db';
import { normalizeWorkspacePath } from './workspace-path';

export const CHAT_MESSAGE_CUSTOM_TYPE = 'open-codesign.chat.message';
export const CHAT_TOOL_STATUS_CUSTOM_TYPE = 'open-codesign.chat.tool_status';
export const COMMENT_CUSTOM_TYPE = 'open-codesign.comment.v1';
export const CONTEXT_BRIEF_CUSTOM_TYPE = 'open-codesign.context.brief.v1';
export const RUN_PREFERENCES_CUSTOM_TYPE = 'open-codesign.context.run_preferences.v1';
export const ACTIVE_MESSAGE_CUSTOM_TYPE = 'open-codesign.active-message.v1';
const NATIVE_SEARCH_CUSTOM_TYPE = 'open-codesign.native-search.v1';

export function appendSessionNativeSearchMessage(
  opts: SessionChatStoreOptions,
  designId: string,
  message: import('@earendil-works/pi-ai').AssistantMessage,
): void {
  commitOnCache(openCache(opts, designId), NATIVE_SEARCH_CUSTOM_TYPE, {
    schemaVersion: 1,
    message,
  });
}

export function readSessionNativeSearchMessages(
  opts: SessionChatStoreOptions,
  designId: string,
): import('@earendil-works/pi-ai').AssistantMessage[] {
  const file = sessionFileForDesign(opts.sessionDir, designId);
  if (!existsSync(file)) return [];
  const entries = loadCache(opts, designId, false)?.manager.getEntries() ?? [];
  return entries
    .flatMap((entry) => {
      const custom = entry as CustomEntryLike;
      if (
        custom.type !== 'custom' ||
        custom.customType !== NATIVE_SEARCH_CUSTOM_TYPE ||
        !custom.data ||
        typeof custom.data !== 'object'
      )
        return [];
      const value = custom.data as {
        schemaVersion?: number;
        message?: import('@earendil-works/pi-ai').AssistantMessage;
      };
      const message = value.message;
      if (
        value.schemaVersion !== 1 ||
        message?.role !== 'assistant' ||
        !Array.isArray(message.content) ||
        !Array.isArray(message.nativeSearch?.output) ||
        !['openai', 'anthropic'].includes(message.nativeSearch.provider)
      )
        return [];
      return [message];
    })
    .slice(-100);
}

export interface SessionChatStoreOptions {
  db: Database;
  sessionDir: string;
}

export interface ChatToolStatusUpdate {
  designId: string;
  seq: number;
  status: 'done' | 'error';
  result?: unknown;
  durationMs?: number;
  errorMessage?: string;
  runResultEventKey?: string;
}

interface StoredChatMessage {
  schemaVersion: 1;
  id: number;
  seq: number;
  kind: ChatMessageKind;
  payload: unknown;
  snapshotId: string | null;
}

interface StoredToolStatusUpdate {
  schemaVersion: 1;
  seq: number;
  status: 'done' | 'error';
  result?: unknown;
  durationMs?: number;
  errorMessage?: string;
  runResultEventKey?: string;
}

type StoredCommentPatch = CommentUpdateInput & { appliedInSnapshotId?: null };
type StoredCommentEvent =
  | {
      schemaVersion: 1;
      action: 'add';
      row: CommentRow;
    }
  | {
      schemaVersion: 1;
      action: 'update';
      id: string;
      patch: StoredCommentPatch;
    }
  | {
      schemaVersion: 1;
      action: 'remove';
      id: string;
    }
  | {
      schemaVersion: 1;
      action: 'mark-applied';
      ids: string[];
      snapshotId: string;
    };

interface StoredDesignBrief {
  schemaVersion: 1;
  brief: DesignSessionBriefV1;
}

interface StoredRunPreferences {
  schemaVersion: 1;
  preferences: DesignRunPreferencesV1;
}

interface AppendSessionChatMessageOptions {
  touchActivity?: boolean;
}

interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
}

interface ChatProjection {
  rows: ChatMessageRow[];
  deliveredIds: Set<string>;
  eventKeys: Set<string>;
  toolCalls: Map<string, number>;
  rowIndexBySeq: Map<number, number>;
}

interface SessionCache {
  designId: string;
  file: string;
  cwd: string;
  manager: SessionManager;
  size: number;
  mtimeMs: number;
  projection: ChatProjection;
  activeMessages: Map<string, ActiveRunMessageV1>;
}

export interface SessionFileIoEvent {
  kind: 'open' | 'write';
  bytes: number;
}

const MAX_SESSION_CACHES = 8;
const sessionCaches = new Map<string, SessionCache>();
let sessionIoListener: ((event: SessionFileIoEvent) => void) | undefined;

/** Counts session loads and appends. Performance tests use this; production leaves it unset. */
export function setSessionFileIoListener(
  listener: ((event: SessionFileIoEvent) => void) | undefined,
): void {
  sessionIoListener = listener;
}

export function clearSessionFileCache(): void {
  sessionCaches.clear();
}

function sessionFileForDesign(sessionDir: string, designId: string): string {
  const safeId = designId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(sessionDir, `${safeId}.jsonl`);
}

function resolveSessionCwd(opts: SessionChatStoreOptions, designId: string): string {
  const design = getDesign(opts.db, designId);
  if (design === null) {
    throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
  }
  if (design.workspacePath === null) {
    throw new CodesignError('Design is not bound to a workspace', 'IPC_BAD_INPUT');
  }
  try {
    return normalizeWorkspacePath(design.workspacePath);
  } catch (cause) {
    throw new CodesignError('Stored workspace path is invalid', 'IPC_BAD_INPUT', { cause });
  }
}

function emptyProjection(): ChatProjection {
  return {
    rows: [],
    deliveredIds: new Set(),
    eventKeys: new Set(),
    toolCalls: new Map(),
    rowIndexBySeq: new Map(),
  };
}

function fileStamp(file: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fileSize(file: string): number {
  return fileStamp(file)?.size ?? 0;
}

function rememberStamp(cache: SessionCache): void {
  const stamp = fileStamp(cache.file);
  cache.size = stamp?.size ?? 0;
  cache.mtimeMs = stamp?.mtimeMs ?? 0;
}

function touchCache(cache: SessionCache): void {
  sessionCaches.delete(cache.file);
  sessionCaches.set(cache.file, cache);
  while (sessionCaches.size > MAX_SESSION_CACHES) {
    const oldest = sessionCaches.keys().next().value;
    if (oldest === undefined) break;
    sessionCaches.delete(oldest);
  }
}

function cacheMatches(
  cache: SessionCache,
  cwd: string,
  stamp: { size: number; mtimeMs: number },
): boolean {
  return cache.cwd === cwd && cache.size === stamp.size && cache.mtimeMs === stamp.mtimeMs;
}

/**
 * One SessionManager per design file. `SessionManager.open` reads the JSONL
 * (twice, inside pi) and is the only full load; later row checks hit the index.
 */
function loadCache(
  opts: SessionChatStoreOptions,
  designId: string,
  create: boolean,
): SessionCache | null {
  const cwd = resolveSessionCwd(opts, designId);
  const file = sessionFileForDesign(opts.sessionDir, designId);
  const stamp = fileStamp(file);
  const cached = sessionCaches.get(file);
  if (cached && stamp && cacheMatches(cached, cwd, stamp)) {
    touchCache(cached);
    return cached;
  }
  if (!stamp && !create) {
    if (cached) sessionCaches.delete(file);
    return null;
  }
  mkdirSync(opts.sessionDir, { recursive: true });
  const manager = SessionManager.open(file, opts.sessionDir, cwd);
  sessionIoListener?.({ kind: 'open', bytes: stamp?.size ?? 0 });
  const cache: SessionCache = {
    designId,
    file,
    cwd,
    manager,
    size: 0,
    mtimeMs: 0,
    projection: emptyProjection(),
    activeMessages: new Map(),
  };
  for (const entry of manager.getEntries()) {
    applyProjectionEntry(designId, cache.projection, cache.activeMessages, entry);
  }
  rememberStamp(cache);
  touchCache(cache);
  return cache;
}

function openCache(opts: SessionChatStoreOptions, designId: string): SessionCache {
  const cache = loadCache(opts, designId, true);
  if (!cache) throw new CodesignError('Session file unavailable', 'IPC_DB_ERROR');
  return cache;
}

function toolKey(runId: string, toolCallId: string): string {
  return `${runId}\0${toolCallId}`;
}

/**
 * pi appends when the open file is already flushed, and skips user-only
 * sessions until an assistant message exists. Persist the missing line here
 * instead of rewriting the history those paths used to flush.
 */
function persistNewEntry(cache: SessionCache, entry: unknown, before: number): number {
  const after = fileSize(cache.file);
  if (after !== before) return after - before;
  const header = cache.manager.getHeader();
  const sessionFile = cache.manager.getSessionFile();
  if (header === null || sessionFile === undefined) {
    throw new CodesignError('Session file unavailable', 'IPC_DB_ERROR');
  }
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  if (before === 0) {
    const lines = [header, ...cache.manager.getEntries()].map((item) => JSON.stringify(item));
    const body = `${lines.join('\n')}\n`;
    writeFileSync(sessionFile, body, 'utf8');
    return Buffer.byteLength(body);
  }
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(sessionFile, line);
  return Buffer.byteLength(line);
}

function commitOnCache(cache: SessionCache, customType: string, data: unknown): CustomEntryLike {
  const before = fileSize(cache.file);
  const entryId = cache.manager.appendCustomEntry(customType, data);
  const entry = cache.manager.getEntry(entryId);
  if (!entry || entry.type !== 'custom') {
    throw new CodesignError('Session entry missing after append', 'IPC_DB_ERROR');
  }
  const written = persistNewEntry(cache, entry, before);
  applyProjectionEntry(cache.designId, cache.projection, cache.activeMessages, entry);
  rememberStamp(cache);
  if (written > 0) sessionIoListener?.({ kind: 'write', bytes: written });
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStoredMessage(value: unknown): StoredChatMessage | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== 1) return null;
  if (typeof value['id'] !== 'number') return null;
  if (typeof value['seq'] !== 'number') return null;
  if (typeof value['kind'] !== 'string') return null;
  const snapshotId = value['snapshotId'];
  if (snapshotId !== null && typeof snapshotId !== 'string') return null;
  return {
    schemaVersion: 1,
    id: value['id'],
    seq: value['seq'],
    kind: value['kind'] as ChatMessageKind,
    payload: value['payload'] ?? {},
    snapshotId,
  };
}

function parseStatusUpdate(value: unknown): StoredToolStatusUpdate | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== 1) return null;
  if (typeof value['seq'] !== 'number') return null;
  if (value['status'] !== 'done' && value['status'] !== 'error') return null;
  const base: StoredToolStatusUpdate = {
    schemaVersion: 1,
    seq: value['seq'],
    status: value['status'],
  };
  return {
    ...base,
    ...(value['result'] !== undefined ? { result: value['result'] } : {}),
    ...(typeof value['durationMs'] === 'number' ? { durationMs: value['durationMs'] } : {}),
    ...(typeof value['errorMessage'] === 'string' ? { errorMessage: value['errorMessage'] } : {}),
    ...(typeof value['runResultEventKey'] === 'string'
      ? { runResultEventKey: value['runResultEventKey'] }
      : {}),
  };
}

function parseCommentEvent(value: unknown): StoredCommentEvent | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== 1) return null;
  const action = value['action'];
  if (action === 'add') {
    const parsed = CommentRowV1.safeParse(value['row']);
    if (!parsed.success) return null;
    return { schemaVersion: 1, action, row: parsed.data };
  }
  if (action === 'update') {
    if (typeof value['id'] !== 'string') return null;
    const patch = value['patch'];
    if (!isRecord(patch)) return null;
    const nextPatch: StoredCommentPatch = {};
    if (patch['appliedInSnapshotId'] === null) nextPatch.appliedInSnapshotId = null;
    if (typeof patch['text'] === 'string') nextPatch.text = patch['text'];
    if (
      patch['status'] === 'pending' ||
      patch['status'] === 'applied' ||
      patch['status'] === 'dismissed'
    ) {
      nextPatch.status = patch['status'];
    }
    if (Object.keys(nextPatch).length === 0) return null;
    return { schemaVersion: 1, action, id: value['id'], patch: nextPatch };
  }
  if (action === 'remove') {
    if (typeof value['id'] !== 'string') return null;
    return { schemaVersion: 1, action, id: value['id'] };
  }
  if (action === 'mark-applied') {
    if (!Array.isArray(value['ids']) || !value['ids'].every((id) => typeof id === 'string')) {
      return null;
    }
    if (typeof value['snapshotId'] !== 'string' || value['snapshotId'].length === 0) return null;
    return {
      schemaVersion: 1,
      action,
      ids: value['ids'],
      snapshotId: value['snapshotId'],
    };
  }
  return null;
}

function parseStoredBrief(value: unknown): StoredDesignBrief | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== 1) return null;
  const rawBrief = value['brief'];
  if (!isRecord(rawBrief)) return null;
  const designId = typeof rawBrief['designId'] === 'string' ? rawBrief['designId'] : '';
  const designName = typeof rawBrief['designName'] === 'string' ? rawBrief['designName'] : '';
  if (designId.length === 0 || designName.length === 0) return null;
  const now = typeof rawBrief['updatedAt'] === 'string' ? rawBrief['updatedAt'] : undefined;
  const brief = normalizeDesignSessionBrief(rawBrief, {
    designId,
    designName,
    ...(now !== undefined ? { now } : {}),
  });
  return brief === null ? null : { schemaVersion: 1, brief };
}

function parseStoredRunPreferences(value: unknown): StoredRunPreferences | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== 1) return null;
  const result = DesignRunPreferencesV1Schema.safeParse(value['preferences']);
  if (!result.success) return null;
  return { schemaVersion: 1, preferences: result.data };
}

function applyStatusUpdate(row: ChatMessageRow, update: StoredToolStatusUpdate): ChatMessageRow {
  if (row.kind !== 'tool_call') return row;
  const prev = { ...(isRecord(row.payload) ? row.payload : {}) };
  if (update.runResultEventKey !== undefined) {
    // A committed tool result replaces errors inferred by run settlement.
    delete prev['error'];
    delete prev['errorMessage'];
  }
  const nextPayload: ChatToolCallPayload = {
    ...(prev as unknown as ChatToolCallPayload),
    status: update.status,
    ...(update.runResultEventKey !== undefined
      ? { runResultEventKey: update.runResultEventKey }
      : {}),
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
    ...(update.errorMessage !== undefined
      ? { error: { message: update.errorMessage }, errorMessage: update.errorMessage }
      : {}),
  };
  return { ...row, payload: nextPayload };
}

function rememberChatRow(projection: ChatProjection, row: ChatMessageRow): void {
  projection.rowIndexBySeq.set(row.seq, projection.rows.length);
  projection.rows.push(row);
  if (!isRecord(row.payload)) return;
  const eventKey = row.payload['runEventKey'];
  if (typeof eventKey === 'string') projection.eventKeys.add(eventKey);
  if (row.kind !== 'tool_call') return;
  const runId = row.payload['runId'];
  const toolCallId = row.payload['toolCallId'];
  if (typeof runId !== 'string' || typeof toolCallId !== 'string') return;
  const key = toolKey(runId, toolCallId);
  if (!projection.toolCalls.has(key)) projection.toolCalls.set(key, row.seq);
}

function applyProjectionEntry(
  designId: string,
  projection: ChatProjection,
  activeMessages: Map<string, ActiveRunMessageV1>,
  raw: unknown,
): void {
  const entry = raw as CustomEntryLike;
  if (entry.type !== 'custom') return;
  if (entry.customType === ACTIVE_MESSAGE_CUSTOM_TYPE) {
    const message = ActiveRunMessageV1.parse(entry.data);
    if (message.designId !== designId)
      throw new CodesignError('Stored message belongs to another design.', 'IPC_DB_ERROR');
    activeMessages.set(message.messageId, message);
    if (message.status !== 'delivered' || projection.deliveredIds.has(message.messageId)) return;
    projection.deliveredIds.add(message.messageId);
    rememberChatRow(projection, {
      schemaVersion: 1,
      id: projection.rows.length,
      seq: projection.rows.length,
      designId,
      kind: 'user',
      payload: { text: message.text, activeMessageId: message.messageId, mode: message.mode },
      snapshotId: null,
      createdAt: entry.timestamp ?? message.createdAt,
    });
    return;
  }
  if (entry.customType === CHAT_MESSAGE_CUSTOM_TYPE) {
    const stored = parseStoredMessage(entry.data);
    if (stored === null) {
      throw new CodesignError('Malformed stored chat message entry', 'IPC_DB_ERROR');
    }
    rememberChatRow(projection, {
      schemaVersion: 1,
      id: stored.id,
      designId,
      seq: stored.seq,
      kind: stored.kind,
      payload: stored.payload,
      snapshotId: stored.snapshotId,
      createdAt: entry.timestamp ?? new Date(0).toISOString(),
    });
    return;
  }
  if (entry.customType === CHAT_TOOL_STATUS_CUSTOM_TYPE) {
    const update = parseStatusUpdate(entry.data);
    if (update === null) {
      throw new CodesignError('Malformed stored chat tool-status entry', 'IPC_DB_ERROR');
    }
    const idx = projection.rowIndexBySeq.get(update.seq);
    if (idx === undefined) return;
    const row = projection.rows[idx];
    if (row) projection.rows[idx] = applyStatusUpdate(row, update);
  }
}

export function listSessionChatMessages(
  opts: SessionChatStoreOptions,
  designId: string,
): ChatMessageRow[] {
  const cache = loadCache(opts, designId, false);
  if (!cache) return [];
  return cache.projection.rows.map((row) => ({ ...row }));
}

export function sessionHasRunEventKey(
  opts: SessionChatStoreOptions,
  designId: string,
  eventKey: string,
): boolean {
  const cache = loadCache(opts, designId, false);
  return cache?.projection.eventKeys.has(eventKey) ?? false;
}

export function findSessionToolCall(
  opts: SessionChatStoreOptions,
  designId: string,
  runId: string,
  toolCallId: string | undefined,
): ChatMessageRow | undefined {
  const cache = loadCache(opts, designId, false);
  if (!cache) return undefined;
  if (typeof toolCallId !== 'string') {
    const row = cache.projection.rows.find((candidate) => {
      if (candidate.kind !== 'tool_call' || !isRecord(candidate.payload)) return false;
      return candidate.payload['runId'] === runId && candidate.payload['toolCallId'] === undefined;
    });
    return row ? { ...row } : undefined;
  }
  const seq = cache.projection.toolCalls.get(toolKey(runId, toolCallId));
  if (seq === undefined) return undefined;
  const index = cache.projection.rowIndexBySeq.get(seq);
  if (index === undefined) return undefined;
  const row = cache.projection.rows[index];
  return row ? { ...row } : undefined;
}

export function appendSessionActiveMessage(
  opts: SessionChatStoreOptions,
  message: ActiveRunMessageV1,
): void {
  const checked = ActiveRunMessageV1.parse(message);
  commitOnCache(openCache(opts, checked.designId), ACTIVE_MESSAGE_CUSTOM_TYPE, checked);
}

export function listSessionActiveMessages(
  opts: SessionChatStoreOptions,
  designId: string,
): ActiveRunMessageV1[] {
  const cache = loadCache(opts, designId, false);
  if (!cache) return [];
  return [...cache.activeMessages.values()];
}

function replayCommentEvents(designId: string, entries: unknown[]): CommentRow[] {
  const rows = new Map<string, CommentRow>();
  for (const raw of entries) {
    const entry = raw as CustomEntryLike;
    if (entry.type !== 'custom' || entry.customType !== COMMENT_CUSTOM_TYPE) continue;
    const event = parseCommentEvent(entry.data);
    if (event === null) {
      throw new CodesignError('Malformed stored comment entry', 'IPC_DB_ERROR');
    }
    if (event.action === 'add') {
      if (event.row.designId === designId) rows.set(event.row.id, event.row);
      continue;
    }
    if (event.action === 'update') {
      const row = rows.get(event.id);
      if (row !== undefined) rows.set(event.id, { ...row, ...event.patch });
      continue;
    }
    if (event.action === 'remove') {
      rows.delete(event.id);
      continue;
    }
    for (const id of event.ids) {
      const row = rows.get(id);
      if (row !== undefined) {
        rows.set(id, {
          ...row,
          status: 'applied',
          appliedInSnapshotId: event.snapshotId,
        });
      }
    }
  }
  return Array.from(rows.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listSessionComments(
  opts: SessionChatStoreOptions,
  designId: string,
  snapshotId?: string,
): CommentRow[] {
  const entries = loadCache(opts, designId, false)?.manager.getEntries();
  if (!entries) return [];
  const rows = replayCommentEvents(designId, entries);
  return snapshotId === undefined ? rows : rows.filter((row) => row.snapshotId === snapshotId);
}

export function listPendingSessionCommentEdits(
  opts: SessionChatStoreOptions,
  designId: string,
): CommentRow[] {
  return listSessionComments(opts, designId).filter(
    (row) => row.kind === 'edit' && row.status === 'pending',
  );
}

function appendCommentEvent(
  opts: SessionChatStoreOptions,
  designId: string,
  event: StoredCommentEvent,
): void {
  const entry = commitOnCache(openCache(opts, designId), COMMENT_CUSTOM_TYPE, event);
  touchDesignActivity(opts.db, designId, entry.timestamp ?? new Date().toISOString());
}

export function appendSessionComment(
  opts: SessionChatStoreOptions,
  input: CommentCreateInput,
): CommentRow {
  const createdAt = new Date().toISOString();
  const row = CommentRowV1.parse({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    designId: input.designId,
    snapshotId: input.snapshotId,
    kind: input.kind,
    selector: input.selector,
    tag: input.tag,
    outerHTML: input.outerHTML,
    rect: input.rect,
    text: input.text,
    status: 'pending',
    createdAt,
    appliedInSnapshotId: null,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.parentOuterHTML !== undefined ? { parentOuterHTML: input.parentOuterHTML } : {}),
    ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
  });
  appendCommentEvent(opts, input.designId, {
    schemaVersion: 1,
    action: 'add',
    row,
  });
  return row;
}

export function updateSessionComment(
  opts: SessionChatStoreOptions,
  designId: string,
  id: string,
  patch: CommentUpdateInput,
): CommentRow | null {
  const existing = listSessionComments(opts, designId).find((row) => row.id === id);
  if (existing === undefined) return null;
  const nextPatch: StoredCommentPatch =
    existing.kind === 'edit' && patch.text !== undefined && patch.text !== existing.text
      ? { ...patch, status: 'pending', appliedInSnapshotId: null }
      : patch;
  appendCommentEvent(opts, designId, { schemaVersion: 1, action: 'update', id, patch: nextPatch });
  return { ...existing, ...nextPatch };
}

export function removeSessionComment(
  opts: SessionChatStoreOptions,
  designId: string,
  id: string,
): boolean {
  const exists = listSessionComments(opts, designId).some((row) => row.id === id);
  if (!exists) return false;
  appendCommentEvent(opts, designId, { schemaVersion: 1, action: 'remove', id });
  return true;
}

export function markSessionCommentsApplied(
  opts: SessionChatStoreOptions,
  designId: string,
  ids: string[],
  snapshotId: string,
): CommentRow[] {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return [];
  const rows = listSessionComments(opts, designId);
  const existingIds = new Set(rows.map((row) => row.id));
  const presentIds = uniqueIds.filter((id) => existingIds.has(id));
  if (presentIds.length === 0) return [];
  appendCommentEvent(opts, designId, {
    schemaVersion: 1,
    action: 'mark-applied',
    ids: presentIds,
    snapshotId,
  });
  return listSessionComments(opts, designId).filter((row) => presentIds.includes(row.id));
}

export function markSessionCommentsAppliedIfUnchanged(
  opts: SessionChatStoreOptions,
  designId: string,
  ids: string[],
  snapshotId: string,
  expectedContent: CommentContentExpectations,
): CommentApplyResultV1 {
  const rows = new Map(listSessionComments(opts, designId).map((row) => [row.id, row]));
  const matched: string[] = [];
  const conflictedIds: string[] = [];
  for (const id of new Set(ids)) {
    const row = rows.get(id);
    if (
      row?.kind === 'edit' &&
      row.status === 'pending' &&
      expectedContent[id] === commentContentFingerprint(row)
    ) {
      matched.push(id);
    } else {
      conflictedIds.push(id);
    }
  }
  // The comparison and append are synchronous on the main-process event loop.
  return {
    schemaVersion: 1,
    applied: markSessionCommentsApplied(opts, designId, matched, snapshotId),
    conflictedIds,
  };
}
export function appendSessionChatMessage(
  opts: SessionChatStoreOptions,
  input: ChatAppendInput,
  options: AppendSessionChatMessageOptions = {},
): ChatMessageRow {
  const cache = openCache(opts, input.designId);
  const seq = cache.projection.rows.length;
  const stored: StoredChatMessage = {
    schemaVersion: 1,
    id: seq,
    seq,
    kind: input.kind,
    payload: input.payload ?? {},
    snapshotId: input.snapshotId ?? null,
  };
  const entry = commitOnCache(cache, CHAT_MESSAGE_CUSTOM_TYPE, stored);
  const index = cache.projection.rowIndexBySeq.get(seq);
  const row = index === undefined ? undefined : cache.projection.rows[index];
  if (!row) throw new CodesignError('Stored chat row missing after append', 'IPC_DB_ERROR');
  if (options.touchActivity !== false) {
    touchDesignActivity(opts.db, input.designId, entry.timestamp ?? row.createdAt);
  }
  return { ...row };
}

export function appendSessionToolStatus(
  opts: SessionChatStoreOptions,
  input: ChatToolStatusUpdate,
): void {
  const cache = loadCache(opts, input.designId, false);
  const index = cache?.projection.rowIndexBySeq.get(input.seq);
  const row = index === undefined ? undefined : cache?.projection.rows[index];
  if (!cache || row?.kind !== 'tool_call') return;
  const toolName =
    typeof (row.payload as { toolName?: unknown } | null)?.toolName === 'string'
      ? ((row.payload as { toolName: string }).toolName ?? 'unknown')
      : 'unknown';
  const stored: StoredToolStatusUpdate = {
    schemaVersion: 1,
    seq: input.seq,
    status: input.status,
    ...(input.result !== undefined
      ? { result: compactToolResultForHistory(toolName, input.result) }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    ...(input.runResultEventKey !== undefined
      ? { runResultEventKey: input.runResultEventKey }
      : {}),
  };
  const entry = commitOnCache(cache, CHAT_TOOL_STATUS_CUSTOM_TYPE, stored);
  touchDesignActivity(opts.db, input.designId, entry.timestamp ?? new Date().toISOString());
}

export function readSessionDesignBrief(
  opts: SessionChatStoreOptions,
  designId: string,
): DesignSessionBriefV1 | null {
  const entries = loadCache(opts, designId, false)?.manager.getEntries();
  if (!entries) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as CustomEntryLike | undefined;
    if (entry?.type !== 'custom' || entry.customType !== CONTEXT_BRIEF_CUSTOM_TYPE) continue;
    const stored = parseStoredBrief(entry.data);
    if (stored !== null) return stored.brief;
  }
  return null;
}

export function appendSessionDesignBrief(
  opts: SessionChatStoreOptions,
  designId: string,
  brief: DesignSessionBriefV1,
): void {
  commitOnCache(openCache(opts, designId), CONTEXT_BRIEF_CUSTOM_TYPE, {
    schemaVersion: 1,
    brief,
  } satisfies StoredDesignBrief);
}

export function readSessionRunPreferences(
  opts: SessionChatStoreOptions,
  designId: string,
): DesignRunPreferencesV1 | null {
  const entries = loadCache(opts, designId, false)?.manager.getEntries();
  if (!entries) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as CustomEntryLike | undefined;
    if (entry?.type !== 'custom' || entry.customType !== RUN_PREFERENCES_CUSTOM_TYPE) continue;
    const stored = parseStoredRunPreferences(entry.data);
    if (stored !== null) return stored.preferences;
  }
  return null;
}

export function appendSessionRunPreferences(
  opts: SessionChatStoreOptions,
  designId: string,
  preferences: DesignRunPreferencesV1,
): void {
  const parsed = DesignRunPreferencesV1Schema.parse(preferences);
  commitOnCache(openCache(opts, designId), RUN_PREFERENCES_CUSTOM_TYPE, {
    schemaVersion: 1,
    preferences: parsed,
  } satisfies StoredRunPreferences);
}

export function seedSessionChatFromSnapshots(
  opts: SessionChatStoreOptions,
  designId: string,
): number {
  if (listSessionChatMessages(opts, designId).length > 0) return 0;

  const snapshots = listSnapshots(opts.db, designId).slice().reverse();
  let inserted = 0;
  for (const snapshot of snapshots) {
    if (typeof snapshot.prompt === 'string' && snapshot.prompt.trim().length > 0) {
      appendSessionChatMessage(
        opts,
        {
          designId,
          kind: 'user',
          payload: { text: snapshot.prompt },
        },
        { touchActivity: false },
      );
      inserted += 1;
    }
    appendSessionChatMessage(
      opts,
      {
        designId,
        kind: 'artifact_delivered',
        payload: { createdAt: snapshot.createdAt },
        snapshotId: snapshot.id,
      },
      { touchActivity: false },
    );
    inserted += 1;
  }
  return inserted;
}
