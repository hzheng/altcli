import { endpoint, jsonBody } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
import { parseManualReconcile } from '../../../../../core/terminal-validation.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return endpoint(request, async () => { return controller().reconcileManual(parseManualReconcile(await jsonBody(request)));  }); }
