import { backgroundCapability } from '@/server/background/http';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => backgroundCapability(request, 'runner');
