import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '../preload/index';
import { projectRunEventToChat } from './run-event-chat';
import {
  clearSessionFileCache,
  listSessionChatMessages,
  type SessionChatStoreOptions,
  type SessionFileIoEvent,
  setSessionFileIoListener,
} from './session-chat';
import { createDesign, initSnapshotsDb, updateDesignWorkspace } from './snapshots-db';

let root: string;
let designId: string;
let opts: SessionChatStoreOptions;
const io = { opens: 0, bytesRead: 0, bytesWritten: 0 };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codesign-projection-cost-'));
  const db = initSnapshotsDb(path.join(root, 'design-store.json'));
  const design = createDesign(db, 'Projection cost');
  designId = design.id;
  updateDesignWorkspace(db, designId, root);
  opts = { db, sessionDir: db.sessionDir };
  resetIo();
  clearSessionFileCache();
  setSessionFileIoListener((event: SessionFileIoEvent) => {
    if (event.kind === 'open') {
      io.opens += 1;
      io.bytesRead += event.bytes;
      return;
    }
    io.bytesWritten += event.bytes;
  });
});

afterEach(async () => {
  setSessionFileIoListener(undefined);
  clearSessionFileCache();
  await rm(root, { recursive: true, force: true });
});

function event(seq: number, extra: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    schemaVersion: 1,
    type: 'turn_end',
    generationId: 'run-a',
    runId: 'run-a',
    designId,
    seq,
    finalText: `reply ${seq}`,
    ...extra,
  };
}

function sessionFile(): string {
  return path.join(opts.sessionDir, `${designId}.jsonl`);
}

function resetIo(): void {
  io.opens = 0;
  io.bytesRead = 0;
  io.bytesWritten = 0;
}

/** Valid custom lines the chat replay ignores. They make the session large without adding rows. */
function padSession(file: string, targetBytes: number): void {
  const blob = 'x'.repeat(8 * 1024);
  const lines: string[] = [];
  let written = 0;
  let index = 0;
  while (written < targetBytes) {
    const line = JSON.stringify({
      type: 'custom',
      customType: 'open-codesign.padding',
      data: { blob },
      id: `p${index.toString(16).padStart(7, '0')}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    lines.push(line);
    written += Buffer.byteLength(line) + 1;
    index += 1;
  }
  appendFileSync(file, `${lines.join('\n')}\n`);
}

function parseSessionOnce(file: string): number {
  const source = readFileSync(file, 'utf8');
  const started = performance.now();
  for (const line of source.split('\n')) {
    if (line.length > 0) JSON.parse(line);
  }
  return performance.now() - started;
}

describe('session projection cost', () => {
  it('opens a large session once and keeps later projections to the new row', () => {
    projectRunEventToChat(opts, event(1, { finalText: 'seed' }));
    padSession(sessionFile(), 3 * 1024 * 1024);
    clearSessionFileCache();
    resetIo();

    projectRunEventToChat(opts, event(2));
    const sessionBytes = statSync(sessionFile()).size;
    expect(sessionBytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(io.opens).toBe(1);
    expect(io.bytesRead).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(io.bytesWritten).toBeGreaterThan(0);
    expect(io.bytesWritten).toBeLessThan(8 * 1024);

    const parseOnceMs = parseSessionOnce(sessionFile());
    expect(parseOnceMs).toBeGreaterThan(1);
    resetIo();
    const writes: AgentStreamEvent[] = [];
    for (let seq = 3; seq < 23; seq += 1) writes.push(event(seq));
    let maxBlockMs = 0;
    for (const item of [...writes, ...writes]) {
      const started = performance.now();
      projectRunEventToChat(opts, item);
      maxBlockMs = Math.max(maxBlockMs, performance.now() - started);
    }

    expect(io.opens).toBe(0);
    expect(io.bytesRead).toBe(0);
    expect(io.bytesWritten).toBeGreaterThan(0);
    expect(io.bytesWritten).toBeLessThan(sessionBytes / 10);
    expect(io.bytesWritten / writes.length).toBeLessThan(2048);
    // One full parse of the padded session is the regression budget: a rewrite or reload exceeds it.
    expect(maxBlockMs).toBeLessThan(parseOnceMs);
    expect(maxBlockMs).toBeLessThan(100);

    resetIo();
    for (let index = 0; index < 8; index += 1) {
      projectRunEventToChat(
        opts,
        event(100 + index, {
          type: 'tool_call_start',
          toolCallId: `t${index}`,
          toolName: 'read',
        }),
      );
      projectRunEventToChat(
        opts,
        event(200 + index, {
          type: 'tool_call_result',
          toolCallId: `t${index}`,
          result: 'ok',
        }),
      );
    }
    expect(io.opens).toBe(0);
    expect(io.bytesRead).toBe(0);
    expect(io.bytesWritten).toBeGreaterThan(0);
    expect(io.bytesWritten).toBeLessThan(16 * 1024);
    expect(listSessionChatMessages(opts, designId)).toHaveLength(30);

    clearSessionFileCache();
    const reopened = initSnapshotsDb(path.join(root, 'design-store.json'));
    expect(
      listSessionChatMessages({ db: reopened, sessionDir: reopened.sessionDir }, designId),
    ).toEqual(listSessionChatMessages(opts, designId));
  });
});
