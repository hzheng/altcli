import type { ApiError } from "../contracts/api";
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(token: string, path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const response = await fetch(`/api/v1/${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), cache: "no-store", signal: init.signal });
  const data: unknown = await response.json();
  if (!response.ok) throw new HttpError((data as ApiError).error?.message ?? "Request failed.", response.status);
  return data as T;
}
