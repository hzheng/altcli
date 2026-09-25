import { endpoint } from '../../../../../../server/http.ts';
import { controller } from '../../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, c: {params:Promise<{id:string}>}) { return endpoint(request, async () => controller().launches.capture((await c.params).id)); }
