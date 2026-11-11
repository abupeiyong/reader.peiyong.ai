// 后端 API 封装。网页端同源 + cookie 会话;Hadi 小程序里是跨源 + Bearer(见 hadi.ts)。
import { IS_HADI, apiUrl, hadiSession } from "./hadi";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 所有打到本站 /api 的请求都走这里(别直接 fetch("/api/..."),小程序里那样会打到 hub 上)。
 * 小程序里补上绝对地址和会话令牌;会话过期(401)时重新换一张再试一次。
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!IS_HADI) return fetch(path, init);
  const send = async (token: string) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(apiUrl(path), { ...init, headers });
  };
  const token = await hadiSession();
  const res = await send(token);
  return res.status === 401 ? send(await hadiSession(token)) : res;
}

/**
 * <img> / <audio> 这类元素没法带 Authorization 头:小程序里先把资源取成 blob,
 * 返回 objectURL(同一路径只取一次);网页端原样返回路径,cookie 自己会带上。
 */
const blobUrls = new Map<string, Promise<string>>();
export function apiBlobUrl(path: string): Promise<string> {
  if (!IS_HADI) return Promise.resolve(path);
  let hit = blobUrls.get(path);
  if (!hit) {
    hit = apiFetch(path).then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, `请求失败 (${res.status})`);
      return URL.createObjectURL(await res.blob());
    });
    hit.catch(() => blobUrls.delete(path)); // 失败的不缓存,下次还能重试
    blobUrls.set(path, hit);
  }
  return hit;
}

/** pdf.js 的文档来源:小程序里补上绝对地址和认证头 */
export async function apiPdfSource(path: string): Promise<{ url: string; httpHeaders?: Record<string, string> }> {
  if (!IS_HADI) return { url: path };
  return { url: apiUrl(path), httpHeaders: { Authorization: `Bearer ${await hadiSession()}` } };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    // 未被接住的服务端异常走 Hono 默认处理,返回纯文本 "Internal Server Error",
    // 而 statusText 在 Workers 的响应里是空串 —— 直接拿它当消息会得到空错误,
    // 页面既不报错也不结束加载。所以依次退到响应正文、statusText、状态码。
    const body = (await res.text().catch(() => "")).trim();
    let msg = "";
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? "";
    } catch {
      msg = body.slice(0, 200);
    }
    throw new ApiError(res.status, msg || res.statusText || `请求失败 (${res.status})`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: unknown) =>
    req<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body: unknown) =>
    req<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    req<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  del: <T>(path: string) => req<T>(path, { method: "DELETE" }),
  postForm: <T>(path: string, form: FormData) => req<T>(path, { method: "POST", body: form }),
};

/** SSE 流式聊天 */
export async function streamChat(
  body: { book_id: string; page_no: number; scope: string; selection?: string; message: string },
  onDelta: (text: string) => void,
  onDone: (refs: number[]) => void,
  onError: (msg: string) => void
): Promise<void> {
  const res = await apiFetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    onError(`请求失败 (${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        const obj = JSON.parse(t.slice(5).trim()) as {
          delta?: string;
          done?: boolean;
          refs?: number[];
          error?: string;
        };
        if (obj.delta) onDelta(obj.delta);
        if (obj.done) onDone(obj.refs ?? []);
        if (obj.error) onError(obj.error);
      } catch {
        /* 忽略不完整行 */
      }
    }
  }
}
