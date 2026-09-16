import { AppError } from "../core/errors.ts";
import { authorize } from "./auth.ts";
import { loadConfig } from "./config.ts";
export async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AppError("CONTENT_TYPE", "Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_JSON", "A JSON body is required.");
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_JSON", "Invalid JSON body.");
  } finally { reader.releaseLock(); }
}
export async function endpoint(request: Request, handler: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const config = loadConfig();
    authorize(request, config.token, config.allowedOrigins);
    return Response.json(await handler(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof AppError;
    return Response.json({ error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Controller error. Inspect the host and reconcile terminal state before retrying." } },
      { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
