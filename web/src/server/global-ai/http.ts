import { AppError } from '../../core/errors.ts';
import { endpoint, jsonBody } from '../http.ts';
import { controller } from '../runtime.ts';
import { terminalHost } from '../terminal-gateway.ts';
import { fields, GlobalAIError, text } from './reads.ts';

const origin = () => {
  const value = terminalHost().loopbackOrigin;
  if (!value || terminalHost().closing) throw new GlobalAIError('HOST_UNAVAILABLE', 'Start AltCLI with its custom Node host before using Global AI.');
  return value;
};
export async function globalOwner(request: Request): Promise<Response> {
  return endpoint(request, async () => {
    try {
      const plane = controller(), service = plane.globalAI;
      if (!service) throw new GlobalAIError('RESTART_REQUIRED', 'Restart the host to load Global AI without replacing the live dispatcher.');
      if (request.method === 'GET') {
        const view = await service.view();
        const fallback = view.instance && view.nativeState !== 'unavailable' && view.nativeState !== 'unverified'
          ? await service.services.host.capture(view.instance).catch(() => 'Capture unavailable; inspect the original terminal.') : '';
        const roots = await service.services.roots();
        return { ...view, profiles: plane.launches.profiles(), roots: roots.slice(0, 128), rootsTruncated: roots.length > 128,
          fallback, capturedAt: new Date().toISOString(), manualHeld: plane.authority.blocked };
      }
      const value = await jsonBody(request), base = fields(value, ['action', 'profileId', 'roots', 'id', 'digest', 'requestId', 'confirm', 'instanceId', 'name', 'arguments']);
      const { action, ...body } = base;
      switch (action) {
        case 'preview': return service.preview(body, origin());
        case 'start': return service.start(body);
        case 'refresh-tools': return service.refreshTools(body, origin());
        case 'retire': return service.retire(body);
        case 'revoke': fields(body, []); service.revoke(); return { ok: true };
        case 'read': return service.ownerRead(body);
        default: throw new GlobalAIError('INVALID_ACTION', 'Unknown Global AI operation.', 400);
      }
    } catch (e) {
      if (e instanceof GlobalAIError) throw new AppError(e.code, e.message, e.status);
      throw e;
    }
  });
}
/** Distinct loopback read capability, never the owner's general token. Authorization precedes body consumption. */
export async function globalTools(request: Request): Promise<Response> {
  try {
    const expected = new URL(origin());
    if (request.headers.get('host') !== expected.host || request.headers.get('origin') !== expected.origin)
      throw new GlobalAIError('APP_ORIGIN', 'App tools require this host\'s loopback origin.', 403);
    const header = request.headers.get('authorization') ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(header)) throw new GlobalAIError('APP_ACCESS_REVOKED', 'A scoped read capability is required.', 401);
    const token = header.slice(7), service = controller().globalAI;
    service.authenticate(token);
    return Response.json(await service.tools(token, await jsonBody(request)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const known = e instanceof GlobalAIError || e instanceof AppError;
    return Response.json({ error: { code: known ? e.code : 'APP_READ_FAILED', message: known ? e.message : 'App read failed. Inspect the host; no app action was performed.' } },
      { status: known ? e.status : 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
