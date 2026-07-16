import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/*
 * Sabre flight-search proxy — seam for the real Sabre GDS integration.
 *
 * REQUEST shape (buildBFMRequest) is built against a verified real
 * OTA_AirLowFareSearchRQ sample provided directly from Sabre's own
 * docs/examples.
 *
 * RESPONSE shape (parseBFMResponse) is now ALSO built against a verified
 * real groupedItineraryResponse sample (Sabre's modern JSON BFM response,
 * not the older OTA_AirLowFareSearchRS XML-derived shape) — see the
 * reference-table walk below. Confidence is genuinely high for both
 * request and response now.
 *
 * KNOWN GAP — currency: the verified response sample prices itineraries in
 * USD (totalFare.currency), but nothing in Graba's UI does currency
 * conversion — fmtR() just prefixes with "R" unconditionally. Real Sabre
 * prices will be silently mislabeled as ZAR until a conversion step is
 * added. currency is included on FlightOption so the frontend can at least
 * detect and handle this once wired in.
 *
 * The BFM endpoint PATH (SABRE_BFM_PATH) is still unverified — the exact
 * current path wasn't available when this was written. Defaults to a
 * best-guess, configurable via that secret.
 *
 * TOKEN EXCHANGE ENCODING — also uncertain (see getSabreToken): tries
 * standard single base64(id:secret) first, falls back to Sabre's
 * historically-documented double-encoding scheme if rejected.
 *
 * The OAuth2 client-credentials token exchange itself (POST /v2/auth/token,
 * Basic auth, grant_type=client_credentials) is a long-stable, well-known
 * Sabre pattern.
 *
 * Falls back to mock flights (same shape index.html's local genFlights()
 * produces) when SABRE_CLIENT_ID/SABRE_CLIENT_SECRET/SABRE_PCC aren't all
 * configured, so this stays testable without real credentials.
 *
 * CORS: called directly from the browser — see booking-hotel-search's
 * header for why this needs an explicit OPTIONS handler + CORS headers on
 * every response (a real, previously-undiagnosed bug affecting every
 * client-invoked function in this project, not specific to this one).
 *
 * Requires these edge function secrets for real Sabre calls (set manually
 * — no MCP tool here can set them):
 *   SABRE_CLIENT_ID, SABRE_CLIENT_SECRET — the User ID / Password from your
 *     Sabre Dev Studio "Applications" page
 *   SABRE_PCC — the Pseudo City Code assigned to your Sabre account/sandbox
 *   SABRE_BASE_URL — optional, defaults to https://api.cert.sabre.com (sandbox)
 *   SABRE_BFM_PATH — optional, defaults to a guessed path — VERIFY against
 *     Sabre Dev Studio's current Bargain Finder Max docs and override if wrong
 *   SABRE_REQUESTOR_COMPANY_CODE — optional, defaults to "TN" (as seen in
 *     the verified sample payload) — may be account-specific
 *
 * KNOWN GAP — origin airport: the Graba UI has no "flying from" selector
 * anywhere; originCode has to be supplied by the caller and defaults to
 * "JNB" if omitted, purely so this stays callable for testing.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SABRE_BASE_URL = Deno.env.get("SABRE_BASE_URL") ?? "https://api.cert.sabre.com";
// UNVERIFIED — see file header. Override via SABRE_BFM_PATH once confirmed.
const SABRE_BFM_PATH = Deno.env.get("SABRE_BFM_PATH") ?? "/v2.3.0/shop/flights";
const SABRE_REQUESTOR_COMPANY_CODE = Deno.env.get("SABRE_REQUESTOR_COMPANY_CODE") ?? "TN";

async function requestToken(basicAuthValue: string): Promise<Response> {
  return fetch(`${SABRE_BASE_URL}/v2/auth/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuthValue}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
}

// See TOKEN EXCHANGE ENCODING note in file header.
async function getSabreToken(clientId: string, clientSecret: string): Promise<{ token: string; encodingUsed: string }> {
  const singleEncoded = btoa(`${clientId}:${clientSecret}`);
  let res = await requestToken(singleEncoded);
  if (res.ok) {
    const data = await res.json();
    return { token: data.access_token as string, encodingUsed: "single" };
  }
  const singleFailureDetail = await res.text();

  const doubleEncoded = btoa(`${btoa(clientId)}:${btoa(clientSecret)}`);
  res = await requestToken(doubleEncoded);
  if (res.ok) {
    const data = await res.json();
    return { token: data.access_token as string, encodingUsed: "double" };
  }
  const doubleFailureDetail = await res.text();

  throw new Error(
    `Sabre auth failed with both encoding schemes. single: ${singleFailureDetail}; double: ${doubleFailureDetail}`,
  );
}

interface FlightOption {
  airline: string;
  time: string;
  duration: string;
  stops: string;
  price: number;
  currency: string; // see KNOWN GAP — currency in file header
}

interface SearchParams {
  originCode: string;
  destinationCode: string;
  departDateTime: string; // e.g. "2026-09-11T20:00:00"
  returnDateTime: string;
  pcc: string;
}

// Built against a verified real OTA_AirLowFareSearchRQ sample.
// deno-lint-ignore no-explicit-any
function buildBFMRequest(p: SearchParams): any {
  return {
    OTA_AirLowFareSearchRQ: {
      Version: "5",
      POS: {
        Source: [
          {
            PseudoCityCode: p.pcc,
            RequestorID: {
              Type: "1",
              ID: "1",
              CompanyName: { Code: SABRE_REQUESTOR_COMPANY_CODE },
            },
          },
        ],
      },
      OriginDestinationInformation: [
        {
          DepartureDateTime: p.departDateTime,
          OriginLocation: { LocationCode: p.originCode },
          DestinationLocation: { LocationCode: p.destinationCode },
        },
        {
          DepartureDateTime: p.returnDateTime,
          OriginLocation: { LocationCode: p.destinationCode },
          DestinationLocation: { LocationCode: p.originCode },
        },
      ],
      TravelerInfoSummary: {
        AirTravelerAvail: [
          {
            PassengerTypeQuantity: [{ Code: "ADT", Quantity: 1 }],
          },
        ],
      },
      TPA_Extensions: {
        IntelliSellTransaction: {
          RequestType: { Name: "50ITINS" },
        },
      },
    },
  };
}

// Built against a verified real groupedItineraryResponse sample. Walks the
// itineraryGroups -> itineraries -> legs(ref) -> legDescs -> schedules(ref)
// -> scheduleDescs reference chain to pull airline/time/duration/stops, and
// pricingInformation[0].fare.totalFare for price.
// deno-lint-ignore no-explicit-any
function parseBFMResponse(raw: any): FlightOption[] {
  const gir = raw?.groupedItineraryResponse;
  if (!gir) {
    throw new Error(
      "parseBFMResponse: no groupedItineraryResponse in response — shape differs from the verified sample, " +
      "pass debug:true to inspect the raw response",
    );
  }

  const errorMessages = (gir.messages ?? []).filter((m: any) => m.severity === "Error");
  if (errorMessages.length > 0) {
    throw new Error(`Sabre returned error messages: ${JSON.stringify(errorMessages)}`);
  }

  // deno-lint-ignore no-explicit-any
  const scheduleById = new Map<number, any>();
  for (const s of gir.scheduleDescs ?? []) scheduleById.set(s.id, s);
  // deno-lint-ignore no-explicit-any
  const legById = new Map<number, any>();
  for (const l of gir.legDescs ?? []) legById.set(l.id, l);

  // deno-lint-ignore no-explicit-any
  const itineraries = (gir.itineraryGroups ?? []).flatMap((g: any) => g.itineraries ?? []);
  if (itineraries.length === 0) {
    throw new Error("parseBFMResponse: groupedItineraryResponse had no itineraries");
  }

  // deno-lint-ignore no-explicit-any
  return itineraries.map((it: any): FlightOption => {
    const legs = (it.legs ?? [])
      // deno-lint-ignore no-explicit-any
      .map((l: any) => legById.get(l.ref))
      .filter(Boolean);
    const schedules = legs
      // deno-lint-ignore no-explicit-any
      .flatMap((leg: any) => (leg.schedules ?? []).map((s: any) => scheduleById.get(s.ref)))
      .filter(Boolean);

    const firstSchedule = schedules[0];
    // deno-lint-ignore no-explicit-any
    const totalElapsed = legs.reduce((sum: number, l: any) => sum + (l.elapsedTime ?? 0), 0);
    // deno-lint-ignore no-explicit-any
    const anyStops = schedules.some((s: any) => (s?.stopCount ?? 0) > 0);

    const totalFare = it.pricingInformation?.[0]?.fare?.totalFare;

    return {
      airline: firstSchedule?.carrier?.marketing ?? "Unknown",
      time: firstSchedule?.departure?.time ?? "",
      duration: `${Math.floor(totalElapsed / 60)}h ${totalElapsed % 60}m`,
      stops: anyStops ? "1 stop" : "Non-stop",
      price: Number(totalFare?.totalPrice ?? NaN),
      currency: totalFare?.currency ?? "USD",
    };
  });
}

const AIRLINES = ["Rockit Air", "SA Skyways", "Meridian Airways", "Coastal Jet", "Vantage Air"];
function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function genMockFlights(): FlightOption[] {
  const list: FlightOption[] = [];
  for (let i = 0; i < 4; i++) {
    list.push({
      airline: pick(AIRLINES),
      time: `${String(rand(5, 22)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`,
      duration: `${rand(1, 9)}h ${pick(["00", "15", "30", "45"])}m`,
      stops: rand(0, 10) > 7 ? "1 stop" : "Non-stop",
      price: rand(1800, 7600),
      currency: "ZAR",
    });
  }
  return list.sort((a, b) => a.price - b.price);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: {
    originCode?: string;
    destinationCode?: string;
    departDateTime?: string;
    returnDateTime?: string;
    debug?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const clientId = Deno.env.get("SABRE_CLIENT_ID");
  const clientSecret = Deno.env.get("SABRE_CLIENT_SECRET");
  const pcc = Deno.env.get("SABRE_PCC");

  if (!clientId || !clientSecret || !pcc) {
    return new Response(JSON.stringify({ source: "mock", flights: genMockFlights() }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!body.destinationCode || !body.departDateTime || !body.returnDateTime) {
    return new Response(
      JSON.stringify({ error: "destinationCode, departDateTime, and returnDateTime are required" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  try {
    const { token, encodingUsed } = await getSabreToken(clientId, clientSecret);
    const requestBody = buildBFMRequest({
      originCode: body.originCode ?? "JNB", // see KNOWN GAP — origin airport in file header
      destinationCode: body.destinationCode,
      departDateTime: body.departDateTime,
      returnDateTime: body.returnDateTime,
      pcc,
    });

    const res = await fetch(`${SABRE_BASE_URL}${SABRE_BFM_PATH}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const raw = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Sabre BFM error: ${res.status}`, detail: raw, sentRequest: requestBody, tokenEncodingUsed: encodingUsed }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const responseBody: Record<string, unknown> = { source: "sabre", tokenEncodingUsed: encodingUsed };
    try {
      responseBody.flights = parseBFMResponse(raw);
    } catch (parseErr) {
      responseBody.parseError = String(parseErr);
    }
    if (body.debug || responseBody.parseError) responseBody.raw = raw;

    return new Response(JSON.stringify(responseBody), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
