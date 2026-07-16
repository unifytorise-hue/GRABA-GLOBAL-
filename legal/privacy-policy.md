# Privacy Policy — Graba

> ⚠️ **DRAFT — NOT LEGAL ADVICE.** AI-generated starting point, not reviewed by a qualified attorney. Must be reviewed against South Africa's **Protection of Personal Information Act (POPIA)** before publication — POPIA has specific mandatory requirements (including registering an Information Officer with the Information Regulator) that this draft flags but does not itself satisfy. Every `[bracketed]` placeholder needs a real value.

**Last updated:** [DATE]

## 1. Who this policy covers

This policy explains how [LEGAL ENTITY NAME] ("Graba", "we", "us") collects, uses, and protects your personal information when you use the Graba platform. We are the "responsible party" for this data under POPIA.

**Information Officer:** [NAME], reachable at [EMAIL]. [ACTION ITEM: an Information Officer must be formally registered with the Information Regulator of South Africa — this is a legal requirement under POPIA, not optional, before processing personal information at scale.]

## 2. What we collect

- **Account data**: email address, and anything else you provide at signup.
- **Booking data**: traveller names, destination, dates, flight/hotel selections, payment amount and method (we do not store full card numbers — see Section 4).
- **Technical data**: standard web request metadata (IP address, browser type) collected by our hosting/infrastructure providers as part of normal operation.

We do not currently collect passport numbers, ID numbers, or other special/sensitive categories of personal information as defined by POPIA. **[If real flight/hotel booking is added later (Sabre EnhancedAirBook, hotel supplier APIs), that will very likely require collecting passport/ID data — this section and the lawful-basis analysis below must be revisited before that happens.]**

## 3. How we use it

- To create and manage your account.
- To search, price, and process bookings on your behalf with third-party suppliers.
- To process payment for your bookings.
- To communicate with you about your bookings (confirmations, changes, support).
- [To send marketing communications, if applicable — requires separate opt-in consent under POPIA; do not bundle with the above.]

## 4. Who we share it with

We share the minimum necessary data with:

- **Payment processor** (Paystack) — to process payment for your bookings. We do not receive or store your full card number; the payment processor handles card data directly (PCI DSS compliance is the payment processor's responsibility for the card-data portion of the flow, not ours, provided we use their hosted checkout as designed).
- **Flight search/booking supplier** (Sabre) — to search and, in future, book flights on your behalf.
- **Hotel search/booking supplier** (LiteAPI) — to search, price, and reserve hotel rooms on your behalf.
- **AI concierge provider** (Anthropic, for the in-app "Gabriella" chat assistant) — your chat messages are sent to Anthropic to generate a response; Gabriella can search flights/hotels on your behalf but cannot book or charge anything without you separately confirming in the app.
- **Our infrastructure/hosting provider** (Supabase) — as a data processor storing account and booking data on our behalf, under their own data processing terms.

We do not sell your personal information.

## 5. Where your data is stored

Our database infrastructure is hosted in [Supabase's eu-west-1 (Ireland) region]. **[If any users are South African data subjects — which they will be — POPIA's cross-border transfer rules (Section 72) apply to storing data outside South Africa; this needs attorney review to confirm the transfer is lawful, e.g. via adequate safeguards or the recipient jurisdiction's data protection law providing adequate protection.]**

## 6. Your rights

Under POPIA, you have the right to:

- Access the personal information we hold about you.
- Request correction of inaccurate information.
- Request deletion of your information, subject to our legal obligation to retain booking/financial records for [tax/statutory retention period — confirm with attorney/accountant].
- Object to processing in certain circumstances.
- Lodge a complaint with the Information Regulator of South Africa if you believe we've mishandled your data.

To exercise these rights, contact [PRIVACY EMAIL].

## 7. Security

We use industry-standard measures to protect your data, including row-level access controls on our database (each user can only access their own records) and encrypted connections (HTTPS/TLS) throughout. No system is 100% secure, and we cannot guarantee absolute security.

## 8. Cookies

[Describe actual cookie/local-storage usage once implemented — currently Graba uses browser storage for session/auth tokens via Supabase Auth. Add a cookie table if analytics/marketing cookies are added later.]

## 9. Changes to this policy

We may update this policy from time to time; material changes will be [communicated via email / an in-app notice].

## 10. Contact

[LEGAL ENTITY NAME]
Information Officer: [NAME], [EMAIL]
[ADDRESS]
