# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Graba** ("Making Travel Simple") — a single-file, client-only prototype of a travel booking app: search a destination on an interactive 3D globe, browse hotels on a live map, bundle a flight + hotel + transfers into one package, and pay from an in-app "Travel Wallet." Everything — markup, CSS, and JS — lives in `index.html`. There is no backend, build step, package manager, or test suite; it's opened directly in a browser.

The only external dependencies are loaded from CDN in `index.html`: Leaflet 1.9.4 (destination map/tiles) and, per-hotel, LoremFlickr photos with a Picsum fallback (`photoTag()`).

## Running it

Open `index.html` directly in a browser, or serve the directory statically (e.g. `python3 -m http.server`) if you need it under `http://` for map tiles/CORS. No install, build, lint, or test commands exist in this repo.

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
- **Travel Wallet & itinerary** (`topUpWallet`, `recordWalletTx`, `renderWalletView`, `renderTripsList`) — an in-memory wallet balance/transaction log and a "My Trips" list populated on booking confirmation.

### BRS traceability comments

Many blocks are annotated with comments referencing a Business Requirements Specification, e.g. `BRS Process 6.0`, `Value Streams M/N/O/P`, `Distinguishing Concept A/B/C/D/F/G`, `BRS §5.8.9-11`. These map specific code (wallet, split payment, search-radius expansion, prioritized availability, "never return zero availability") back to numbered requirements/sections in that external spec. Preserve these comments and their section references when touching the code they annotate — they're the link between behavior and the requirement it satisfies, not incidental documentation.

## State conventions worth knowing before editing

- All app state (`hotelPool`, `walletBalance`, `userPrefs`, `dismissedIds`, trips list, etc.) is plain top-level `let`/`const` — no store/reducer pattern. Functions read and mutate these globals directly.
- Hotel "dismiss" (swipe away in the belt) doesn't delete the hotel — it reprioritizes it out of view (see `BRS Distinguishing Concepts B.2.2 / B.3.1` near `attachSwipeDismiss`).
- Money is always South African Rand, formatted via `fmtR()`.
