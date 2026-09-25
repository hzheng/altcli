import { endpoint, jsonBody } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return endpoint(request, async () => { const plane=controller();await plane.workspaces();return plane.launches.preview(await jsonBody(request)); }); }
