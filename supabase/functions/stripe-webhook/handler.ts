// Stripe tells us a checkout was paid. Verified with the webhook signing secret.
import { stripe, verifyStripeSignature } from "../_shared/stripe.ts";
import { json, rpc } from "../_shared/http.ts";

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook not configured" }, 500);
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret))) {
    return json({ error: "Invalid signature" }, 400);
  }
  const event = JSON.parse(payload);

  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const s = event.data.object;
      if (s.payment_status !== "paid") return json({ received: true, note: "not paid yet" });
      const pi = await stripe(`payment_intents/${s.payment_intent}`, { expand: ["latest_charge"] }, { method: "GET" });
      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
      const r = await rpc<{ ok: boolean; needs_refund?: boolean; payment_id?: string; payment_intent?: string; reason?: string }>(
        "internal_mark_paid", { p_session_id: s.id, p_payment_intent: s.payment_intent, p_charge: chargeId ?? null, p_amount_cents: s.amount_total });
      if (r.needs_refund) {
        const refund = await stripe("refunds", { payment_intent: s.payment_intent, reason: "requested_by_customer" },
          { idempotencyKey: `auto-refund-${s.id}` });
        if (r.payment_id) await rpc("internal_record_refund", { p_payment_id: r.payment_id, p_refund_id: refund.id, p_cancel: false });
        return json({ received: true, refunded: true, reason: r.reason ?? "want no longer active" });
      }
      return json({ received: true, ...r });
    }
    return json({ received: true, ignored: event.type });
  } catch (e) {
    console.error(e);
    // 500 makes Stripe retry later.
    return json({ error: (e as Error).message }, 500);
  }
}
