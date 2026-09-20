import { endpoint } from "@/server/http";
import { controller } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return endpoint(request, () => controller().workspaces()); }
