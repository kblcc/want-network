// Buyer finishes a paid job:
//   action "complete" -> complete the WANT and pay the provider (minus WANT's fee)
//   action "cancel"   -> refund the buyer and cancel (only before the job started)
import { stripe } from "../_shared/stripe.ts";
import { HttpError, json, requireUser, rpc, serve } from "../_shared/http.ts";
import { sendPayout } from "../_shared/payouts.ts";

export const handle = serve(async (req) => {
  const user = await requireUser(req);
  const { intent_id, action } = await req.json().catch(() => ({}));
  if (!intent_id) throw new HttpError("Missing intent_id");

  if (action === "complete") {
    const r = await rpc<{ payment_id: string; transfer_cents: number; currency: string; charge_id: string | null; intent_id: string; destination: string | null }>(
      "internal_complete_paid_job", { p_intent_id: intent_id, p_buyer_id: user.id });
    if (!r.destination) return json({ completed: true, released: false, note: "Payout will be sent when the provider finishes setting up payouts." });
    try {
      await sendPayout(r, r.destination);
      return json({ completed: true, released: true });
    } catch (e) {
      console.error("payout failed, will retry when provider refreshes payouts", e);
      return json({ completed: true, released: false, note: "Job completed. The payout will be retried." });
    }
  }

  if (action === "cancel") {
    const r = await rpc<{ payment_id: string; payment_intent: string; amount_cents: number }>(
      "internal_check_refundable", { p_intent_id: intent_id, p_buyer_id: user.id });
    const refund = await stripe("refunds", { payment_intent: r.payment_intent, reason: "requested_by_customer" },
      { idempotencyKey: `refund-${r.payment_id}` });
    await rpc("internal_record_refund", { p_payment_id: r.payment_id, p_refund_id: refund.id, p_cancel: true });
    return json({ cancelled: true, refunded_cents: r.amount_cents });
  }

  throw new HttpError("Unknown action");
});
