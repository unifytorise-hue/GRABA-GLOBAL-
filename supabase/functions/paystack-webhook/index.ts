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
 *   LITEAPI_KEY — same secret name as booking-hotel-search/liteapi-prebook,
 *     used for the real-reservation step below
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
 * Supabase platform.
 *
 * --- Real hotel reservation (LiteAPI prebook→book, see CLAUDE.md) ---
 * After admin_create_booking successfully creates the internal `bookings`
 * row, if `metadata.booking.prebookId` is present (it's only ever set for
 * real LiteAPI hotels — see create-booking-payment/liteapi-prebook — mock
 * hotels never have one), this calls LiteAPI's actual booking endpoint
 * (`POST https://book.liteapi.travel/v3.0/rates/book`, a different host
 * than the rest of LiteAPI's API, per the product owner's reference) inline
 * — chosen over a separate `liteapi-book` edge function to avoid an extra
 * HTTP hop for a call this webhook already has everything it needs for.
 *
 * CONFIDENCE — LOW-MODERATE, UNVERIFIED: same caveat as
 * booking-hotel-search/liteapi-prebook. The request shape below
 * (`{holder, guests, payment: {method: "ACC_CREDIT_CARD"}, prebookId}`) is
 * taken directly from the product owner's own screenshot of LiteAPI's
 * booking-flow tutorial, but has not been tested against a real LiteAPI
 * account from this sandbox (no live network access here). The response
 * shape (confirmation/booking reference field name) is an educated guess —
 * see `bookLiteApiHotel()` below.
 *
 * CRITICAL — payment already succeeded and the booking row already exists
 * by the time this runs, so a LiteAPI failure here (sold out, expired
 * prebook, API error, or simply no prebookId e.g. the mock-hotel path)
 * must NEVER fail this webhook or roll back the booking. It's recorded on
 * the booking instead:
 *   - success: details.supplierBookingRef + details.supplierConfirmed=true
 *   - failure: details.supplierBookingFailed=true + details.supplierBookingFailureReason
 * A paid-but-supplier-reservation-failed booking is a real, currently
 * MANUAL-ONLY-RECOVERY state — there is no automated refund path (that
 * would need testing against a live Paystack refund API this sandbox can't
 * verify). Ops must check bookings.details.supplierBookingFailed and, if
 * set, refund manually via the Paystack dashboard. See CLAUDE.md.
 */

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const LITEAPI_KEY = Deno.env.get("LITEAPI_KEY");
const LITEAPI_BOOK_URL = "https://book.liteapi.travel/v3.0/rates/book";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface BookHolder {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
}

// Attempts the actual LiteAPI reservation for a just-created booking. Never
// throws — always returns a result object the caller uses to update
// `bookings.details`, exactly mirroring the graceful-degrade pattern used
// throughout the other LiteAPI-facing functions in this repo.
async function bookLiteApiHotel(
  prebookId: string,
  holder: BookHolder,
): Promise<{ ok: true; supplierBookingRef: string | null; raw: unknown } | { ok: false; reason: string; raw?: unknown }> {
  if (!LITEAPI_KEY) {
    return { ok: false, reason: "LITEAPI_KEY is not configured as an edge function secret" };
  }
  const firstName = holder.firstName || "Guest";
  const lastName = holder.lastName || "Traveller";
  const email = holder.email || "";
  if (!email) {
    return { ok: false, reason: "No holder email available for LiteAPI booking" };
  }

  try {
    const res = await fetch(LITEAPI_BOOK_URL, {
      method: "POST",
      headers: {
        "X-API-Key": LITEAPI_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        holder: { firstName, lastName, email, phone: holder.phone ?? undefined },
        guests: [{ occupancyNumber: 1, firstName, lastName, email }],
        payment: { method: "ACC_CREDIT_CARD" },
        prebookId,
      }),
    });
    // deno-lint-ignore no-explicit-any
    const raw: any = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: `LiteAPI book error: ${res.status} ${JSON.stringify(raw)}`, raw };
    }
    // deno-lint-ignore no-explicit-any
    const d: any = raw?.data ?? raw ?? {};
    const supplierBookingRef =
      d.bookingId ?? d.booking_id ?? d.confirmationNumber ?? d.confirmation_number ?? d.reference ?? null;
    if (!supplierBookingRef) {
      console.error(
        "paystack-webhook: LiteAPI book call returned 2xx but no recognizable confirmation field — " +
          "field name guess in bookLiteApiHotel() may be wrong. Raw response:",
        JSON.stringify(raw),
      );
    }
    return { ok: true, supplierBookingRef, raw };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

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
          prebookId?: string | null;
          holder?: BookHolder;
        }
      | undefined;
    const userId = tx?.metadata?.user_id as string | undefined;

    if (booking && userId) {
      const { data: createdBooking, error } = await supabase.rpc("admin_create_booking", {
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

      // Real hotel reservation, step 2 (see file header). The internal
      // booking row above already stands regardless of what happens here —
      // payment succeeded and admin_create_booking already committed.
      const bookingId = createdBooking?.id as string | undefined;
      if (bookingId) {
        if (booking.prebookId) {
          const result = await bookLiteApiHotel(booking.prebookId, booking.holder ?? {});
          const detailsPatch = result.ok
            ? { supplierConfirmed: true, supplierBookingRef: result.supplierBookingRef }
            : { supplierBookingFailed: true, supplierBookingFailureReason: result.reason };
          if (!result.ok) {
            console.error(
              `paystack-webhook: LiteAPI reservation FAILED for booking ${bookingId} (payment already charged, ` +
                `internal booking already stands) — requires manual intervention. Reason:`,
              result.reason,
            );
          }
          const { error: updateError } = await supabase
            .from("bookings")
            .update({ details: { ...(createdBooking.details ?? {}), ...detailsPatch } })
            .eq("id", bookingId);
          if (updateError) {
            console.error(`paystack-webhook: failed to persist LiteAPI reservation result on booking ${bookingId}:`, updateError);
          }
        } else {
          // No prebookId — either a mock/fallback hotel (never had a real
          // LiteAPI rate to reserve, by design — see genHotels()/CLAUDE.md)
          // or liteapi-prebook failed client-side and the frontend proceeded
          // anyway rather than blocking payment. Flagged via the same
          // supplierBookingFailed field as a genuine LiteAPI failure (not a
          // separate flag) so ops has one field to check for "does this
          // booking have a confirmed real reservation or not" — the reason
          // text distinguishes the benign mock-hotel case from a real one.
          console.warn(`paystack-webhook: booking ${bookingId} has no prebookId — no real LiteAPI reservation possible (mock hotel or client-side prebook failure).`);
          const { error: updateError } = await supabase
            .from("bookings")
            .update({
              details: {
                ...(createdBooking.details ?? {}),
                supplierBookingFailed: true,
                supplierBookingFailureReason: "No prebookId on this booking — either a mock/fallback hotel (no real LiteAPI rate was ever available) or the client-side prebook step failed/was skipped.",
              },
            })
            .eq("id", bookingId);
          if (updateError) {
            console.error(`paystack-webhook: failed to persist missing-prebookId flag on booking ${bookingId}:`, updateError);
          }
        }
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
