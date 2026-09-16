import { parseEvent } from "@/core/validation";
import { endpoint, jsonBody } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Called by the CLIs' own hooks on this host (hooks/codercrew-turn-complete.sh). Same bearer token as everything else. */
export async function POST(request: Request) { return endpoint(request, async () => controller().recordEvent(parseEvent(await jsonBody(request)))); }
