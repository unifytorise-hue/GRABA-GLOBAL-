# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Graba** ("Making Travel Simple") — a travel booking app: search a destination on an interactive 3D globe, browse hotels on a live map, bundle a flight + hotel + transfers into one package, and pay from an in-app "Travel Wallet." All markup, CSS, and JS still lives in one `index.html` (no build step, bundler, or framework), but auth and money now live in a real backend rather than in-memory state — see "Backend" below. There is no test suite; the app is opened directly in a browser or served statically.

External dependencies loaded from CDN in `index.html`: Leaflet 1.9.4 (destination map/tiles), the Supabase JS SDK v2, and per-hotel LoremFlickr photos with a Picsum fallback (`photoTag()`).

Flight/hotel inventory is still procedurally generated mock data (see Architecture below). The plan is Sabre for flights (Bargain Finder Max for search, EnhancedAirBook for PNR creation) and Booking.com Partner/Demand API for hotels — chosen over routing hotels through Sabre too, since Sabre's hotel content/booking certification is a separate, weaker path than its flight product. Both are blocked on the respective partner accounts; see the edge functions below for the current seams.

## Backend (Supabase)

Auth, wallet balance, and bookings are backed by a dedicated Supabase project **"Graba Global"** (`mpkklamqfjwfuciuuxae`, eu-west-1) — separate from the unrelated AestheticFlow CRM project in the same org. Schema:

- `profiles` / `wallets` — 1:1 with `auth.users`, auto-created by an `on_auth_user_created` trigger (`handle_new_user()`) on signup.
- `wallet_transactions` — append-only ledger, one row per top-up/debit.
- `bookings` — one row per confirmed trip; flight/hotel/transfer details are stored in a `details jsonb` column shaped to match a real Sabre response, so swapping mock data for live Sabre PNR data later won't need a schema change.

All tables are RLS-scoped to `auth.uid()` (SELECT only from the client — no direct client-side balance/booking mutation). Balance changes and booking creation go through `security definer` RPCs instead (`anon`/`authenticated` execute is explicitly revoked by default and re-granted only where intended, since Postgres/Supabase grants `EXECUTE` to `anon` by default on new functions):

- `top_up_wallet(p_amount, p_note)` — **superseded, no longer client-callable.** Originally credited the caller's own wallet instantly with no real charge behind it (a demo placeholder); `authenticated`'s execute was revoked once Stripe payments were wired (see Payments below), since leaving it open would let anyone give themselves free wallet balance. Left in place (unused) rather than dropped, in case it's useful for a future admin tool.
- `admin_top_up_wallet(p_user_id, p_amount, p_note)` — the real replacement. `service_role`-only (not `authenticated`, not `anon`) — only callable by the `stripe-webhook` edge function after it has verified a real Stripe payment. See Payments below.
- `book_trip(p_destination_city, p_destination_country, p_traveller_name, p_nights, p_payment_method, p_total_amount, p_wallet_portion, p_details)` — debits the wallet portion (if any), checks sufficient balance, and inserts the booking, atomically. Generates its own `booking_ref` (`GRB-XXXXXXXX`).
- `add_insurance(p_booking_id)` — idempotently adds R150 to an existing booking's total and flags `details->>'insurance'`.

In `index.html`, `loadWalletAndTrips()` re-fetches wallet + transactions + bookings after every mutating RPC call and re-renders; there's no realtime subscription. `sb.auth.onAuthStateChange` drives the `#authOverlay` gate (email/password sign-in/sign-up) — the app is unusable until a session exists.

Client-side `SUPABASE_URL`/`SUPABASE_ANON_KEY` in `index.html` are the anon key — safe to expose, since every table relies on RLS + the RPCs above rather than trusting the client.

### AI concierge (Claude)

`concierge-chat` is a chat-based "AI travel concierge" — a Claude tool-use loop (Anthropic Messages API) over Graba's own capabilities, surfaced via the "✦ Ask Graba" chip on the globe view (`#conciergeOverlay` in `index.html`, `sendConciergeMessage()`/`openConcierge()`).

