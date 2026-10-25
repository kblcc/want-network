// Buyer pays for an accepted offer: creates a Stripe Checkout page.
import { stripe } from "../_shared/stripe.ts";
import { appOrigin, HttpError, json, requireUser, rpc, serve } from "../_shared/http.ts";

export const handle = serve(async (req) => {
  const user = await requireUser(req);
  const { intent_id } = await req.json().catch(() => ({}));
  if (!intent_id) throw new HttpError("Missing intent_id");

  const p = await rpc<{ payment_id: string; amount_cents: number; fee_cents: number; currency: string; description: string }>(
    "internal_prepare_payment", { p_intent_id: intent_id, p_buyer_id: user.id });

  const origin = appOrigin(req);
  const session = await stripe("checkout/sessions", {
    mode: "payment",
    success_url: `${origin}/?payment=success&intent=${intent_id}`,
    cancel_url: `${origin}/?payment=cancelled&intent=${intent_id}`,
    client_reference_id: p.payment_id,
    customer_email: user.email ?? undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: p.currency,
        unit_amount: p.amount_cents,
        product_data: { name: "WANT job", description: p.description || "Service booked through WANT" },
      },
    }],
    payment_intent_data: {
      transfer_group: intent_id,
      description: `WANT job ${intent_id}`,
      metadata: { intent_id, payment_id: p.payment_id },
    },
    metadata: { intent_id, payment_id: p.payment_id },
  });

  await rpc("internal_set_checkout_session", { p_payment_id: p.payment_id, p_session_id: session.id });
  return json({ url: session.url });
});
