import { endpoint, jsonBody } from '../../../../server/http.ts';
import { controller } from '../../../../server/runtime.ts';
import { terminalHost } from '../../../../server/terminal-gateway.ts';
import { AppError } from '../../../../core/errors.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return endpoint(request, async () => {
    if (!terminalHost().active || terminalHost().closing) throw new AppError('TERMINAL_HOST', 'Start AltCLI with its configured host command before opening terminals.', 503);
    return controller().terminals.open(await jsonBody(request));
  });
}
