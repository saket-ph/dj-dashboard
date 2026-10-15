export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Thin fetch wrapper. Same-origin (dev proxy / production single origin) so cookies just work.
 * Network failures surface as ApiError(status 0, code 'NETWORK').
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { csrfToken?: string | null } = {},
): Promise<{ status: number; data: T }> {
  const { csrfToken, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...(headers as Record<string, string>) };
  if (rest.body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (csrfToken) finalHeaders['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...rest, headers: finalHeaders });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error.');
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body as ErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Request failed.');
  }
  return { status: res.status, data: body as T };
}
