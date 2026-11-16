import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Design, WorkspaceMode } from '@open-codesign/shared';
import { type BrowserWindow, dialog, shell } from 'electron';
import { getLogger } from './logger';
import {
  clearDesignWorkspace,
  type Database,
  getDesign,
  listDesigns,
  updateDesignWorkspace,
} from './snapshots-db';
import { normalizeWorkspacePath } from './workspace-path';
import { listWorkspaceFilesAt, resolveSafeWorkspaceChildPath } from './workspace-reader';

export { normalizeWorkspacePath } from './workspace-path';

const logger = getLogger('design-workspace');

function workspacePathComparisonKey(p: string): string {
  const normalized = normalizeWorkspacePath(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function pickWorkspaceFolder(win: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

/**
 * How long `snapshots:v1:workspace:open` waits for an opener that has not
 * started. Electron's Linux `shell.openPath` can stay pending forever.
 */
export const OPEN_WORKSPACE_FOLDER_TIMEOUT_MS = 10_000;

/** After xdg-open starts, how long to wait for a fast failure before replying. */
export const XDG_OPEN_HANDOFF_MS = 1_000;

const OPEN_WORKSPACE_UNRESPONSIVE =
  'The system file manager did not respond. The folder may still open in the background.';

const XDG_OPEN_ERRORS: Readonly<Record<number, string>> = {
  1: 'Error in command line syntax',
  2: 'The item does not exist',
  3: 'A required tool could not be found',
  4: 'The action failed',
};

export async function openWorkspaceFolder(folderPath: string): Promise<void> {
  // Electron 41's Linux shell.openPath never settles. platform_util launches
  // xdg-open with wait_for_exit=false and drops the native callback, and the
  // XDG activation run loop can also block the main thread. Awaiting that
  // promise inside snapshots:v1:workspace:open leaves the invoke reply unsent
  // ("reply was never sent"). Launch xdg-open ourselves so this call always
  // settles. Other platforms still use shell.openPath, with a timeout so a
  // stuck opener cannot hold the channel.
  const error =
    process.platform === 'linux'
      ? await openLinuxFolder(folderPath)
      : await openPathWithTimeout(folderPath);
  if (error.length > 0) {
    throw new Error(`Failed to open workspace folder: ${error}`);
  }
}

function openPathWithTimeout(folderPath: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('workspace.open.timeout', { platform: process.platform });
      resolve(OPEN_WORKSPACE_UNRESPONSIVE);
    }, OPEN_WORKSPACE_FOLDER_TIMEOUT_MS);
  });
  return Promise.race([shell.openPath(folderPath), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function xdgOpenFailure(code: number | null): string {
  if (code === null) return 'xdg-open was terminated before it finished';
  const known = XDG_OPEN_ERRORS[code];
  if (known !== undefined) return known;
  return `xdg-open exited with code ${code}`;
}

function openLinuxFolder(folderPath: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(message);
    };

    let child: ChildProcess;
    try {
      child = spawn('xdg-open', [folderPath], { detached: true, stdio: 'ignore' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to launch xdg-open';
      logger.warn('workspace.open.spawn_failed', { message });
      finish(message);
      return;
    }
    child.unref();

    timer = setTimeout(() => {
      logger.warn('workspace.open.timeout', { platform: 'linux' });
      finish(OPEN_WORKSPACE_UNRESPONSIVE);
    }, OPEN_WORKSPACE_FOLDER_TIMEOUT_MS);

    child.once('spawn', () => {
      if (settled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        // Some file managers keep xdg-open alive after the folder is shown.
        // The process started, so the IPC handler must reply instead of waiting
        // for an exit that may never come.
        logger.info('workspace.open.handed_off', { platform: 'linux' });
        finish('');
      }, XDG_OPEN_HANDOFF_MS);
    });
    child.once('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      const message =
        code === 'ENOENT'
          ? 'xdg-open was not found. Install xdg-utils or a file manager and try again.'
          : err.message;
      logger.warn('workspace.open.spawn_failed', { message });
      finish(message);
    });
    child.once('exit', (code) => {
      if (code === 0) {
        finish('');
        return;
      }
      const message = xdgOpenFailure(code);
      logger.warn('workspace.open.failed', { code, message });
      finish(message);
    });
  });
}

export function checkWorkspaceConflict(
  db: Database,
  designId: string,
  normalizedPath: string,
): boolean {
  return findWorkspaceConflict(db, designId, normalizedPath) !== null;
}

