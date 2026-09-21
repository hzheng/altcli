import { AppError } from '../../../../../core/errors.ts';
import { endpoint } from '../../../../../server/http.ts';
import { controller } from '../../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return endpoint(request, () => {
    const repository = new URL(request.url).searchParams.get('repository');
    if (repository !== null && (!repository.startsWith('/') || repository.length > 4096)) throw new AppError('INVALID_REPOSITORY', 'repository must be an absolute worktree root.');
    return controller().exportHistory(repository ?? undefined);
  });
}
