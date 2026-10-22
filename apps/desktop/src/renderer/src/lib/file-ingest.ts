import type { WorkspaceImportBlobInput, WorkspaceImportFileInput } from '../../../preload';

type FileWithPath = File & { path?: string };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function dataTransferFilesToWorkspaceFiles(
  dataTransfer: DataTransfer,
): WorkspaceImportFileInput[] {
  const out: WorkspaceImportFileInput[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    const localPath = (file as FileWithPath).path;
    if (typeof localPath !== 'string' || localPath.length === 0) continue;
    out.push({ path: localPath, name: file.name, size: file.size });
  }
  return out;
}

/**
 * Clipboard screenshots on Windows Electron often expose a transient `File.path`
 * under %TEMP%. Prefer reading bytes as blobs so import lands in the workspace
 * and remote OpenServer sessions never see a host-local path (#415).
 */
export async function clipboardFilesToWorkspaceBlobs(
  dataTransfer: DataTransfer,
): Promise<{ files: WorkspaceImportFileInput[]; blobs: WorkspaceImportBlobInput[] }> {
  return filesToWorkspaceImport(Array.from(dataTransfer.files), { preferBlob: true });
}

export async function fileListToWorkspaceImport(
  fileList: FileList | readonly File[],
): Promise<{ files: WorkspaceImportFileInput[]; blobs: WorkspaceImportBlobInput[] }> {
  return filesToWorkspaceImport(Array.from(fileList));
}

async function filesToWorkspaceImport(
  sourceFiles: readonly File[],
  opts: { preferBlob?: boolean } = {},
): Promise<{ files: WorkspaceImportFileInput[]; blobs: WorkspaceImportBlobInput[] }> {
  const files: WorkspaceImportFileInput[] = [];
  const blobs: WorkspaceImportBlobInput[] = [];
  for (const file of sourceFiles) {
    const localPath = (file as FileWithPath).path;
    if (opts.preferBlob !== true && typeof localPath === 'string' && localPath.length > 0) {
      files.push({ path: localPath, name: file.name, size: file.size });
      continue;
    }
    blobs.push({
      name: file.name || 'pasted-image.png',
      mediaType: file.type || 'application/octet-stream',
      dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
    });
  }
  return { files, blobs };
}
