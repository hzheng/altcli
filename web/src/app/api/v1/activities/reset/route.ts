import { parseActivityReset } from '@/core/workflow-validation';
import { endpoint, jsonBody } from '@/server/http';
import { controller } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return endpoint(request, async () => controller().resetActivity(parseActivityReset(await jsonBody(request)))); }
