// Fetch wrapper: JSON or FormData bodies, typed errors carrying the HTTP status.
export class ApiError extends Error {
  constructor(status, message, scope) {
    super(message);
    this.status = status;
    this.scope = scope;
  }
}

async function request(path, { method = 'GET', body, headers = {}, scope = 'staff', signal } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error. Check your connection and try again.', scope);
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, scope);
  return data;
}

/** Staff API (session cookie). */
export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body: body ?? {} }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: body ?? {} }),
};

/** Nurse portal API: the personal link token in the path identifies the nurse. */
export function regApi(t) {
  const base = `/api/public/reg/${encodeURIComponent(t)}`;
  return {
    get: path => request(base + path, { scope: 'reg' }),
    post: (path, body) => request(base + path, { method: 'POST', body: body ?? {}, scope: 'reg' }),
  };
}

export const qs = params => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return s ? '?' + s : '';
};
