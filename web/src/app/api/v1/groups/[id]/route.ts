import { agentId } from '../../../../../core/validation.ts';
import { parseGroupSelection } from '../../../../../core/implementation-validation.ts';
import { endpoint, jsonBody } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => { controller().removeGroup(agentId((await context.params).id)); return { ok: true }; });
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => controller().selectGroup(agentId((await context.params).id), parseGroupSelection(await jsonBody(request))));
}
