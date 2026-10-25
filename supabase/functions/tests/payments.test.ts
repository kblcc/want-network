// End-to-end test of the Stripe edge functions against a real Postgres
// (PGlite, in memory) with all migrations, and a simulated Stripe API.
// Run: deno run -A supabase/functions/tests/payments.test.ts
import { PGlite } from "npm:@electric-sql/pglite@0.3";
import { pgcrypto } from "npm:@electric-sql/pglite@0.3/contrib/pgcrypto";

const ROOT = new URL("../../", import.meta.url).pathname; // supabase/
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create table auth.users(id uuid primary key, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create publication supabase_realtime;`);
const files = ["schema.sql", ...[...Deno.readDirSync(ROOT + "migrations")].map((e) => "migrations/" + e.name).sort()];
for (const f of files) await db.exec(Deno.readTextFileSync(ROOT + f));
await db.exec(`grant select on all tables in schema public to service_role;`);

const U = { buyer: "00000000-0000-0000-0000-00000000000b", prov: "00000000-0000-0000-0000-00000000000a", other: "00000000-0000-0000-0000-00000000000c" };
await db.exec(`insert into auth.users values ('${U.buyer}','{"role":"buyer","display_name":"Bea"}'),('${U.prov}','{"role":"provider","display_name":"Clara"}'),('${U.other}','{"role":"buyer","display_name":"Sam"}');
update app_config set payments_enabled=true, fee_percent=10;`);
const as = async (uid: string, q: string) => { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role authenticated;`); try { return await db.query<any>(q); } finally { await db.exec("reset role;"); } };
const newJob = async (amount: number) => {
  const id = (await as(U.buyer, `insert into intents(buyer_id,description,category) values('${U.buyer}','Clean apt','cleaning') returning id`)).rows[0].id;
  const oid = (await as(U.prov, `insert into offers(intent_id,provider_id,amount) values('${id}','${U.prov}',${amount}) returning id`)).rows[0].id;
  await as(U.buyer, `select accept_offer('${oid}','${id}')`);
  return id as string;
};
const payStatus = async (id: string) => (await db.query<any>(`select status from payments where intent_id='${id}'`)).rows[0]?.status;
const wantStatus = async (id: string) => (await db.query<any>(`select status from intents where id='${id}'`)).rows[0]?.status;

// ---- environment + simulated network
Deno.env.set("SUPABASE_URL", "http://supa.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_fake");
Deno.env.set("STRIPE_WEBHOOK_SECRET", "whsec_test");
Deno.env.set("APP_URL", "https://want-network.vercel.app");
const tokens: Record<string, string> = { "tok-buyer": U.buyer, "tok-prov": U.prov, "tok-other": U.other };
const stripeCalls: { path: string; method: string; body: URLSearchParams; idem: string | null }[] = [];
let acctFlags = { details_submitted: false, charges_enabled: false, payouts_enabled: false, transfers: "inactive" };
let sessionCount = 0;

globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.host === "supa.test") {
    if (url.pathname === "/auth/v1/user") {
      const uid = tokens[(headers.get("Authorization") ?? "").replace("Bearer ", "")];
      return uid ? resp({ id: uid, email: uid.slice(-1) + "@ex.com" }) : resp({ msg: "bad jwt" }, 401);
    }
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (m) {
      const args = JSON.parse(String(init.body ?? "{}"));
      const keys = Object.keys(args);
      const sql = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
      try {
        await db.exec("reset role; set role service_role;");
        const r = await db.query<any>(sql, keys.map((k) => args[k]));
        return resp(r.rows[0].r ?? null);
      } catch (e) { return resp({ message: (e as Error).message, code: "P0001" }, 400); }
      finally { await db.exec("reset role;"); }
    }
    const t = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (t) {
      const filters = [...url.searchParams].filter(([k]) => k !== "select").map(([k, v]) => `${k} = '${v.replace(/^eq\./, "")}'`);
      const r = await db.query<any>(`select * from public.${t[1]}${filters.length ? " where " + filters.join(" and ") : ""}`);
      const wantsObject = (headers.get("Accept") ?? "").includes("vnd.pgrst.object");
      return resp(wantsObject ? (r.rows[0] ?? null) : r.rows, wantsObject && !r.rows[0] ? 406 : 200);
    }
    return resp({ message: "not mocked " + url.pathname }, 404);
  }
  if (url.host === "api.stripe.com") {
    const path = url.pathname.replace("/v1/", "");
    const body = new URLSearchParams(method === "GET" ? url.search : String(init.body ?? ""));
    stripeCalls.push({ path, method, body, idem: headers.get("Idempotency-Key") });
    if (path === "checkout/sessions") { sessionCount++; return resp({ id: `cs_test_${sessionCount}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sessionCount}` }); }
    if (path.startsWith("payment_intents/")) return resp({ id: path.split("/")[1], latest_charge: { id: "ch_" + path.split("_").pop() } });
    if (path === "refunds") return resp({ id: "re_" + stripeCalls.length });
    if (path === "transfers") return resp({ id: "tr_" + stripeCalls.length });
    if (path === "accounts" && method === "POST") return resp({ id: "acct_clara", ...acctFlags });
    if (path === "accounts/acct_clara") return resp({ id: "acct_clara", details_submitted: acctFlags.details_submitted, charges_enabled: acctFlags.charges_enabled, payouts_enabled: acctFlags.payouts_enabled, capabilities: { transfers: acctFlags.transfers } });
    if (path === "account_links") return resp({ url: "https://connect.stripe.com/setup/e/acct_clara/xyz" });
    if (path === "accounts/acct_clara/login_links") return resp({ url: "https://connect.stripe.com/express/acct_clara" });
    return resp({ error: { message: "not mocked " + path } }, 400);
  }
  throw new Error("Unexpected network call: " + url.href);
};

