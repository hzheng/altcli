import { parseCommand } from "@/core/validation";
import { endpoint, jsonBody } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return endpoint(request, async () => controller().submit(parseCommand(await jsonBody(request)))); }
