import { paneId } from "@/core/validation";
import { endpoint } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Query parameter rather than a path segment: pane IDs contain "%", which proxies may re-encode in paths.
export async function GET(request: Request) { return endpoint(request, () => controller().preview(paneId(new URL(request.url).searchParams.get("paneId")))); }
