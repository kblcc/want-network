// Providers set up payouts with Stripe (Express accounts).
// action: "onboard" -> Stripe onboarding link, "status" -> refresh + release waiting payouts,
// "dashboard" -> link to the provider's Stripe Express dashboard.
import { stripe } from "../_shared/stripe.ts";
import { admin, appOrigin, HttpError, json, requireUser, rpc, serve } from "../_shared/http.ts";
import { releasePending } from "../_shared/payouts.ts";

export const handle = serve(async (req) => {
  const user = await requireUser(req);
  const { action } = await req.json().catch(() => ({}));
  const db = admin();
  const { data: prof } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (prof?.role !== "provider") throw new HttpError("Only provider accounts can set up payouts.", 403);
  const { data: acct } = await db.from("payout_accounts").select("*").eq("user_id", user.id).maybeSingle();

  if (action === "onboard") {
    let accountId = acct?.stripe_account_id as string | undefined;
    if (!accountId) {
      const a = await stripe("accounts", {
        type: "express",
        country: Deno.env.get("STRIPE_CONNECT_COUNTRY") ?? "US",
        email: user.email ?? undefined,
        capabilities: { transfers: { requested: true } },
        business_type: "individual",
        metadata: { user_id: user.id },
      }, { idempotencyKey: `connect-account-${user.id}` });
      accountId = a.id;
      await rpc("internal_upsert_payout_account", { p_user_id: user.id, p_account_id: a.id, p_details: !!a.details_submitted, p_charges: !!a.charges_enabled, p_payouts: !!a.payouts_enabled });
    }
    const origin = appOrigin(req);
    const link = await stripe("account_links", {
      account: accountId,
      refresh_url: `${origin}/?payouts=refresh`,
      return_url: `${origin}/?payouts=return`,
      type: "account_onboarding",
    });
    return json({ url: link.url });
  }

  if (action === "status") {
    if (!acct) return json({ connected: false });
    const a = await stripe(`accounts/${acct.stripe_account_id}`, {}, { method: "GET" });
    await rpc("internal_upsert_payout_account", { p_user_id: user.id, p_account_id: a.id, p_details: !!a.details_submitted, p_charges: !!a.charges_enabled, p_payouts: !!a.payouts_enabled });
    const ready = !!a.payouts_enabled && a.capabilities?.transfers === "active";
    const released = ready ? await releasePending(user.id, a.id) : [];
    return json({ connected: true, details_submitted: !!a.details_submitted, payouts_enabled: ready, released });
  }

  if (action === "dashboard") {
    if (!acct) throw new HttpError("Set up payouts first.");
    const l = await stripe(`accounts/${acct.stripe_account_id}/login_links`, {});
    return json({ url: l.url });
  }

  throw new HttpError("Unknown action");
});
