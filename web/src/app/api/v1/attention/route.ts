import { AppError } from '../../../../core/errors.ts';
import { endpoint, jsonBody } from '../../../../server/http.ts';
import { controller } from '../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return endpoint(request, () => {
    const params = new URL(request.url).searchParams, status = params.get('status') ?? 'open';
    if (status !== 'open' && status !== 'resolved') throw new AppError('INVALID_INPUT', 'Choose status open or resolved.');
    return controller().attention.page(status, params.get('cursor'));
  });
}
export async function POST(request: Request) { return endpoint(request, async () => controller().attention.markSeen(await jsonBody(request))); }
