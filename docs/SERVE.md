# Serve: table ordering alongside the till

Serve lets guests order and ask for the bill from their phones while the restaurant keeps its existing till (Pilot, GAAP, Lightspeed and others). The till stays the system of record for payment: Serve takes the order to the kitchen and bar, tracks the tab and split bills, and pushes every step to the till.

```
Guest phone ──scan table QR/NFC──> guest session on the table's tab
     │ orders                                     │ "pay my items / rest / a share"
     v                                            v
 order items ──> kitchen screen / bar screen   payment request ──> waiter brings the card machine
     │ (stock deducted)  (live updates)                              │ records it with the till slip number
     v                                                               v
 till webhook: order.placed ... payment.recorded ... tab.closed   tip -> waiter (QR code or table assignment)
```

## How a table works

1. **Scan.** Each table has a QR code or NFC tag (`POST /v1/tables/:id/tags`). Scanning opens the table's tab, or joins it if someone at the table already scanned. Each guest gets their own session, so the bill can show "your items".
2. **Confirm.** The first order on a new tab waits until a waiter taps *confirm* (`POST /v1/tabs/:id/confirm`). This stops orders from someone who photographed the code from home. Turn it off per location with `locations.require_tab_confirmation`.
3. **Route.** Each menu item belongs to a station: `kitchen` or `bar`. Items appear on that station's screen (`GET /v1/stations/:station/queue`) and update live (`GET /v1/stations/:station/stream`). Staff move items through `preparing → ready → served`. Only managers can void, and voiding returns the stock.
4. **Stock.** Each menu item lists what it uses (1 rump steak, or 0.200 kg of mince). Ordering deducts stock in the same transaction. When something runs out, it shows as sold out and further orders are refused. Managers record deliveries, stock-takes and waste.
5. **Pay.** A guest asks to pay their own items, the whole remaining bill, or an equal share. The request claims those items or that amount, so two people can never pay for the same thing. The waiter takes the money on the till's card machine and records it with the till slip number. The tab closes automatically once fully paid, or a waiter can close it with the till reference if it was settled at the till directly.
6. **Tip.** The guest adds a tip when asking to pay. It goes to the waiter whose personal tip QR code they scanned, otherwise to the waiter assigned to that table at that moment, otherwise to the tip pool. Tips are recorded as card tips in the existing tip module, so they reach payroll and stay outside the minimum wage test.

Prices on the menu include VAT. The bill shows the VAT included, at 15% (a dated rule version).

## The screens (`apps/web`)

| Address | Who | What it does |
| --- | --- | --- |
| `/t/<table code>` | Guests | The table's QR or NFC code opens this: menu, order, bill with "yours" marked, pay (own items, whole bill, equal split) with a tip |
| `/tip/<tip code>` | Guests | A waiter's tip QR code; the tip goes to that waiter when the guest pays |
| `/staff/floor` | Waiters | Tables needing action first: confirm new tables, bring the card machine (amount and tip), record the till slip number, close tables paid at the till |
| `/staff/station/kitchen` and `/staff/station/bar` | Kitchen, bar | A live docket rail: one ticket per order, oldest first, turning saffron after 10 minutes and red after 20; Start, Ready, Collected |

Design notes:

- **Phones on prepaid data:** guests download about 60 KB of script, with fonts bundled (no Google Fonts call). The staff screens and sign-in code load only on `/staff`.
- **Connection drops:** orders are retried with the same key, so nothing is sent twice. The bill refreshes every 15 seconds.
- **Kitchen and bar screens:** they reconnect to the live stream on their own and also poll every 30 seconds as a fallback.

Staff sign in with Auth0 (configure `VITE_AUTH0_*`). Without Auth0, in local development, they paste a development token, for example one from `pnpm demo`.

## Guest app API

The guest app (a web page the QR code opens) calls these without logging in. After the first call, it sends the session token in the `X-Guest-Session` header.

| Call | Purpose |
| --- | --- |
| `POST /v1/guest/sessions` `{ tagToken }` | Start or join the table's tab; returns `sessionToken` (valid 6 hours or until the tab closes) |
| `GET /v1/guest/menu` | Categories and items, with `soldOut` flags |
| `POST /v1/guest/orders` + `Idempotency-Key` | Order items (safe to retry on a bad connection) |
| `GET /v1/guest/tab` | The bill: lines (with `mine`), total, VAT, outstanding, your subtotal |
| `GET /v1/guest/tip-codes/:token` | Name of the waiter whose tip code was scanned |
| `POST /v1/guest/payments` `{ mode, itemIds?, parts?, tipCents, tipCode? }` | Ask to pay: `items`, `remaining` or `share` |
| `GET /v1/guest/payments` | Status of the table's payment requests |

Guests run in their own database role, limited to their own tab. They cannot read staff, stock, tips or any other table, even if an API bug tried to.

## Till webhook contract

Set it up as the owner: `PUT /v1/till-integration` with `{ "mode": "webhook", "webhookUrl": "https://...", "signingSecret": "<32+ chars>" }`. Use `{ "mode": "manual" }` to turn it off; staff then key orders into the till and enter the slip number when closing the tab.

Each event is a `POST` to your URL:

```
X-SaasRsa-Event:     order.placed
X-SaasRsa-Delivery:  <event id>   (repeats on retry; use it to ignore duplicates)
X-SaasRsa-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>

{ "id": "...", "type": "order.placed", "createdAt": "...", "orgId": "...", "data": { ... } }
```

| Event | `data` |
| --- | --- |
| `tab.opened` | `tabId`, `table` |
| `order.placed` | `tabId`, `tillReference`, `table`, `orderId`, `items[]` with `tillCode` (the item's PLU on the till), `name`, `quantity`, `unitPriceCents`, `station`, `notes` |
| `item.voided` | `tabId`, `orderItemId`, `reason` |
| `payment.recorded` | `tabId`, `paymentId`, `amountCents`, `tipCents`, `tillReference` |
| `tab.closed` | `tabId`, `tillReference` |

Verify the signature and reject timestamps older than 5 minutes; `verifyTillSignature` in `apps/worker/src/till.ts` is a reference implementation. Return any 2xx. Failed deliveries retry with backoff for up to 8 attempts, and each event's status is kept in `till_events`.

Most South African tills don't accept webhooks directly. In practice this URL points at a small adapter for the restaurant's till vendor, or at the vendor's own integration service. Adapters for specific tills are the next integration step.

## Not built yet

- Online card payment in the guest app (a hosted checkout such as Yoco, Peach Payments or Paystack); today payment is always taken on the till's card machine.
- Face verification at clock-in: needs a vendor decision, liveness detection, and POPIA consent for biometrics. Clock-in already checks location.
- Adapters for specific till vendors.
