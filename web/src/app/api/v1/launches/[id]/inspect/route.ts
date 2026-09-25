import { endpoint } from '../../../../../../server/http.ts';
import { controller } from '../../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, c: {params:Promise<{id:string}>}) { return endpoint(request, async () => controller().launches.inspect((await c.params).id)); }
