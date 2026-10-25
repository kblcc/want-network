import { stripe } from "./stripe.ts";
import { rpc } from "./http.ts";

type Pending = { payment_id: string; transfer_cents: number; currency: string; charge_id: string | null; intent_id: string };

// Sends one payout (transfer) to a provider's Stripe account. Idempotent per payment.
export async function sendPayout(p: Pending, destination: string) {
  const transfer = await stripe("transfers", {
    amount: p.transfer_cents,
    currency: p.currency,
    destination,
    source_transaction: p.charge_id ?? undefined,
    transfer_group: p.intent_id,
    metadata: { payment_id: p.payment_id, intent_id: p.intent_id },
  }, { idempotencyKey: `transfer-${p.payment_id}` });
  await rpc("internal_record_transfer", { p_payment_id: p.payment_id, p_transfer_id: transfer.id });
  return transfer.id as string;
}

// Releases every payout that was waiting for this provider's account to be ready.
export async function releasePending(providerId: string, destination: string) {
  const pending = await rpc<Pending[]>("internal_pending_payouts", { p_provider_id: providerId });
  const results: { payment_id: string; ok: boolean; error?: string }[] = [];
  for (const p of pending ?? []) {
    try { await sendPayout(p, destination); results.push({ payment_id: p.payment_id, ok: true }); }
    catch (e) { results.push({ payment_id: p.payment_id, ok: false, error: (e as Error).message }); }
  }
  return results;
}
