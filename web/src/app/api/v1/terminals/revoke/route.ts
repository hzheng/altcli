import { endpoint, jsonBody } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
import { terminalFields, terminalText } from '../../../../../core/terminal-validation.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return endpoint(request, async () => { const b = terminalFields(await jsonBody(request), ['clientInstanceId']); await controller().terminals.revoke(terminalText(b.clientInstanceId)); return { ok: true }; }); }
