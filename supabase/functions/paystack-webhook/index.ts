import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/*
 * Paystack webhook handler — the ONLY path that creates a real booking or
 * (historically) credits a wallet with real money.
 * verify_jwt is deliberately OFF: Paystack calls this directly with no
 * Supabase session, authenticating instead via the `x-paystack-signature`
 * header, verified below as HMAC-SHA512 of the raw body using
 * PAYSTACK_SECRET_KEY. Do not add verify_jwt back without breaking
 * Paystack's ability to call this.
 *
 * On a charge.success event this branches on tx.metadata.kind:
 *   - "booking" (tx.metadata.booking present): creates the booking via
 *     admin_create_booking (service-role-only RPC), using the fields the
 *     create-booking-payment edge function stashed in metadata.booking
 *     when the transaction was initialized. This is the real, charge-
 *     confirmed-first replacement for the old book_trip flow — no booking
 *     is ever created before Paystack confirms payment.
 *   - anything else (no metadata.booking): legacy/unrecognized transaction
 *     kind (e.g. old wallet top-ups from before the Travel Wallet feature
 *     was removed — see CLAUDE.md). Logged and acknowledged with
 *     {received: true}, not treated as an error — new wallet-topup
 *     transactions are never created by the frontend anymore, but we keep
 *     a safe no-op here rather than erroring on something unrecognized.
 *
 * Idempotency: Paystack can redeliver the same webhook. Each transaction
 * reference is inserted into paystack_events (primary key) before
 * processing; a duplicate insert (unique violation) means this event was
 * already handled.
 *
 * Confidence: MODERATE-HIGH on Paystack's webhook shape/signature scheme
 * (well-documented, stable) — UNTESTED against a real Paystack webhook
 * from this environment. Verify with a real test-mode payment once
 * PAYSTACK_SECRET_KEY is set and the webhook URL is registered in the
 * Paystack dashboard.
 *
 * Requires edge function secrets:
 *   PAYSTACK_SECRET_KEY — same key as create-booking-payment, also
 *     used here to verify the webhook signature
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
 * Supabase platform.
 */

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function verifyPaystackSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computedHex === signature;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 });
  }
  if (!PAYSTACK_SECRET_KEY) {
    return new Response("PAYSTACK_SECRET_KEY not configured", { status: 500 });
  }

  const signature = req.headers.get("x-paystack-signature");
  if (!signature) {
    return new Response("Missing x-paystack-signature header", { status: 400 });
  }

  const rawBody = await req.text();
  const valid = await verifyPaystackSignature(rawBody, signature, PAYSTACK_SECRET_KEY);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (event.event === "charge.success") {
    const tx = event.data;
    const reference: string | undefined = tx?.reference;
    if (!reference) {
      return new Response(JSON.stringify({ error: "No reference on charge.success event" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const { error: dedupeError } = await supabase.from("paystack_events").insert({ id: reference });
    if (dedupeError) {
      // Already processed this reference — ack without re-processing.
      return new Response(JSON.stringify({ received: true, duplicate: true }), { headers: { "Content-Type": "application/json" } });
    }

    const booking = tx?.metadata?.booking as
      | {
          destination_city?: string;
          destination_country?: string;
          traveller_name?: string;
          nights?: number;
          total_amount?: number;
          details?: Record<string, unknown>;
        }
      | undefined;
    const userId = tx?.metadata?.user_id as string | undefined;

    if (booking && userId) {
      const { error } = await supabase.rpc("admin_create_booking", {
        p_user_id: userId,
        p_destination_city: booking.destination_city,
        p_destination_country: booking.destination_country,
        p_traveller_name: booking.traveller_name,
        p_nights: booking.nights,
        p_total_amount: booking.total_amount,
        p_details: booking.details ?? {},
        p_payment_ref: reference,
      });
      if (error) {
        console.error("admin_create_booking failed:", error);
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    } else {
      // Legacy/unrecognized transaction kind (e.g. a pre-removal wallet
      // top-up) — nothing for us to do, just acknowledge so Paystack
      // doesn't keep retrying.
      console.warn("charge.success with no metadata.booking/user_id — ignoring", reference);
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
