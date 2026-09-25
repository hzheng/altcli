import { endpoint, jsonBody } from '../../../../server/http.ts';
import { controller } from '../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** POST keeps host paths out of URLs and access logs; the listing is read-only. */
export async function POST(request: Request) { return endpoint(request, async () => controller().directories(await jsonBody(request))); }
