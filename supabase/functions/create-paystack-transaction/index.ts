import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/*
 * Initializes a Paystack transaction for a Travel Wallet top-up. This is the
 * active payment path (superseding create-checkout-session/Stripe, left
 * deployed but unused — see CLAUDE.md) since the business went with
 * Paystack instead.
 *
 * NOTE: no longer called from index.html on the claude/remove-wallet branch
 * (the wallet was removed there — see CLAUDE.md), but this function IS
 * still called by the live `main` branch, which still has the wallet.
 * Previously deployed-only, never version-controlled — added here for the
 * same reason booking-hotel-search etc. were: so the source isn't only
 * living in Supabase.
 *
 * Confidence: MODERATE-HIGH. Paystack's Transaction Initialize API
 * (POST /transaction/initialize, Bearer secret key, amount in kobo/cents)
 * is a well-known, stable, widely-documented REST API — higher confidence
 * than Sabre/Booking.com/SerpApi, but not Anthropic-own-API-level certain
 * either. UNTESTED against a real Paystack account from this environment
 * (no live Paystack access here). Verify a real test transaction once
 * PAYSTACK_SECRET_KEY is set and activated.
 *
 * verify_jwt is ON — only a signed-in Graba user can start a transaction
 * for themselves. metadata.user_id ties the transaction back to them for
 * the webhook to credit the right wallet.
 *
 * CORS: called directly from the browser — see booking-hotel-search's
 * header for why this needs an explicit OPTIONS handler + CORS headers on
 * every response. This function was previously missing both, which would
 * have silently broken every wallet top-up attempt on the live `main`
 * branch at the browser CORS-preflight stage.
 *
 * Requires edge function secrets:
 *   PAYSTACK_SECRET_KEY — from the Paystack dashboard (test key while
 *     activation/docs are pending)
 *   SITE_URL — optional, defaults to the GitHub Pages URL
 * SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by the platform.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://unifytorise-hue.github.io/GRABA-GLOBAL-/";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "PAYSTACK_SECRET_KEY is not configured as an edge function secret" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
  if (!user.email) {
    return new Response(JSON.stringify({ error: "Account has no email on file — required by Paystack" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  let body: { amount?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return new Response(JSON.stringify({ error: "amount must be a positive number" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(amount * 100), // Paystack amounts are in the smallest currency unit (kobo/cents)
        currency: "ZAR",
        callback_url: `${SITE_URL}?topup=paystack`,
        metadata: { user_id: user.id },
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.status) {
      return new Response(JSON.stringify({ error: "Paystack initialize failed", detail: data }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ url: data.data.authorization_url, reference: data.data.reference }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
