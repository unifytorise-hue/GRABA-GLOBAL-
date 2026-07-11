# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Graba** ("Making Travel Simple") — a travel booking app: search a destination on an interactive 3D globe, browse hotels on a live map, bundle a flight + hotel + transfers into one package, and pay from an in-app "Travel Wallet." All markup, CSS, and JS still lives in one `index.html` (no build step, bundler, or framework), but auth and money now live in a real backend rather than in-memory state — see "Backend" below. There is no test suite; the app is opened directly in a browser or served statically.

External dependencies loaded from CDN in `index.html`: Leaflet 1.9.4 (destination map/tiles), the Supabase JS SDK v2, and per-hotel LoremFlickr photos with a Picsum fallback (`photoTag()`).

Flight/hotel inventory is still procedurally generated mock data (see Architecture below) — Sabre GDS integration is planned but not yet wired up (blocked on a Sabre Dev Studio sandbox account).

## Backend (Supabase)

Auth, wallet balance, and bookings are backed by a dedicated Supabase project **"Graba Global"** (`mpkklamqfjwfuciuuxae`, eu-west-1) — separate from the unrelated AestheticFlow CRM project in the same org. Schema:

- `profiles` / `wallets` — 1:1 with `auth.users`, auto-created by an `on_auth_user_created` trigger (`handle_new_user()`) on signup.
- `wallet_transactions` — append-only ledger, one row per top-up/debit.
- `bookings` — one row per confirmed trip; flight/hotel/transfer details are stored in a `details jsonb` column shaped to match a real Sabre response, so swapping mock data for live Sabre PNR data later won't need a schema change.

All four tables are RLS-scoped to `auth.uid()` (SELECT only from the client — no direct client-side balance/booking mutation). Balance changes and booking creation go through three `security definer` RPCs instead, each restricted to the `authenticated` role (`anon` execute is explicitly revoked, since Postgres/Supabase grants `EXECUTE` to `anon` by default on new functions):

- `top_up_wallet(p_amount, p_note)` — credits the caller's own wallet + logs the transaction, atomically.
- `book_trip(p_destination_city, p_destination_country, p_traveller_name, p_nights, p_payment_method, p_total_amount, p_wallet_portion, p_details)` — debits the wallet portion (if any), checks sufficient balance, and inserts the booking, atomically. Generates its own `booking_ref` (`GRB-XXXXXXXX`).
- `add_insurance(p_booking_id)` — idempotently adds R150 to an existing booking's total and flags `details->>'insurance'`.

In `index.html`, `loadWalletAndTrips()` re-fetches wallet + transactions + bookings after every mutating RPC call and re-renders; there's no realtime subscription. `sb.auth.onAuthStateChange` drives the `#authOverlay` gate (email/password sign-in/sign-up) — the app is unusable until a session exists.

Client-side `SUPABASE_URL`/`SUPABASE_ANON_KEY` in `index.html` are the anon key — safe to expose, since every table relies on RLS + the RPCs above rather than trusting the client.

### Sabre edge function (not yet wired into the frontend)

An edge function, `sabre-flight-search`, is deployed on the Graba Global project as the intended seam for real Sabre GDS flight search — it does the Sabre OAuth2 token exchange when `SABRE_CLIENT_ID`/`SABRE_CLIENT_SECRET` secrets are set, and currently throws a clear "not implemented" error past that point (the real Bargain Finder Max request/response mapping needs to be verified against Sabre Dev Studio's live docs before writing it — don't trust a schema written from memory). Until then it returns mock flights in the same shape `index.html`'s local `genFlights()` produces.

**The frontend still calls local `genFlights()` directly and does not invoke this edge function.** That's deliberate, not an oversight: this project was built in a sandboxed environment that couldn't reach the Supabase project's own HTTP endpoint (only the Supabase MCP tools were reachable), so the edge function's invocation path was never actually tested end-to-end. Wire `openPackageModal`/`shuffleFlights` to call it (via `sb.functions.invoke('sabre-flight-search', ...)`) once you can verify it works in a real browser — swapping a working local mock for an unverified network call isn't a safe default.

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
