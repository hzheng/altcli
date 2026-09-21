import { parseIntegrate } from '../../../../../../core/project-validation.ts';
import { endpoint, jsonBody } from '../../../../../../server/http.ts';
import { controller } from '../../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return endpoint(request, async () => controller().integrateWorktree(parseIntegrate(await jsonBody(request))));
}