const { handle: checkout } = await import("../stripe-checkout/handler.ts");
const { handle: webhook } = await import("../stripe-webhook/handler.ts");
const { handle: connect } = await import("../stripe-connect/handler.ts");
const { handle: release } = await import("../stripe-release/handler.ts");
const call = async (h: (r: Request) => Promise<Response>, token: string | null, body: unknown, origin = "https://want-network-git-feature-payments-kblcc.vercel.app") => {
  const res = await h(new Request("http://fn.test/", { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", origin }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const enc = new TextEncoder();
const signedWebhook = async (event: unknown, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) => {
  const payload = JSON.stringify(event);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await webhook(new Request("http://fn.test/", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: payload }));
  return { status: res.status, body: await res.json() };
};
const paidEvent = (session: string, pi: string, amount: number) => ({ type: "checkout.session.completed", data: { object: { id: session, payment_intent: pi, amount_total: amount, payment_status: "paid" } } });

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };

// ---- 1. Pay
const J1 = await newJob(100);
ok((await call(checkout, null, { intent_id: J1 })).status === 401, "checkout requires sign-in");
ok((await call(checkout, "tok-other", { intent_id: J1 })).status === 400, "another user cannot pay for this WANT");
let r = await call(checkout, "tok-buyer", { intent_id: J1 });
ok(r.status === 200 && r.body.url.startsWith("https://checkout.stripe.com/"), "buyer gets a Stripe Checkout link");
const cs = stripeCalls.findLast((c) => c.path === "checkout/sessions")!;
ok(cs.body.get("line_items[0][price_data][unit_amount]") === "10000" && cs.body.get("mode") === "payment", "checkout charges $100.00");
ok(cs.body.get("success_url")!.startsWith("https://want-network-git-feature-payments-kblcc.vercel.app/?payment=success"), "returns to the preview site the buyer came from");
r = await call(checkout, "tok-buyer", { intent_id: J1 }, "https://evil.example.com");
ok(stripeCalls.findLast((c) => c.path === "checkout/sessions")!.body.get("success_url")!.startsWith("https://want-network.vercel.app/"), "unknown sites are never used as return URLs");
ok(await payStatus(J1) === "pending", "payment is pending until Stripe confirms");
ok((await as(U.prov, `select start_job('${J1}')`).catch(() => "blocked")) === "blocked", "provider cannot start before payment");

// ---- 2. Webhook
const session1 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J1}'`)).rows[0].s;
ok((await signedWebhook(paidEvent(session1, "pi_1", 10000), "whsec_wrong")).status === 400, "webhook with a wrong signature is rejected");
ok((await signedWebhook(paidEvent(session1, "pi_1", 10000), "whsec_test", Math.floor(Date.now() / 1000) - 3600)).status === 400, "old (replayed) webhook is rejected");
r = await signedWebhook(paidEvent(session1, "pi_1", 10000));
ok(r.status === 200 && await payStatus(J1) === "held", "signed webhook marks the payment held");
ok((await signedWebhook(paidEvent(session1, "pi_1", 10000))).body.duplicate === true, "repeated webhook is harmless");
await as(U.prov, `select start_job('${J1}')`); await as(U.prov, `select mark_job_done('${J1}')`);
ok(await wantStatus(J1) === "matched", "provider starts and marks done after payment");

// ---- 3. Provider payouts setup
ok((await call(connect, "tok-buyer", { action: "onboard" })).status === 403, "buyers cannot open payout setup");
r = await call(connect, "tok-prov", { action: "onboard" });
ok(r.status === 200 && r.body.url.includes("connect.stripe.com"), "provider gets a Stripe onboarding link");
ok(stripeCalls.find((c) => c.path === "accounts")?.body.get("type") === "express", "creates an Express account");
ok((await as(U.prov, `select stripe_account_id from payout_accounts`)).rows[0]?.stripe_account_id === "acct_clara", "payout account saved (visible only to the provider)");
ok((await as(U.buyer, `select * from payout_accounts`)).rows.length === 0, "buyer cannot see the provider's payout account");

// ---- 4. Complete before provider finished onboarding -> payout waits
ok((await call(release, "tok-prov", { intent_id: J1, action: "complete" })).status === 400, "only the buyer can confirm & release");
r = await call(release, "tok-buyer", { intent_id: J1, action: "complete" });
ok(r.status === 200 && r.body.completed && !r.body.released, "completed; payout waits for the provider's payout setup");
ok(await wantStatus(J1) === "completed" && await payStatus(J1) === "release_pending", "WANT completed, payout pending");
ok(!stripeCalls.some((c) => c.path === "transfers"), "no money sent to an unfinished account");

// ---- 5. Provider finishes onboarding -> pending payout released
acctFlags = { details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers: "active" };
r = await call(connect, "tok-prov", { action: "status" });
const tr = stripeCalls.find((c) => c.path === "transfers");
ok(r.body.payouts_enabled && r.body.released?.[0]?.ok, "status check releases the waiting payout");
ok(tr?.body.get("amount") === "9000" && tr?.body.get("destination") === "acct_clara" && tr?.body.get("source_transaction") === "ch_1", "transfer: $90.00 (100 − 10% fee) to the provider, tied to the charge");
ok(tr?.idem?.startsWith("transfer-"), "transfer is idempotent (can never be sent twice)");
ok(await payStatus(J1) === "released", "payment released");
await call(connect, "tok-prov", { action: "status" });
ok(stripeCalls.filter((c) => c.path === "transfers").length === 1, "refreshing again does not pay twice");
r = await call(connect, "tok-prov", { action: "dashboard" });
ok(r.body.url?.includes("express"), "provider can open their Stripe Express dashboard");

// ---- 6. Second job: provider ready -> instant payout on completion
const J2 = await newJob(55.5);
await call(checkout, "tok-buyer", { intent_id: J2 });
const s2 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J2}'`)).rows[0].s;
await signedWebhook(paidEvent(s2, "pi_2", 5550));
await as(U.prov, `select start_job('${J2}')`);
r = await call(release, "tok-buyer", { intent_id: J2, action: "complete" });
ok(r.body.released === true && stripeCalls.findLast((c) => c.path === "transfers")?.body.get("amount") === "4995", "instant payout $49.95 for a $55.50 job");

