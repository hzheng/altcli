import { endpoint, jsonBody } from '../../../../../../server/http.ts';
import { controller } from '../../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => { const { id } = await context.params; return await controller().terminals.input(id, await jsonBody(request)) ?? { ok: true }; });
}