- **Tools exposed to Claude**: `search_flights` and `search_hotels` (server-to-server HTTP calls to the sibling `sabre-flight-search`/`booking-hotel-search` edge functions, using the service role key — they inherit those functions' own mock-data fallback behavior), `get_wallet_balance` (direct query), and `propose_booking`.
- **Guardrail — do not relax without discussion**: `propose_booking` is a pure pass-through that returns a structured proposal for the frontend to render; it does **not** call `book_trip`. Nothing in this function can spend money or create a real booking — the user still has to go through the existing package-builder modal and tap Confirm. This is deliberate: an LLM autonomously committing bookings/payments with no human confirmation step is not a safe default. The system prompt also explicitly tells Claude never to claim something is booked/charged.
- The frontend keeps the full Claude message history (`conciergeMessages`, including tool-use/tool-result blocks) client-side and resends it each turn — there's no server-side conversation persistence.
- **Confidence**: HIGH on the Claude/Anthropic API shape itself (Anthropic's own documented API, unlike the Sabre/SerpApi work), but this has **not** been tested end-to-end from this sandbox (no live Anthropic API access here either) — verify a real conversation once `ANTHROPIC_API_KEY` is set.
- Requires an `ANTHROPIC_API_KEY` edge function secret (console.anthropic.com) and, optionally, `CLAUDE_MODEL` to override the default (`claude-sonnet-5`).

### Payments (Stripe)

Real money moves through **Stripe Checkout**, wired into the wallet top-up flow (`topUpWallet()` in `index.html`, both the preset chips and the custom-amount input). Two edge functions:

- **`create-checkout-session`** (`verify_jwt: true`) — called by a signed-in user with `{amount}`; creates a Stripe Checkout session tagged with their user id (`metadata.user_id` / `client_reference_id`) and returns the session URL, which the frontend redirects to (`window.location.href = data.url`). Requires `STRIPE_SECRET_KEY`; falls back to a clear error (not mock data) if unconfigured, since there's no safe fallback for real payments the way there is for search.
- **`stripe-webhook`** (`verify_jwt: false` — deliberately, since Stripe calls it directly with no Supabase session, authenticating instead via the `stripe-signature` header against `STRIPE_WEBHOOK_SECRET`) — the **only** path that actually credits a wallet. On `checkout.session.completed`, calls `admin_top_up_wallet` via the service role key, using the user id from the session's metadata. Deduplicates via a `stripe_events` table (event id as primary key) since Stripe can redeliver the same webhook more than once.
- Requires edge function secrets: `STRIPE_SECRET_KEY` (both functions), `STRIPE_WEBHOOK_SECRET` (webhook only, from registering the webhook's URL in the Stripe dashboard against `checkout.session.completed`), optionally `SITE_URL` (defaults to the GitHub Pages URL) for the Checkout success/cancel redirect targets. `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the platform, no need to set them.
- After a successful Stripe redirect back to the app (`?topup=success`), `handleStripeRedirect()` polls `loadWalletAndTrips()` a few times (webhook delivery can lag the browser redirect slightly) before opening the wallet view.
- **Confidence**: Stripe's Checkout + webhook-signature pattern is stable and mainstream — higher confidence than the Sabre/Booking.com/SerpApi integrations elsewhere in this file — but still **untested against a real Stripe account** from this environment (no live Stripe access here). Verify a real test-mode payment end-to-end once `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are set.
- Currency: hardcoded to `zar` in `create-checkout-session`. Confirm the Stripe account can actually accept ZAR charges/payouts once real keys exist — Stripe's direct availability for South African merchants is more limited than payment processors like Paystack or Yoco, which was flagged before Stripe was chosen.

### Flight/hotel edge functions

Two edge functions are deployed on the Graba Global project as seams for real inventory. **Hotels are wired into the frontend; flights are not yet.** This project was built in a sandboxed environment that couldn't reach the Supabase project's own HTTP endpoint (only the Supabase MCP tools were reachable), so **neither wiring has been tested end-to-end in a real browser** — verify both before relying on them. The hotel wiring was still done (unlike flights) because it degrades safely: `fetchHotels()` falls back to the local mock on any error, so a broken call just silently reverts to old behavior rather than breaking the map view.

- **Hotels** (`fetchHotels()` / `adaptSerpApiHotel()`, called from `showMapView()`) — calls `booking-hotel-search` (SerpApi) with `{query: "<city>, <country>", nights, count}`, adapts its `{id,name,type,pricePerNight,rating,currency,lat,lon}` shape into the full internal hotel shape (`x`/`y` percentage-space coords are derived by inverting `genHotels()`'s own lat/lon formula; `scene`, `rooms`, `supplierPriority`, `profitPct` have no real-world source so stay randomised even for real hotels — the last three are Graba's own invented business-logic weights, not something any real API would provide). On any error, empty result, or exception, falls back to `genHotels()` mock data — the map view never breaks even if SerpApi/the edge function is down. `showMapView()` is now `async`; it shows "Searching…" in the belt label while the fetch is in flight and guards against a destination change landing a stale response. `loadMoreBelt()`'s infinite-scroll padding still uses local mock data unconditionally (deliberate — avoids burning SerpApi quota on scroll, and blends real initial results with the app's existing "never zero availability" padding).
- **Flights** (`sabre-flight-search`) — still not called by the frontend at all; `index.html` uses local `genFlights()` directly. Wire `openPackageModal`/`shuffleFlights` to it once Sabre credentials are sorted and this has been tested for real (see the section below).

- **`sabre-flight-search`** (v6) — does the Sabre OAuth2 token exchange, then calls Bargain Finder Max. Both request and response are now built against verified real samples:
  - **Request** (`buildBFMRequest()`) — built against a *verified real* `OTA_AirLowFareSearchRQ` sample provided directly from Sabre's own docs.
  - **Response** (`parseBFMResponse()`) — built against a *verified real* `groupedItineraryResponse` sample (Sabre's modern JSON BFM response, not the older XML-derived `OTA_AirLowFareSearchRS` shape). Walks the reference-ID chain: `itineraryGroups[].itineraries[].legs[].ref` → `legDescs[]` → `schedules[].ref` → `scheduleDescs[]` for airline/time/duration/stops, and `pricingInformation[0].fare.totalFare` for price. Also checks `messages` for `severity: "Error"` entries and surfaces them. Pass `{"debug": true}` to always get the raw response back for comparison regardless.
  - **Known gap — currency**: the verified response sample prices in USD (`totalFare.currency`), but nothing in Graba's UI does currency conversion — `fmtR()` just prefixes with "R" unconditionally. Real Sabre prices will be silently mislabeled as ZAR until a conversion step is added. `FlightOption` now carries a `currency` field so the frontend can at least detect this once wired in.
  - **Token exchange encoding** (`getSabreToken()`) — `SABRE_CLIENT_ID`/`SABRE_CLIENT_SECRET` are the raw "User ID"/"Password" from Sabre Dev Studio's Applications page (format `V1:xxxxxxxxxxxx:DEVCENTER:EXT`). Standard OAuth2 Basic auth is a single `base64(id:secret)`, but Sabre has historically documented a Sabre-specific *double*-encoding scheme for this exact credential pair — recalled with moderate confidence, not verified. The function tries single-encoding first and automatically falls back to double-encoding if rejected; whichever worked is reported back as `tokenEncodingUsed`.
  - **Endpoint path** (`SABRE_BFM_PATH`) — still unverified, defaults to a guessed `/v2.3.0/shop/flights`; override via that secret once the real path is confirmed from Sabre Dev Studio docs.
  - Requires `SABRE_CLIENT_ID`, `SABRE_CLIENT_SECRET`, and `SABRE_PCC` (your account's Pseudo City Code) as edge function secrets — falls back to mock flights (`genFlights()`-shaped) if any are missing.
  - **Origin airport**: `index.html` now has a real "Flying from" `<select>` in the package builder modal (populated from `DESTINATIONS`, defaulting to Johannesburg/`JNB` — global `originCode`/`originCity`), so this is no longer nonexistent. It's just not plumbed into an actual `sabre-flight-search` call yet, since the frontend doesn't call that function at all (see above).
  - Booking a selected flight into a PNR would additionally need EnhancedAirBook, not yet stubbed anywhere.
- **`booking-hotel-search`** (v2 — despite the name, no longer targets Booking.com) — hotel *search/price display* via **SerpApi's `google_hotels` engine** (https://serpapi.com/google-hotels-api), reading a `SERPAPI_KEY` edge function secret. This is search-only — SerpApi scrapes Google Hotels results, it does not create real reservations. A genuine booking step (PNR-equivalent for hotels) still needs a real supplier/OTA integration (e.g. Booking.com Partner API) later; that plan hasn't changed, this function just covers the search step for now since a working SerpApi key was available and Booking.com partner access wasn't. Field mapping in `mapProperty()` is written from memory of SerpApi's docs (not verified live — `serpapi.com` is blocked by this sandbox's egress policy) — pass `{"debug": true}` in the request body to get the raw SerpApi response back alongside the mapped hotels, to check/fix the mapping against real output. **`SERPAPI_KEY` must be set manually** (Supabase dashboard → Project Settings → Edge Functions → Secrets, or `supabase secrets set`) — no MCP tool here can set edge function secrets.

## Legal (`/legal/`)

`terms-of-service.md`, `privacy-policy.md`, and `refund-policy.md` are **AI-drafted starting points, not reviewed by a qualified attorney**, written to save drafting time — each has a prominent banner saying so and is full of `[bracketed]` placeholders (legal entity name, registration number, retention periods, etc.). They flag several points that specifically need South African legal review before publishing to real customers: CPA Section 51 liability-limitation restrictions, POPIA's Information Officer registration requirement and cross-border transfer rules (data is hosted in Supabase's `eu-west-1`/Ireland region), and how CPA cooling-off rights interact with dated travel bookings. Do not treat these as ready to publish.

## Running it

Open `index.html` directly in a browser, or serve the directory statically (e.g. `python3 -m http.server`) if you need it under `http://` for map tiles/CORS. No install, build, lint, or test commands exist in this repo. To change the backend schema, use the Supabase MCP tools / dashboard against the `mpkklamqfjwfuciuuxae` project — there are no local migration files checked in.

## Architecture (all in `index.html`)

The app is a single-page state machine over a handful of full-screen overlay `<div>`s (`#globeUI`/`#globeCanvas`, `#mapView`, `#tripsView`, `#walletOverlay`, `#modalOverlay`, `#confirmOverlay`), toggled via `display` by functions like `showMapView()`, `showTripsView()`, `openWallet()`, `openPackageModal()`. There's no framework/router — plain DOM queries and `on*` handlers wired at the bottom of the `<script>`.

Reading top to bottom, the script is organized into these blocks (search for the `/* ==== ... ==== */` banner comments to jump between them):

- **Mock inventory** (`DESTINATIONS`, `genHotels`, `genFlights`, `genHotelName`) — all destinations/hotels/flights are procedurally generated, not fetched. Comments note the data shapes are meant to be swappable for real GDS/Google Business Profile feeds without touching UI code.
- **Hotel "photos"** (`buildSceneSVG`, `photoTag`) — inline SVG illustrations as instant placeholders, with `photoTag()` layering on a real LoremFlickr photo (seeded by hotel id) that falls back to Picsum on error.
- **Globe rendering** — a hand-rolled Canvas 2D 3D globe with no external map library: continents are a bit-packed base64 land/sea bitmap (`LAND_MASK_B64`, sampled via `sampleLand`), re-projected per-pixel each frame (`renderGlobeRaster`, `drawGlobe`, `animate`). Search box + Levenshtein fuzzy matching (`findPlace`, `findNearestPlace`) resolve free-text input to a `DESTINATIONS` entry or the nearest known place.
- **Destination map view** — switches to real tiles via Leaflet (`initLeafletMap`), with pins for generated hotels, filter chips by property type, and a "search radius" ring.
- **Van Der Belt prioritized-availability engine** (`computePriorityScore`, `reprioritiseUnshown`) — a weighted scoring model (`MASTER_WEIGHTS`: customer/profit/service/supplier) that reorders the hotel results shown in the belt/map based on session-learned preferences (`notePreference`), while never showing zero results.
- **Search radius expansion** (`RADIUS_MIN/STEP/MAX`, `applyRadiusFilter`) — widens the search ring in steps until `MIN_RESULTS` hotels are found for the active filter.
- **Package builder modal** (`openPackageModal`, `renderFlights`, `updateTotal`) — lets the user pick nights/flight/payment method for a chosen hotel and computes the combined flight+stay+transfers total.
- **Travel Wallet & itinerary** (`topUpWallet`, `loadWalletAndTrips`, `renderWalletView`, `renderTripsList`) — wallet balance/transaction log and "My Trips" list, backed by Supabase (see Backend above) and refreshed after every mutation.

### BRS traceability comments

Many blocks are annotated with comments referencing a Business Requirements Specification, e.g. `BRS Process 6.0`, `Value Streams M/N/O/P`, `Distinguishing Concept A/B/C/D/F/G`, `BRS §5.8.9-11`. These map specific code (wallet, split payment, search-radius expansion, prioritized availability, "never return zero availability") back to numbered requirements/sections in that external spec. Preserve these comments and their section references when touching the code they annotate — they're the link between behavior and the requirement it satisfies, not incidental documentation.

## State conventions worth knowing before editing

- All app state (`hotelPool`, `walletBalance`, `userPrefs`, `dismissedIds`, `myTrips`, etc.) is plain top-level `let`/`const` — no store/reducer pattern. Functions read and mutate these globals directly. `walletBalance`/`walletTx`/`myTrips` specifically are a client-side cache refreshed wholesale from Supabase by `loadWalletAndTrips()`, not the source of truth.
- Hotel "dismiss" (swipe away in the belt) doesn't delete the hotel — it reprioritizes it out of view (see `BRS Distinguishing Concepts B.2.2 / B.3.1` near `attachSwipeDismiss`). This is unrelated to and unaffected by the Supabase backend.
- Money is always South African Rand, formatted via `fmtR()`.
