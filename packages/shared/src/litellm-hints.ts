/**
 * LiteLLM Gateway connection failures get their own hints. The saved provider
 * is still a normal OpenAI-compatible entry, so identity comes from the preset
 * id, a name/id that says LiteLLM, or the preset's default loopback port.
 * Port 4000 still counts when the display name changed, and when a 404 is just
 * a missing /v1 on that same proxy.
 */

export const LITELLM_CONNECTION_HINT_KEYS = {
  auth: 'settings.providers.litellm.diagnostics.auth',
  notFound: 'settings.providers.litellm.diagnostics.notFound',
  unreachable: 'settings.providers.litellm.diagnostics.unreachable',
} as const;

export interface LiteLlmTargetInput {
  presetId?: string | undefined;
  providerId?: string | undefined;
  name?: string | undefined;
  baseUrl?: string | undefined;
}

const LITELLM_PRESET_PORT = '4000';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLiteLlmConnectionTarget(input: LiteLlmTargetInput): boolean {
  if (input.presetId === 'litellm') return true;
  const label = `${input.name ?? ''} ${input.providerId ?? ''}`.toLowerCase();
  if (label.includes('litellm')) return true;
  return isLiteLlmDefaultPort(input.baseUrl);
}

export function liteLlmEndpointPreset(input: LiteLlmTargetInput): { presetId?: 'litellm' } {
  return isLiteLlmConnectionTarget(input) ? { presetId: 'litellm' } : {};
}

export function liteLlmHintKeyForHttpStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return LITELLM_CONNECTION_HINT_KEYS.auth;
  if (status === 404) return LITELLM_CONNECTION_HINT_KEYS.notFound;
  return undefined;
}

export function liteLlmHintKeyForTransportError(err: unknown): string | undefined {
  return transportSignals(err).includes('ECONNREFUSED')
    ? LITELLM_CONNECTION_HINT_KEYS.unreachable
    : undefined;
}

function isLiteLlmDefaultPort(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return false;
  const port = url.port.length > 0 ? url.port : url.protocol === 'https:' ? '443' : '80';
  return port === LITELLM_PRESET_PORT;
}

function transportSignals(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value == null || seen.has(value)) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const record = value as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof record.code === 'string') parts.push(record.code);
    if (typeof record.message === 'string') parts.push(record.message);
    visit(record.cause);
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) visit(item);
    }
  };
  visit(err);
  return parts.join(' ');
}
