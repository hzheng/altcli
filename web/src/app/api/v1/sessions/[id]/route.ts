import { agentId, parseRenameSession } from "@/core/validation";
import { endpoint, jsonBody } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => { controller().remove(agentId((await params).id)); return { removed: true }; });
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => controller().rename(agentId((await params).id), parseRenameSession(await jsonBody(request))));
}
