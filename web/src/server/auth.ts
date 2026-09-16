import { timingSafeEqual } from "node:crypto";
import { AppError } from "../core/errors.ts";
export function authorize(request: Request, token: string, allowedOrigins: string[]): void {
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  if (!token || expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new AppError("UNAUTHORIZED", "Enter the host's CoderCrew access token.", 401);
  }
  // Do not trust Forwarded or X-Forwarded-Host to add origins dynamically.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!allowedOrigins.some((origin) => new URL(origin).host === host)) throw new AppError("HOST_DENIED", "Host is not in CODERCREW_ALLOWED_ORIGINS.", 403);
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.includes(origin)) throw new AppError("ORIGIN_DENIED", "Origin is not allowed.", 403);
  // Native clients may omit Origin. Every client still needs a non-cookie bearer token.
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("ORIGIN_DENIED", "Cross-site browser requests are not allowed.", 403);
}
