import { endpoint } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
/** Removes an unreferenced draft upload; possible use is recorded server-side and refuses. */
export async function DELETE(request: Request, c: Context) { return endpoint(request, async () => controller().attachments.remove((await c.params).id)); }
