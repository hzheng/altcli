import { endpoint, jsonBody } from '../../../../../../server/http.ts';
import { controller } from '../../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, c: {params:Promise<{id:string}>}) { return endpoint(request, async () => controller().launches.reconcile((await c.params).id, await jsonBody(request))); }
