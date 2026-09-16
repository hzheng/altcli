import { AppError } from "@/core/errors";
import { object, requestId } from "@/core/validation";
import { endpoint, jsonBody } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return endpoint(request, async () => {
    const body = object(await jsonBody(request));
    if (body.confirmReady !== true) throw new AppError("READINESS_REQUIRED", "Inspect both agents before releasing the turn.");
    controller().store.release(requestId(body.expectedCommandId));
    return { released: true };
  });
}
