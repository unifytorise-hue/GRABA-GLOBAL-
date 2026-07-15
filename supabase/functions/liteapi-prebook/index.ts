import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
 * liteapi-prebook — step 2 of LiteAPI's real hotel-reservation flow (see
 * booking-hotel-search's header comment for step 1: search + rates, and
 * CLAUDE.md for the full picture).
 *
 * Takes `{offerId}` (the field `booking-hotel-search` now returns per hotel
 * — see its file header for how/whether that field name is trustworthy) and
 * calls LiteAPI's `POST /v3.0/rates/prebook`, which places a time-limited
 * hold on that priced rate (locks in price/availability) and returns a
 * `prebookId` used by the actual booking call (`POST
 * https://book.liteapi.travel/v3.0/rates/book`, done in paystack-webhook
 * once payment is confirmed — see that function and liteapi-book if split
 * out).
 *
 * CONFIDENCE — LOW-MODERATE, UNVERIFIED: same caveat as booking-hotel-search.
 * This sandbox has no live internet access to LiteAPI's docs or a real
 * LiteAPI account, so neither the exact request field name (`offerId`,
 * assumed from LiteAPI's documented "prebook a rate's offer id" pattern,
 * per the product owner's screenshot of LiteAPI's own tutorial) nor the
 * exact response shape (candidate keys tried below) has been directly
 * confirmed. This function degrades gracefully rather than guessing
 * silently: if it can't find a `prebookId` in LiteAPI's response under any
 * of the tried keys, it still returns 200 with `prebookId: null` and the
 * full raw LiteAPI response under `raw`, plus a console.error so this shows
 * up in Supabase edge function logs. The caller (index.html's bookBtn
 * handler) treats a null prebookId as "couldn't get a supplier hold" and
 * proceeds with payment anyway rather than blocking the booking — see
 * CLAUDE.md for why a payment-succeeded-but-no-reservation state is an
 * accepted, documented gap for now.
 *
 * Requires a LITEAPI_KEY edge function secret — same one used by
 * booking-hotel-search (reused, not a new secret name). If missing, returns
 * a clean 500, exactly like booking-hotel-search does.
 *
 * verify_jwt is ON — only a signed-in Graba user can place a prebook hold.
 */

const LITEAPI_PREBOOK_URL = "https://api.liteapi.travel/v3.0/rates/prebook";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("LITEAPI_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "LITEAPI_KEY is not configured as an edge function secret" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { offerId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const offerId = typeof body.offerId === "string" ? body.offerId.trim() : "";
  if (!offerId) {
    return new Response(JSON.stringify({ error: "offerId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  let raw: any = null;
  try {
    const res = await fetch(LITEAPI_PREBOOK_URL, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      // { offerId } is the assumed request shape — see CONFIDENCE note above.
      body: JSON.stringify({ offerId }),
    });
    raw = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("liteapi-prebook: LiteAPI prebook call failed", res.status, raw);
      return new Response(JSON.stringify({ error: `LiteAPI prebook error: ${res.status}`, detail: raw }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  const d: any = raw?.data ?? raw ?? {};
  const prebookId = d.prebookId ?? d.prebook_id ?? d.id ?? null;
  const expiresAt = d.expiresAt ?? d.expires_at ?? d.expiry ?? d.expiration ?? null;
  const price = d.price ?? d.totalRate ?? d.offerRetailRate ?? d.totalPrice ?? null;

  if (!prebookId) {
    console.error(
      "liteapi-prebook: could not find a prebookId in LiteAPI's response under any tried key " +
        "(prebookId/prebook_id/id) — field name guess may be wrong, check CLAUDE.md and the raw response below.",
      JSON.stringify(raw),
    );
  }

  return new Response(
    JSON.stringify({ prebookId, expiresAt, price, raw }),
    { headers: { "Content-Type": "application/json" } },
  );
});
