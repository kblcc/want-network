// Minimal Stripe REST client (no SDK). Runs only in Supabase Edge Functions;
// the secret key comes from the STRIPE_SECRET_KEY secret and never reaches the browser.

function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) out.push(...encode(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(...encode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export class StripeError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function stripe<T = any>(
  path: string,
  params: Record<string, unknown> = {},
  opts: { method?: "GET" | "POST"; idempotencyKey?: string } = {},
): Promise<T> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new StripeError("Payments are not configured yet (missing STRIPE_SECRET_KEY).", 500);
  const method = opts.method ?? "POST";
  const body = encode(params).join("&");
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && body ? `?${body}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
  const json = await res.json();
  if (!res.ok) throw new StripeError(json?.error?.message ?? `Stripe error ${res.status}`, res.status, json?.error?.code);
  return json as T;
}

const enc = new TextEncoder();
function hex(buf: ArrayBuffer) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Verifies the Stripe-Signature header (t=...,v1=...) over the raw body.
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", k, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, expected));
}
