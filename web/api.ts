// Thin typed client over the human web API (cookie session) + Google sign-in. All requests use
// credentials:"include" so the httpOnly session cookie rides along.

export interface StickyMeta {
  id: string;
  position: number;
  char_count: number;
  is_shared: boolean;
  title: string;
}
export interface StickyFull {
  id: string;
  text: string;
  version: number;
  char_count: number;
  is_shared: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (res.status === 401) throw new ApiError("unauthorized", 401);
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new ApiError(`request failed (${res.status})`, res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export const api = {
  // Exchange a Google ID-token credential (+ optional pre-auth draft) for a session cookie.
  signIn: (credential: string, draft?: string) =>
    req<{ ok: boolean; created: boolean }>("/auth/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential, draft }),
    }),

  listStickies: () => req<{ stickies: StickyMeta[] }>("/api/stickies"),

  getSticky: (id: string) => req<StickyFull>(`/api/stickies/${id}`),

  saveSticky: (id: string, text: string, version: number) =>
    req<StickyFull>(`/api/stickies/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, version }),
    }),

  createSticky: () => req<{ id: string; version: number }>("/api/stickies", { method: "POST" }),

  setShared: (id: string) =>
    req<{ id: string; is_shared: boolean }>(`/api/stickies/${id}/share`, { method: "POST" }),

  undo: () => req<StickyFull>("/api/stickies/undo", { method: "POST" }),

  connectorToken: () => req<{ token: string }>("/api/connector-token", { method: "POST" }),

  logout: () => req<{ ok: boolean }>("/api/logout", { method: "POST" }),
};
