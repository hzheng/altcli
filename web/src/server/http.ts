import { AppError } from "../core/errors.ts";
import { authorize } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { terminalHost } from './terminal-gateway.ts';
import { withBackgroundAuthorization } from './background/action-context.ts';
export async function jsonBody(request: Request, allowEmpty = false): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AppError("CONTENT_TYPE", "Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) { if (allowEmpty) return null; throw new AppError("INVALID_JSON", "A JSON body is required."); }
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new AppError("BODY_TOO_LARGE", "Request exceeds 16 KiB.", 413); }
      chunks.push(value);
    }
    return allowEmpty && bytes === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_JSON", "Invalid JSON body.");
  } finally { reader.releaseLock(); }
}
export async function endpoint(request: Request, handler: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const config = loadConfig();
    authorize(request, config.token, config.allowedOrigins);
    const actionToken = request.headers.get('x-altcli-background-action');
    if (actionToken) {
      const consume = terminalHost().consumeBackgroundAction;
      if (!consume) throw new AppError('ACTION_GRANT', 'Background action authority is unavailable.', 403);
      let authority;
      try { const url = new URL(request.url); authority = consume(actionToken, request.method, url.pathname + url.search, request.method === 'GET' ? null : await jsonBody(request.clone(), true)); }
      catch { throw new AppError('ACTION_GRANT', 'The exact Background action grant is absent, stale or already used.', 403); }
      return Response.json(await withBackgroundAuthorization(authority, handler), { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json(await handler(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof AppError;
    return Response.json({ error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Controller error. Inspect the host and reconcile terminal state before retrying." } },
      { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
