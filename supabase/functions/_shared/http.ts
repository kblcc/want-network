import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export class HttpError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Service-role client: bypasses RLS; only used server side.
export function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The signed-in user making the request (from their Supabase session token).
export async function requireUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError("Please sign in.", 401);
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data?.user) throw new HttpError("Please sign in again.", 401);
  return data.user;
}

// Where Stripe should send people back to: the site they came from, if it's
// one of ours (production, Vercel previews, local dev); otherwise APP_URL.
export function appOrigin(req: Request) {
  const fallback = Deno.env.get("APP_URL") ?? "https://want-network.vercel.app";
  const origin = req.headers.get("origin") ?? "";
  const allowed = [
    /^https:\/\/want-network(-[a-z0-9-]+)?\.vercel\.app$/,
    /^http:\/\/localhost:\d+$/,
  ];
  const extra = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.some((re) => re.test(origin)) || extra.includes(origin) ? origin : fallback;
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new HttpError(error.message, 400);
  return data as T;
}

export function serve(handler: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      return await handler(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as { status?: number })?.status && (e as { status: number }).status < 500 ? 400 : 500;
      console.error(e);
      return json({ error: (e as Error).message ?? "Something went wrong" }, status);
    }
  };
}
