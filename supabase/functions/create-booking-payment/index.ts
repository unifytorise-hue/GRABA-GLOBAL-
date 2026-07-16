import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/*
 * Initializes a Paystack transaction for a full trip booking, charged at
 * booking time. This replaces the old flow where bookBtn.onclick called
 * book_trip directly and created a booking immediately, with
 * p_payment_method a pure label and NO real charge ever happening for the
 * card-covered portion. That was a real bug: the app had no way to
 * actually collect money for a 'card' or 'split' booking.
 *
 * The Travel Wallet feature (and topping it up via
 * create-paystack-transaction) has been removed as a product decision
 * (stored-value / e-money regulatory risk) — see CLAUDE.md. This function
 * is the wallet top-up flow's replacement for the booking path: same
 * "init transaction client-side, webhook confirms and does the trusted
 * write" pattern, but for creating a booking instead of crediting a
 * wallet. No booking row is created here — only after Paystack confirms
 * payment does paystack-webhook call the new admin_create_booking RPC.
 *
 * Confidence: MODERATE-HIGH — same Paystack Transaction Initialize API as
 * create-paystack-transaction, which this closely mirrors. UNTESTED
 * against a real Paystack account from this environment.
 *
 * verify_jwt is ON — only a signed-in Graba user can start a booking
 * payment for themselves. metadata.user_id + metadata.booking carry
 * everything paystack-webhook needs to create the booking once payment is
 * confirmed; metadata.kind = "booking" lets the webhook tell this apart
 * from any other transaction kind it might see.
 *
 * Requires edge function secrets:
 *   PAYSTACK_SECRET_KEY — from the Paystack dashboard
 *   SITE_URL — optional, defaults to the GitHub Pages URL
 * SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected by the platform.
 *
 * Real hotel reservation (LiteAPI prebook→book, see CLAUDE.md): the frontend
 * may also send `prebookId` (from `liteapi-prebook`, only present for real
 * LiteAPI hotels — mock/fallback hotels never have one) and `holder`
 * (first/last name split from the traveller name field, best-effort — no new
 * form fields were added for this). Both are stashed into
 * `metadata.booking` unchanged so `paystack-webhook` can read them once
 * payment is confirmed and attempt the actual LiteAPI booking call. The
 * holder's email always comes from this function's own verified `user.email`
 * (never trusted from the client) since Paystack already requires it.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://unifytorise-hue.github.io/GRABA-GLOBAL-/";

interface BookingPayload {
  total_amount?: number;
  destination_city?: string;
  destination_country?: string;
  traveller_name?: string;
  nights?: number;
  details?: Record<string, unknown>;
  prebookId?: string | null;
  holder?: { firstName?: string; lastName?: string; phone?: string };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "PAYSTACK_SECRET_KEY is not configured as an edge function secret" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!user.email) {
    return new Response(JSON.stringify({ error: "Account has no email on file — required by Paystack" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  let body: BookingPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const total_amount = Number(body.total_amount);
  const destination_city = String(body.destination_city ?? "").trim();
  const destination_country = String(body.destination_country ?? "").trim();
  const traveller_name = String(body.traveller_name ?? "").trim();
  const nights = Number(body.nights);
  const details = (body.details && typeof body.details === "object") ? body.details : {};
  const prebookId = (typeof body.prebookId === "string" && body.prebookId.trim()) ? body.prebookId.trim() : null;
  // Best-effort holder name — no dedicated form fields exist for this yet
  // (see CLAUDE.md), so fall back to splitting traveller_name on first space.
  const fallbackParts = traveller_name.split(/\s+/).filter(Boolean);
  const holderFirstName = String(body.holder?.firstName ?? "").trim() || fallbackParts[0] || "Guest";
  const holderLastName = String(body.holder?.lastName ?? "").trim() || fallbackParts.slice(1).join(" ") || "Traveller";
  const holderPhone = String(body.holder?.phone ?? "").trim() || null;

  if (!Number.isFinite(total_amount) || total_amount <= 0) {
    return new Response(JSON.stringify({ error: "total_amount must be a positive number" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!destination_city || !destination_country) {
    return new Response(JSON.stringify({ error: "destination_city and destination_country are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!Number.isFinite(nights) || nights <= 0) {
    return new Response(JSON.stringify({ error: "nights must be a positive number" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
        amount: Math.round(total_amount * 100), // Paystack amounts are in the smallest currency unit (kobo/cents)
        currency: "ZAR",
        callback_url: `${SITE_URL}?booking=paystack`,
        metadata: {
          kind: "booking",
          user_id: user.id,
          booking: {
            destination_city,
            destination_country,
            traveller_name,
            nights,
            total_amount,
            details,
            prebookId,
            holder: { firstName: holderFirstName, lastName: holderLastName, email: user.email, phone: holderPhone },
          },
        },
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.status) {
      return new Response(JSON.stringify({ error: "Paystack initialize failed", detail: data }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ url: data.data.authorization_url, reference: data.data.reference }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
});
