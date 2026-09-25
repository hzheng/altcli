import { endpoint, jsonBody } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, c: Context) { return endpoint(request, async () => controller().launches.profile(await jsonBody(request), (await c.params).id)); }
export async function DELETE(request: Request, c: Context) { return endpoint(request, async () => ({removed: await controller().launches.profile(await jsonBody(request), (await c.params).id, true) === null})); }