// ---- 7. Refund before start
const J3 = await newJob(40);
await call(checkout, "tok-buyer", { intent_id: J3 });
const s3 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J3}'`)).rows[0].s;
await signedWebhook(paidEvent(s3, "pi_3", 4000));
ok((await call(release, "tok-other", { intent_id: J3, action: "cancel" })).status === 400, "another user cannot cancel/refund");
r = await call(release, "tok-buyer", { intent_id: J3, action: "cancel" });
ok(r.body.cancelled && stripeCalls.findLast((c) => c.path === "refunds")?.body.get("payment_intent") === "pi_3", "buyer cancels before start → full refund");
ok(await payStatus(J3) === "refunded" && await wantStatus(J3) === "cancelled", "WANT cancelled, payment refunded");

// ---- 8. No refund after start
const J4 = await newJob(30);
await call(checkout, "tok-buyer", { intent_id: J4 });
const s4 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J4}'`)).rows[0].s;
await signedWebhook(paidEvent(s4, "pi_4", 3000));
await as(U.prov, `select start_job('${J4}')`);
const refundsBefore = stripeCalls.filter((c) => c.path === "refunds").length;
r = await call(release, "tok-buyer", { intent_id: J4, action: "cancel" });
ok(r.status === 400 && stripeCalls.filter((c) => c.path === "refunds").length === refundsBefore, "no self-service refund once the job started");

// ---- 9. Payment lands after the WANT was cancelled -> automatic refund
const J5 = await newJob(20);
await call(checkout, "tok-buyer", { intent_id: J5 });
const s5 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J5}'`)).rows[0].s;
await as(U.buyer, `select cancel_intent('${J5}')`);
r = await signedWebhook(paidEvent(s5, "pi_5", 2000));
ok(r.body.refunded === true && await payStatus(J5) === "refunded", "late payment on a cancelled WANT is refunded automatically");

// ---- 10. Wrong amount from Stripe -> refunded, never held
const J6 = await newJob(80);
await call(checkout, "tok-buyer", { intent_id: J6 });
const s6 = (await db.query<any>(`select stripe_checkout_session_id s from payments where intent_id='${J6}'`)).rows[0].s;
r = await signedWebhook(paidEvent(s6, "pi_6", 100));
ok(r.body.refunded === true && await payStatus(J6) !== "held", "mismatched amount is refunded, not accepted");

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
