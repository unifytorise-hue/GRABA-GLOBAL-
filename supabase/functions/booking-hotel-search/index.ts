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
 * Response contract is UNCHANGED from the SerpApi version it replaces:
 *   { source, hotels: [{id, name, type, pricePerNight, rating, currency, lat, lon}] }
 * — the frontend does not need to change field names.
 *
 * Requires a LITEAPI_KEY edge function secret — set via the Supabase
 * dashboard (Project Settings → Edge Functions → Secrets) or
 * `supabase secrets set LITEAPI_KEY=...`; there's no MCP tool that can set
 * this, so it has to be done directly by whoever holds the key.
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

function normaliseRating(h: LiteHotel): number | null {
  if (typeof h.stars === "number" && h.stars > 0) return h.stars;
  if (typeof h.rating === "number" && h.rating > 0) return Math.min(5, h.rating / 2);
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { query?: string; nights?: number; count?: number; lat?: number; lon?: number; debug?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (typeof body.lat !== "number" || typeof body.lon !== "number") {
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
  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 7); // app doesn't collect real travel dates yet; arbitrary near-future default, matches the SerpApi function this replaces
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + nights);

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
  const rateMap = new Map<string, { amount: number; currency: string }>();
  // deno-lint-ignore no-explicit-any
  let ratesRaw: any = null;
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
        if (typeof amount === "number" && Number.isFinite(amount)) {
          rateMap.set(r.hotelId, { amount: Math.round(amount), currency });
        }
      }
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
      };
    });

  const responseBody: Record<string, unknown> = { source: "liteapi", hotels };
  if (body.debug) responseBody.raw = { list: listRaw, rates: ratesRaw };

  return new Response(JSON.stringify(responseBody), {
    headers: { "Content-Type": "application/json" },
  });
});