export function findWorkspaceConflict(
  db: Database,
  designId: string,
  normalizedPath: string,
): Design | null {
  const comparisonPath = workspacePathComparisonKey(normalizedPath);
  return (
    listDesigns(db).find(
      (design) =>
        design.id !== designId &&
        design.workspacePath !== null &&
        workspacePathComparisonKey(design.workspacePath) === comparisonPath,
    ) ?? null
  );
}

function workspaceConflictMessage(conflict: Design): string {
  return [
    `Workspace path is already bound to another design ("${conflict.name}").`,
    'Choose a different folder, or open that design and change its workspace before reusing this folder.',
  ].join(' ');
}

export async function migrateWorkspaceFiles(
  db: Database,
  designId: string,
  destPath: string,
): Promise<void> {
  const design = getDesign(db, designId);
  if (design === null) {
    throw new Error(`Design not found: ${designId}`);
  }
  if (design.workspacePath === null) {
    throw new Error('Cannot migrate workspace files without an existing workspace path');
  }
  const sourceRoot = normalizeWorkspacePath(design.workspacePath);
  const destinationRoot = normalizeWorkspacePath(destPath);

  await copyTrackedWorkspaceFiles(db, designId, sourceRoot, destinationRoot);
}

export async function copyTrackedWorkspaceFiles(
  _db: Database,
  _designId: string,
  sourceRoot: string,
  destPath: string,
): Promise<void> {
  const source = normalizeWorkspacePath(sourceRoot);
  const destinationRoot = normalizeWorkspacePath(destPath);
  const trackedFiles = await listWorkspaceFilesAt(source);
  const pendingCopies = await Promise.all(
    trackedFiles.map(async (file) => ({
      source: await resolveSafeWorkspaceChildPath(source, file.path),
      destination: await resolveSafeWorkspaceChildPath(destinationRoot, file.path),
      relativePath: file.path,
    })),
  );

  for (const copyOp of pendingCopies) {
    if (existsSync(copyOp.destination)) {
      throw new Error(`Workspace migration collision: ${copyOp.relativePath}`);
    }
    if (!existsSync(copyOp.source)) {
      throw new Error(`Workspace file missing: ${copyOp.relativePath}`);
    }
  }

  for (const copyOp of pendingCopies) {
    await mkdir(path.dirname(copyOp.destination), { recursive: true });
    await copyFile(copyOp.source, copyOp.destination);
  }
}

function requireDesign(db: Database, designId: string): Design {
  const design = getDesign(db, designId);
  if (design === null) {
    throw new Error(`Design not found: ${designId}`);
  }
  return design;
}

async function assertExistingWorkspaceDirectory(workspacePath: string): Promise<void> {
  const entry = await stat(workspacePath);
  if (!entry.isDirectory()) {
    throw new Error('Workspace path is not a directory');
  }
}

export function checkWorkspaceFolderExists(p: string): boolean {
  return existsSync(p);
}

export async function bindWorkspace(
  db: Database,
  designId: string,
  workspacePath: string | null,
  migrateFiles: boolean,
  workspaceMode?: WorkspaceMode,
): Promise<Design> {
  const current = requireDesign(db, designId);

  if (workspacePath === null) {
    logger.info('workspace.clear.start', { designId });
    const cleared = clearDesignWorkspace(db, designId);
    if (cleared === null) {
      throw new Error(`Design not found: ${designId}`);
    }
    logger.info('workspace.clear.done', { designId });
    return cleared;
  }

  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const comparisonPath = workspacePathComparisonKey(normalizedPath);
  if (
    current.workspacePath !== null &&
    workspacePathComparisonKey(current.workspacePath) === comparisonPath
  ) {
    logger.info('workspace.bind.noop', { designId, workspacePath: normalizedPath });
    return current;
  }
  const conflict = findWorkspaceConflict(db, designId, normalizedPath);
  if (conflict !== null) {
    throw new Error(workspaceConflictMessage(conflict));
  }
  await assertExistingWorkspaceDirectory(normalizedPath);

  logger.info('workspace.bind.start', {
    designId,
    workspacePath: normalizedPath,
    migrateFiles,
  });

  if (migrateFiles) {
    await migrateWorkspaceFiles(db, designId, normalizedPath);
  }

  const updated = updateDesignWorkspace(db, designId, normalizedPath, workspaceMode);
  if (updated === null) {
    throw new Error(`Design not found: ${designId}`);
  }

  logger.info('workspace.bind.done', {
    designId,
    workspacePath: normalizedPath,
    migrateFiles,
  });
  return updated;
}
