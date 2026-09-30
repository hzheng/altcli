import { endpoint } from '../../../../server/http.ts';
import { controller } from '../../../../server/runtime.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One raw PNG or JPEG body with x-altcli-upload metadata. endpoint() authenticates before any byte is read or file allocated. */
export async function POST(request: Request) { return endpoint(request, () => controller().attachments.upload(request)); }
