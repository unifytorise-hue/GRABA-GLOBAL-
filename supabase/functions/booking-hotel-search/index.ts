import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
 * Hotel search for Graba — backed by LiteAPI (https://www.liteapi.travel/),
 * a real, bookable hotel-supply API (unlike the SerpApi google_hotels
 * integration this replaces, which was search/price-display only, scraped
 * from Google Hotels, and could never actually create a reservation).
 *
 * LiteAPI is a two-step lookup:
 *   1. GET /v3.0/data/hotels — property list near a lat/lon (name, stars,
 *      guest rating, coordinates; no live pricing).
 *   2. POST /v3.0/hotels/rates — live rates for a set of hotel ids over a
 *      check-in/check-out window.
 * A hotel is only included in the response if step 2 actually returned a
 * priced rate for it — this function never invents a price, so pricePerNight
 * is always a real number when present, and (as before) the frontend falls
 * back to its own generated mock hotels if this returns zero hotels or
 * errors for any reason (never-zero-availability is a frontend concern, not
 * this function's).
 *
 * Response contract is ADDITIVE to the SerpApi version it replaces:
 *   { source, hotels: [{id, name, type, pricePerNight, rating, currency, lat, lon, offerId, liteApiId}] }
 * — every previously-existing field is unchanged; `offerId` and `liteApiId`
 * are new (see below).
 *
 * Requires a LITEAPI_KEY edge function secret — set via the Supabase
 * dashboard (Project Settings → Edge Functions → Secrets) or
 * `supabase secrets set LITEAPI_KEY=...`; there's no MCP tool that can set
 * this, so it has to be done directly by whoever holds the key.
 *
 * --- offerId (real reservation, added for the LiteAPI prebook→book flow) ---
 * `offerId` is the identifier LiteAPI's own docs say to pass to
 * `POST /v3.0/rates/prebook` to hold a specific priced rate before booking
 * it (see `liteapi-prebook`/`liteapi-book` edge functions and CLAUDE.md).
 *
 * CONFIDENCE — LOW-MODERATE, UNVERIFIED, please read before trusting this:
 * this sandbox has no live internet access to LiteAPI's docs or a real
 * LiteAPI account, so the exact field name/location of "the offer id" inside
 * `POST /v3.0/hotels/rates`'s response was not directly confirmed. The only
 * reference available was `liteapi-hotels.server.ts` (a sibling prototype
 * app's adapter, read-only, not live-tested either), whose `LiteRate` type
 * only models `offerRetailRate`/`rates[].retailRate` (price) — it does NOT
 * reference an offer/rate id at all, because that adapter only ever needed
 * to *display* a price, never to book one. So there was no existing example
 * of the field name to copy.
 *
 * Best-effort guess, based on LiteAPI's documented pattern that prebook
 * takes "a rate's offer id" (per the product owner's screenshot of LiteAPI's
 * own tutorial): try `roomTypes[0].offerId` first (sibling to
 * `offerRetailRate`, the same object the price is read from), then fall back
 * to a couple of other plausible locations. If NONE of them are present,
 * `offerId` is returned as `null` for that hotel (never a made-up value) and
 * a single console.warn is logged with the actual keys seen on the rate
 * object, so a future session/human can grep the edge function logs and fix
 * the real field name in one place: the `extractOfferId()` function below.
 *
 * --- liteApiId / single-hotel reprice mode (added for real date selection) ---
 * `liteApiId` is the raw, unprefixed LiteAPI hotel id (the display `id`
 * field is `liteapi-${liteApiId}`) — added so the frontend can ask this
 * function to reprice ONE specific hotel for specific dates, without redoing
 * the whole destination-level list search.
 *
 * When the request body includes `hotelId` (a raw LiteAPI id, i.e. the same
 * value returned as `liteApiId`), this function skips the
 * `GET /v3.0/data/hotels` list call entirely and goes straight to
 * `POST /v3.0/hotels/rates` for just that one hotel id, returning the same
 * `{source, hotels: [...]}` shape with zero or one hotel in it. `checkin`/
 * `checkout` (explicit `YYYY-MM-DD` strings) can be supplied in the same
 * request to price that specific date range instead of the function's
 * default "+7 days" window — this also applies to the normal list-mode path
 * when those fields are provided, so both modes are date-override-capable.
 * When `hotelId` is absent, behavior is unchanged from before this mode was
 * added: same list call, same default date window unless overridden.
 *
 * Since single-hotel mode skips the list call, the returned hotel's `name`/
 * `lat`/`lon`/`rating` are NOT re-fetched (the frontend already has these
 * cached from the original list search and doesn't need them repeated) —
 * only `pricePerNight`, `offerId`, and `liteApiId` are meaningful in that
 * response; `name` falls back to "Unnamed property" and `lat`/`lon`/`rating`
 * to `null`, exactly like any other property this function couldn't find
 * metadata for.
 *
 * CONFIDENCE for this mode is the SAME LOW-MODERATE/UNVERIFIED level as the
 * rest of this file: it reuses the exact same rates-fetching and
 * `extractOfferId()` logic as the original list search (no new guesses were
 * introduced), but has not been exercised against a real LiteAPI response
 * (no live network access from this sandbox), so whether LiteAPI's
 * `/v3.0/hotels/rates` genuinely returns a single hotel back correctly when
 * given a one-element `hotelIds` array, and whether the returned price truly
 * reflects the requested date range, is unverified.
 */

const LITEAPI_HOTELS_URL = "https://api.liteapi.travel/v3.0/data/hotels";
const LITEAPI_RATES_URL = "https://api.liteapi.travel/v3.0/hotels/rates";

interface HotelResult {
  id: string;
  name: string;
  type: string;
  pricePerNight: number;
  rating: number | null;
  currency: string;
  lat: number | null;
  lon: number | null;
  offerId: string | null;
  liteApiId: string;
}

// deno-lint-ignore no-explicit-any
interface LiteHotel {
  id: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  stars?: number;
  rating?: number;
  [key: string]: unknown;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Parses a strict YYYY-MM-DD string into a UTC midnight Date, or null if the
// string isn't in that shape / doesn't parse — used to validate optional
// `checkin`/`checkout` overrides from the request body without ever trusting
// an arbitrary Date.parse() of untrusted input.
function parseDateOnly(s: unknown): Date | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normaliseRating(h: LiteHotel): number | null {
  if (typeof h.stars === "number" && h.stars > 0) return h.stars;
  if (typeof h.rating === "number" && h.rating > 0) return Math.min(5, h.rating / 2);
  return null;
}

// Best-effort extraction of "the offer id" from a LiteAPI rate's roomType —
// see the file header's CONFIDENCE note. Tries the most plausible field
// locations in order; returns null (never a guess/placeholder) if none hit,
// and logs once with the actual object shape so this is easy to fix later.
// deno-lint-ignore no-explicit-any
function extractOfferId(rt: any, r: any): string | null {
  const candidate =
    rt?.offerId ??
    rt?.offer_id ??
    rt?.rates?.[0]?.offerId ??
    rt?.rates?.[0]?.rateId ??
    rt?.rates?.[0]?.rate_id ??
    r?.offerId ??
    null;
  if (typeof candidate === "string" && candidate) return candidate;
  if (typeof candidate === "number") return String(candidate);
  return null;
}

// Shared by both list-mode and single-hotel (hotelId) mode: prices a given
// set of LiteAPI hotel ids for a check-in/check-out window and maps the
// result into this function's HotelResult shape. Hotels without a returned
// rate are dropped rather than given a made-up price (see file header).
async function priceHotels(
  properties: LiteHotel[],
  checkIn: Date,
  checkOut: Date,
  apiKey: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ hotels: HotelResult[]; ratesRaw: any }> {
  const headers = { "X-API-Key": apiKey, "Accept": "application/json" };
  const rateMap = new Map<string, { amount: number; currency: string; offerId: string | null }>();
  // deno-lint-ignore no-explicit-any
  let ratesRaw: any = null;
  let offerIdMisses = 0;
  try {
    const ratesRes = await fetch(LITEAPI_RATES_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        hotelIds: properties.map((h) => h.id),
        occupancies: [{ adults: 2, children: [] }],
        checkin: fmtDate(checkIn),
        checkout: fmtDate(checkOut),
        currency: "ZAR",
        guestNationality: "ZA",
      }),
    });
    ratesRaw = await ratesRes.json();
    if (ratesRes.ok && Array.isArray(ratesRaw?.data)) {
      // deno-lint-ignore no-explicit-any
      for (const r of ratesRaw.data as any[]) {
        const rt = r.roomTypes?.[0];
        const amount = rt?.offerRetailRate?.amount ?? rt?.rates?.[0]?.retailRate?.total?.[0]?.amount;
        const currency = rt?.offerRetailRate?.currency ?? rt?.rates?.[0]?.retailRate?.total?.[0]?.currency ?? "ZAR";
        const offerId = extractOfferId(rt, r);
        if (offerId === null) offerIdMisses++;
        if (typeof amount === "number" && Number.isFinite(amount)) {
          rateMap.set(r.hotelId, { amount: Math.round(amount), currency, offerId });
        }
      }
    }
    // Logged once per request (not per hotel) so this doesn't spam the logs —
    // see the file header CONFIDENCE note. If this fires, extractOfferId()
    // above is the one place to fix once the real field name is known.
    if (offerIdMisses > 0 && rateMap.size > 0) {
      // deno-lint-ignore no-explicit-any
      const sample = (ratesRaw?.data as any[])?.[0]?.roomTypes?.[0];
      console.warn(
        `booking-hotel-search: could not find an offer id on ${offerIdMisses}/${rateMap.size} priced rate(s) — ` +
          `field name guess in extractOfferId() may be wrong. Sample roomTypes[0] keys: ${
            sample ? Object.keys(sample).join(", ") : "(no sample available)"
          }`,
      );
    }
  } catch (_err) {
    // Rate lookup failing entirely just means rateMap stays empty below —
    // handled the same as "no hotels priced", not a hard error.
  }

  const hotels: HotelResult[] = properties
    .filter((h) => rateMap.has(h.id))
    .map((h) => {
      const rate = rateMap.get(h.id)!;
      return {
        id: `liteapi-${h.id}`,
        name: h.name ?? "Unnamed property",
        type: "Hotel",
        pricePerNight: rate.amount,
        rating: normaliseRating(h),
        currency: "ZAR", // matches the rest of the app's display currency, same simplification the SerpApi function made
        lat: typeof h.latitude === "number" ? h.latitude : null,
        lon: typeof h.longitude === "number" ? h.longitude : null,
        offerId: rate.offerId, // see file header CONFIDENCE note — null if not found, never invented
        liteApiId: h.id, // raw LiteAPI id, unprefixed — lets the frontend re-request a single-hotel reprice later
      };
    });

  return { hotels, ratesRaw };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: {
    query?: string;
    nights?: number;
    count?: number;
    lat?: number;
    lon?: number;
    debug?: boolean;
    hotelId?: string;
    checkin?: string;
    checkout?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Single-hotel reprice mode: hotelId (raw LiteAPI id) skips the lat/lon
  // list search entirely, so lat/lon are only required when it's absent.
  const hotelId = typeof body.hotelId === "string" && body.hotelId.trim() ? body.hotelId.trim() : null;

  if (!hotelId && (typeof body.lat !== "number" || typeof body.lon !== "number")) {
    return new Response(JSON.stringify({ error: "lat and lon are required" }), {
      status: 400,
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

  const nights = Math.max(1, body.nights ?? 1);
  const limit = Math.min(20, Math.max(1, body.count ?? 20));

  // Explicit checkin/checkout override (YYYY-MM-DD), used by both modes when
  // provided; falls back to the original hardcoded "+7 days" default window
  // otherwise — unchanged from before this override existed.
  const overrideCheckIn = parseDateOnly(body.checkin);
  const overrideCheckOut = parseDateOnly(body.checkout);
  let checkIn: Date;
  let checkOut: Date;
  if (overrideCheckIn && overrideCheckOut) {
    checkIn = overrideCheckIn;
    checkOut = overrideCheckOut;
  } else {
    checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7); // app default when no explicit dates are given, matches the SerpApi function this replaces
    checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + nights);
  }

  // ---- Single-hotel reprice mode ----
  if (hotelId) {
    const { hotels, ratesRaw } = await priceHotels([{ id: hotelId }], checkIn, checkOut, apiKey);
    const responseBody: Record<string, unknown> = { source: "liteapi", hotels };
    if (body.debug) responseBody.raw = { rates: ratesRaw };
    return new Response(JSON.stringify(responseBody), { headers: { "Content-Type": "application/json" } });
  }

  // ---- List-mode (unchanged behavior, aside from the checkin/checkout override above) ----
  const headers = { "X-API-Key": apiKey, "Accept": "application/json" };

  const listQs = new URLSearchParams({
    latitude: String(body.lat),
    longitude: String(body.lon),
    distance: String(30_000), // 30km radius — reasonable spread for a destination-level search
    limit: String(limit),
  });

  // deno-lint-ignore no-explicit-any
  let listRaw: any;
  try {
    const listRes = await fetch(`${LITEAPI_HOTELS_URL}?${listQs}`, { headers });
    listRaw = await listRes.json();
    if (!listRes.ok) {
      return new Response(JSON.stringify({ error: `LiteAPI hotels error: ${listRes.status}`, detail: listRaw }), {
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

  const properties: LiteHotel[] = Array.isArray(listRaw?.data) ? listRaw.data : [];
  if (properties.length === 0) {
    const responseBody: Record<string, unknown> = { source: "liteapi", hotels: [] };
    if (body.debug) responseBody.raw = { list: listRaw };
    return new Response(JSON.stringify(responseBody), { headers: { "Content-Type": "application/json" } });
  }

  // Pricing is a second, separate call — hotels without a returned rate are
  // dropped rather than given a made-up price (see file header).
  const { hotels, ratesRaw } = await priceHotels(properties, checkIn, checkOut, apiKey);

  const responseBody: Record<string, unknown> = { source: "liteapi", hotels };
  if (body.debug) responseBody.raw = { list: listRaw, rates: ratesRaw };

  return new Response(JSON.stringify(responseBody), {
    headers: { "Content-Type": "application/json" },
  });
});
