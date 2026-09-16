import { agentId } from "@/core/validation";
import { endpoint } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => { controller().removePair(agentId((await params).id)); return { removed: true }; });
}
