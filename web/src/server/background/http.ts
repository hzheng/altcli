import { AppError } from '../../core/errors.ts';
import { fields, GlobalAIError } from '../global-ai/reads.ts';
import { endpoint, jsonBody } from '../http.ts';
import { controller } from '../runtime.ts';
import { terminalHost } from '../terminal-gateway.ts';

function origin() {
  const origin = terminalHost().loopbackOrigin;
  if (!origin || terminalHost().closing) throw new GlobalAIError('HOST_UNAVAILABLE', 'The Background runner requires the AltCLI Node host.');
  return origin;
}
export async function backgroundOwner(request: Request): Promise<Response> {
  return endpoint(request, async () => {
    try {
      const service = controller().background;
      if (!service) throw new GlobalAIError('RESTART_REQUIRED', 'Restart the settled host to load Background.');
      if (request.method === 'GET') return service.view();
      const { action, ...body } = fields(await jsonBody(request), ['action', 'profileId', 'id', 'digest', 'requestId', 'confirm', 'instanceId', 'attemptId']);
      if (action === 'preview') return service.preview(body, origin());
      if (action === 'enable') return service.enable(body);
      return service.control({ action, ...body }, origin());
    } catch (error) {
      if (error instanceof GlobalAIError) throw new AppError(error.code, error.message, error.status);
      throw error;
    }
  });
}
export async function backgroundActionsOwner(request: Request): Promise<Response> {
  return endpoint(request, async () => {
    try {
      const actions = controller().background.actions;
      if (request.method === 'GET') {
        const before = new URL(request.url).searchParams.get('before');
        return actions.view(before === null ? undefined : Number(before));
      }
      const { action, ...body } = fields(await jsonBody(request), ['action', 'expectedRevision', 'app', 'command', 'risk', 'confirm', 'id', 'digest', 'note']);
      if (action === 'permissions') return actions.savePermissions(body);
      return actions.decide({ action, ...body });
    } catch (error) {
      if (error instanceof GlobalAIError) throw new AppError(error.code, error.message, error.status);
      throw error;
    }
  });
}
/** Neither endpoint accepts the owner's token. Runner transport and model reads are distinct boot-local capabilities. */
export async function backgroundCapability(request: Request, kind: 'runner' | 'tools'): Promise<Response> {
  try {
    const expected = new URL(origin());
    if (request.headers.get('host') !== expected.host || request.headers.get('origin') !== expected.origin)
      throw new GlobalAIError('APP_ORIGIN', 'Background requires this host’s loopback origin.', 403);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new GlobalAIError('BACKGROUND_REVOKED', 'A scoped capability is required.', 401);
    const service = controller().background, token = authorization.slice(7);
    service.authenticate(token, kind);
    const body = await jsonBody(request);
    return Response.json(await (kind === 'runner' ? service.runner(token, body) : service.tools(token, body)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const known = error instanceof GlobalAIError || error instanceof AppError;
    return Response.json({ error: { code: known ? error.code : 'BACKGROUND_FAILED', message: known ? error.message : 'Background operation failed. Inspect its recorded state.' } },
      { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
