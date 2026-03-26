const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

let token: string | null = localStorage.getItem('gridwatch_token');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('gridwatch_token', t);
  else localStorage.removeItem('gridwatch_token');
}

export function getToken(): string | null {
  return token;
}

export function getWsUrl(): string {
  return API_URL.replace(/^http/, 'ws') + '/ws?token=' + token;
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 401) {
      setToken(null);
      window.location.href = '/login';
    }
    throw new Error(data?.error?.message || `Request failed: ${res.status}`);
  }

  return data;
}

export const api = {
  get: <T = unknown>(path: string) => request<T>('GET', path),
  post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, body),
};
