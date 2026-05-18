# Apple Mac Monitor Server Design

## Goal

Build a split Apple refurbished Mac monitoring system:

- Server deployment on Tencent Cloud OpenCloudOS 9 for discovery, dashboard, rules, history, Tencent Cloud SMS, and Telegram alerts.
- Local Windows script for aggressive desktop actions such as opening the Apple page, desktop notifications, topmost strong prompts, and beeps.
- Local dev mode for testing the server stack without sending real SMS.

The first supported product family is Apple China official refurbished Mac Studio. Product discovery and filtering must be deterministic script logic, not AI-based recognition.

## Deployment Modes

### Server Mode

Runs on Tencent Cloud OpenCloudOS 9 using Docker Compose.

Responsibilities:

- Scan Apple China official refurbished Mac pages.
- Discover all refurbished Mac Studio product targets.
- Fetch product detail pages for exact deterministic specification parsing.
- Persist product state, availability, price, scan history, and alert history.
- Evaluate user-defined alert rules.
- Send Tencent Cloud SMS and Telegram alerts for matching products.
- Serve a web dashboard for status, rules, products, SMS testing, and Telegram testing.
- Expose a local script event API.

The server does not open browser pages or create Windows desktop popups.

### Local Script Mode

Runs on the user's Windows machine.

Responsibilities:

- Receive or poll server alert events.
- Open Apple product pages once per availability window.
- Show Windows desktop notifications.
- Produce stronger local prompts and beeps.
- Optionally retain manual URL fallback monitoring for server outages.

The local script does not own the canonical discovery rules and does not send SMS or Telegram alerts.

Strong popup behavior:

- Implemented in PowerShell with WinForms or WPF.
- Window is `TopMost`.
- Shows product title, price, matching rule, and product URL.
- Provides `Open product page` and `Acknowledge` actions.
- Can loop beeps until the user acknowledges.
- Does not repeatedly open browser tabs during the same availability window.
- Cannot bypass Windows lock screen or secure desktop, so it is intended for an active logged-in desktop session.

### Local Dev Mode

Runs the server stack locally for development and parser verification.

Responsibilities:

- Run web, API, worker, and database services locally.
- Use dry-run SMS and Telegram by default.
- Allow parser and rule tests before deploying to Tencent Cloud.

## Product Discovery

Discovery is intentionally split from alerting.

The discovery worker must first find all official Apple refurbished Mac Studio targets. It should not discard products because they do not match the current alert rule.

Discovery sources:

- Initial global Apple China refurbished Mac Studio listing page: `https://www.apple.com.cn/shop/refurbished/mac/mac-studio`.
- Apple China Mac Studio filtered refurbished listing pages when available.
- Initial independent manual monitoring product page: `https://www.apple.com.cn/shop/product/g1cepch/a`.
- Manually configured product URLs as a fallback and priority watchlist.

Discovery implementation requirements:

- Store canonical source URLs in configuration.
- Store saved fixtures under `server/test/fixtures/apple/`, starting with `mac-studio-listing.html` and `g1cepch-detail.html`.
- Normalize Apple product URLs to lowercase product IDs, for example `g1cepch-a`.
- Handle pagination or infinite-list payloads if Apple changes listing shape.
- Keep products that disappear from listing pages, marking them `lastSeenAt` stale instead of deleting them.
- Use saved HTML fixtures for listing and detail parsing regression tests.
- Apply request pacing and a small concurrency limit so the server does not hammer Apple pages.

Discovery output per product:

- `productId`, derived from the Apple product URL, for example `g1cepch-a`.
- `url`.
- `title`.
- `priceText`.
- `availabilityStatus`, one of `available`, `unavailable`, or `unknown`.
- `available`, derived from `availabilityStatus === "available"` for UI convenience.
- `source`, such as `listing` or `manual`.
- `firstSeenAt`.
- `lastSeenAt`.
- `offerFingerprint`, derived from normalized parsed details when available.

## Detail Parsing

Exact specifications should be parsed from Apple product detail pages, not inferred from AI or fuzzy summaries.

The parser should extract:

- `model`, initially `Mac Studio`.
- `chip`, for example `M3 Ultra`.
- `cpuCores`, if available.
- `gpuCores`, if available.
- `unifiedMemoryGb`, for example `512`.
- `storageGb`, normalized from `1TB`, `2TB`, `4TB`, `8TB`.
- `priceCny`, normalized from `RMB 92,399`.
- `availabilityStatus`, set to `available` only when purchase signals such as add-to-bag text are present and unavailable signals such as out-of-stock text are absent.
- `available`, derived from `availabilityStatus === "available"` for UI convenience.

Parser behavior:

- Use deterministic regular expressions and structured HTML extraction.
- Read and write all HTML fixtures, logs, and JSON as UTF-8.
- Keep Chinese Apple text matching in the Node.js parser and Node.js tests.
- Avoid relying on PowerShell 5.1 Chinese string literals for parser tests; use Unicode escapes when PowerShell must touch Chinese text.
- Keep raw title and text snippets for debugging.
- Mark parse confidence as `complete`, `partial`, or `failed`.
- Store parse errors in scan history without crashing the whole worker.

## Alert Rules

Rules filter discovered products only at alert time.

The first default rule:

```json
{
  "name": "Mac Studio 512GB unified memory",
  "enabled": true,
  "model": "Mac Studio",
  "unifiedMemoryGb": 512,
  "available": true
}
```

Future rule fields:

- `chipIn`.
- `minUnifiedMemoryGb`.
- `storageGbIn`.
- `maxPriceCny`.
- `manualProductIds`.

Alert de-duplication:

- Server creates one canonical alert event once per product per availability window.
- Enabled delivery channels, such as SMS and Telegram, each attempt delivery for that alert event.
- A new availability window begins when a product moves from unavailable to available.
- A first scan where no previous state exists and `available=true` also begins a new availability window.
- Repeated scans while still available update dashboard state but do not create new delivery events unless a repeat policy is explicitly enabled.
- Alert events use a unique key such as `(ruleId, productId, availabilityWindowId)`.
- Channel deliveries use a unique key such as `(alertEventId, channel)`, allowing SMS and Telegram to retry independently.

Offer identity and restock state:

- Do not treat Apple product URL as the only identity. Apple refurbished URLs can reappear and may represent a changed offer over time.
- `productId` identifies the Apple URL/product code.
- `offerFingerprint` identifies the normalized offer currently behind that URL.
- Build `offerFingerprint` from deterministic parsed fields: `productId`, model, chip, CPU/GPU cores, unified memory, storage, and any stable Apple part/configuration text found on the page.
- Title is stored for display and debugging, but should only be used as a fallback fingerprint input when structured fields are missing.
- Price is stored separately and should not be the only reason to create a new fingerprint.
- Price changes for the same `offerFingerprint` update product history and dashboard state but do not create purchase alerts by default. A future `priceDrop` rule can add price-change alerts explicitly.
- If the same `productId` appears with a different `offerFingerprint`, treat it as a new offer and evaluate alert rules again.
- If the same `offerFingerprint` remains available across scans, do not send another SMS or Telegram alert by default.
- If the same `offerFingerprint` becomes unavailable and later becomes available again, create a new `availabilityWindowId` and alert again if it matches rules.
- A product should be marked unavailable only after a small confirmation threshold, for example two consecutive unavailable scans, to avoid closing a window because of a transient fetch or parse issue.
- A product that disappears from listing pages but is still reachable by detail URL should not immediately close its window. Close the window only after the detail page confirms unavailable or the product has been absent/stale beyond a configured threshold.
- Default stale threshold: 180 seconds for server-side availability windows. This can be tuned after observing Apple page behavior.
- Parser/network failures should produce `unknown` scan results and should not by themselves create a new alert or close an existing availability window until the failure grace threshold is exceeded.

Local script de-duplication:

- Local browser opening happens once per product per availability window.
- Desktop notification and beep can repeat according to local configuration.

Rule diagnostics:

- Rule evaluation should return both `matches` and human-readable mismatch reasons.
- Product rows should expose why a product did not alert, for example `memory 128 != 512`, `availabilityStatus unknown`, or `already alerted in current availability window`.
- Dashboard views should show these diagnostics for debugging missed alerts.

## Alert Channels

Alert events are channel-independent. A matched product should create one canonical `alert_event`, then delivery adapters decide whether to send SMS, Telegram, both, or dry-run messages.

Initial channels:

- Tencent Cloud SMS.
- Telegram bot message.
- Local script event API for Windows strong popup behavior.

Delivery adapters must be best-effort:

- A Telegram failure must not prevent SMS.
- An SMS failure must not prevent Telegram.
- Each delivery result is stored separately in `sms_events` or `telegram_events`.
- Secrets must be redacted in logs and UI diagnostics.
- On application startup, the sender must resume retryable `pending` or `failed` delivery rows so alerts are not lost after a crash or restart.

## Tencent Cloud SMS

Use Tencent Cloud SMS `SendSms`.

Required configuration:

- `TENCENT_SECRET_ID`.
- `TENCENT_SECRET_KEY`.
- `TENCENT_SMS_SDK_APP_ID`.
- `TENCENT_SMS_SIGN_NAME`.
- `TENCENT_SMS_TEMPLATE_ID`.
- `TENCENT_SMS_PHONE_NUMBERS`, using E.164 format such as `+8613800138000`.
- `SMS_DRY_RUN`, default true in local dev.

SMS payload should include concise product information:

- Short normalized product label, for example `Mac Studio 512GB`.
- Price.
- Product ID, for example `g1cepch-a`.
- Do not include long Apple URLs by default, because Tencent Cloud SMS requires reviewed templates and template variables have length/content constraints.
- Full product URL should be sent through Telegram and shown in the web dashboard.

Tencent Cloud SMS template planning:

- Use an approved template with short variables only.
- Recommended template variables: `{productLabel}`, `{price}`, `{productId}`.
- Keep each variable deterministic and short enough for template review.
- Treat SMS template mismatch or variable-length rejection as delivery failure for the SMS channel only; it must not block Telegram delivery.

## Telegram Alerts

The Telegram module should reuse the design and core behavior from:

- `D:\codex\PA交易\openclaw-skills\pa-live-trading-v3\notification-delivery.js`.
- `D:\codex\PA交易\openclaw-skills\pa-live-trading-v3\notification-config.js`.

Important existing behavior to preserve:

- `sendTelegramTransport(message, meta)` style API.
- Queue-based delivery.
- Severity levels: `info`, `warn`, `critical`.
- Retry handling and Telegram rate-limit `retry_after` behavior.
- Message truncation.
- Error sanitization that redacts bot tokens and masks chat IDs.
- Test reset/flush helpers for deterministic tests.

The server implementation must vendor or adapt the module into this project. It must not import from `D:\codex\PA交易` at runtime, because the Tencent Cloud OpenCloudOS 9 server will not have that Windows path.

Recommended server environment variables:

- `TG_BOT_TOKEN`.
- `TG_CHAT_ID`.
- `TG_NOTIFY_ENABLED`.
- `TG_NOTIFY_MIN_SEVERITY`.
- `TG_NOTIFY_MAX_QUEUE_SIZE`.
- `TG_NOTIFY_SEND_TIMEOUT_MS`.
- `TG_NOTIFY_MAX_ATTEMPTS`.
- `TG_NOTIFY_BACKOFF_MS`.
- `TG_NOTIFY_PROXY_URL`, optional.

For compatibility with the PA trading module, the implementation may also accept `PA_TG_BOT_TOKEN` and `PA_TG_CHAT_ID` as aliases.

Deployment note:

- Telegram delivery is intended to run from an overseas Telegram-reachable server or route.
- `TG_NOTIFY_PROXY_URL` remains optional but should be supported as a fallback.
- Server startup and dashboard settings should expose a Telegram connectivity test.

Telegram message content should include:

- Product title.
- Normalized spec, especially memory and storage.
- Price.
- Matching rule name.
- Apple product URL.

## Web Dashboard

The dashboard should be operational rather than marketing-style.

Core views:

- Products: all discovered Mac Studio targets, parse status, availability, price, and last checked time.
- Matching Alerts: products currently matching enabled rules.
- Rules: edit enabled filters such as model, memory, chip, storage, and price.
- History: scan results, SMS events, Telegram events, and local script events.
- Settings: Tencent SMS dry-run/test status, Telegram test status, and local script token display.

The dashboard should make non-matching discovered products visible, because discovery completeness matters.

## API

Initial API endpoints:

- `GET /api/health`.
- `GET /api/products`.
- `GET /api/products/:id`.
- `GET /api/rules`.
- `PUT /api/rules/:id`.
- `GET /api/alerts`.
- `POST /api/sms/test`.
- `POST /api/telegram/test`.
- `GET /api/local/events?since=...`.
- `POST /api/scan/run`, protected by admin token.

Authentication:

- First version uses a single `ADMIN_TOKEN` for mutating endpoints.
- Local script uses `LOCAL_SCRIPT_TOKEN`.
- Dashboard and API access require token authentication by default from v1.
- Local development may disable dashboard/API auth only with `LOCAL_DEV_AUTH_DISABLED=true`.
- `GET /api/health` is the only unauthenticated endpoint by default.
- Authenticated API calls use a simple bearer token or equivalent header in v1.
- Dashboard authentication should avoid exposing secrets in static page bundles or API responses.
- `POST /api/scan/run`, `POST /api/sms/test`, and `POST /api/telegram/test` must require `ADMIN_TOKEN`.
- `POST /api/scan/run`, `POST /api/sms/test`, and `POST /api/telegram/test` must include a simple rate limit.
- No SMS, Telegram, or local script token values are returned by API responses.
- Provide `.env.example`.
- Real `.env` files must be ignored by git.
- `ADMIN_TOKEN` and `LOCAL_SCRIPT_TOKEN` must be random high-entropy strings.
- Logs must never print raw tokens, Tencent credentials, Telegram bot tokens, or chat IDs.

## Persistence

Use SQLite for the first implementation because it is simple to deploy in Docker and enough for this workload.

Tables:

- `products`.
- `product_snapshots`.
- `alert_rules`.
- `alert_events`.
- `sms_events`.
- `telegram_events`.
- `local_events`.
- `availability_windows`.

Important constraints:

- `alert_events` has a uniqueness constraint on `(rule_id, product_id, availability_window_id)`.
- `sms_events` and `telegram_events` have uniqueness constraints on `(alert_event_id, channel)`.
- `availability_windows` stores `product_id`, `offer_fingerprint`, open/closed timestamps, close reason, and current status.
- Delivery rows store `pending`, `sent`, `failed`, retry count, sanitized error text, and timestamps.
- Enable SQLite WAL mode.
- Keep schema migrations as versioned files.
- Back up the `/app/data` volume before production upgrades.
- Provide an executable backup command or script, for example `npm run backup`, which copies `/app/data/apple-monitor.sqlite` and its WAL/SHM companions to a timestamped backup directory.
- Store timestamps in UTC+8 consistently across database records, logs, alert messages, and dashboard display.
- Use one stable timestamp format, such as ISO-like `yyyy-MM-ddTHH:mm:ss.SSS+08:00`.
- Add retention cleanup for growing tables: scan/product snapshots default to 30 days; alert and delivery events default to 180 days unless configured otherwise.
- Use a SQLite-backed worker lock or equivalent single-instance guard so two app instances do not run scanner/delivery workers at the same time.

The server should mount `/app/data` as a Docker volume.

## Docker Deployment On OpenCloudOS 9

Deployment target:

- Tencent Cloud OpenCloudOS 9.
- Docker Engine.
- Docker Compose v2.

Services:

- `app`: web, API, worker scheduler, SMS sender, and Telegram sender in one Node.js process for v1 simplicity.
- `data`: persistent mounted volume, not a separate database container for SQLite.
- v1 is intended to run as a single active app instance. If multiple containers are accidentally started, the worker lock prevents duplicate scans and duplicate alerts.

Scan cadence:

- Listing discovery defaults to every 30-60 seconds.
- Detail checks use a small concurrency limit.
- Matching or near-matching products can be checked more frequently than unrelated products.
- The local Windows script may keep a 10-second cadence for its fallback URL monitoring and strong desktop reminders.

Default scan configuration:

- `APPLE_LIST_INTERVAL_SECONDS=45`.
- `APPLE_DETAIL_INTERVAL_SECONDS=15`.
- `APPLE_SCAN_CONCURRENCY=2`.
- `APPLE_REQUEST_TIMEOUT_MS=15000`.

OpenCloudOS notes:

- Install packages with `dnf`.
- Enable Docker with `systemctl enable --now docker`.
- Open the web port through Tencent Cloud security group and host firewall if needed.
- Docker Compose should include an application healthcheck.
- Application logs should go to stdout/stderr for Docker log collection.
- Durable business events such as scans, alerts, and delivery results should still be stored in SQLite.

## Testing

Required tests:

- Parser unit tests for Mac Studio detail HTML.
- Listing discovery tests with saved sample HTML.
- Rule matching tests for `Mac Studio + 512GB unified memory`.
- Alert de-duplication tests.
- SMS dry-run tests.
- Telegram dry-run and queue behavior tests.
- API contract smoke tests.

Manual verification:

- Run local dev server.
- Trigger one scan.
- Confirm product list populates.
- Enable the default 512GB rule.
- Confirm matching products appear in dashboard.
- Send a dry-run SMS test.
- Send a dry-run Telegram test.
- Run one live scan smoke test against `https://www.apple.com.cn/shop/refurbished/mac/mac-studio`; the test may find zero matching alerts, but it must complete and record listing/detail parse status.

## Implementation Phases

### Phase 1: Parser And Rules Foundation

- Deterministic Mac Studio listing discovery.
- Deterministic product detail parser.
- Saved Apple HTML fixtures.
- Rule matching for `Mac Studio + 512GB unified memory`.
- Availability-window and alert de-duplication tests.

### Phase 2: Server Web/API With Dry-Run Delivery

- Node.js app with API, worker scheduler, static dashboard, and SQLite.
- Token-protected dashboard and mutating API endpoints.
- Product, rule, scan history, and alert history views.
- SMS and Telegram dry-run adapters.
- Dry-run delivery adapters still write `sms_events` and `telegram_events` rows with a dry-run status, so Phase 3 can switch to real delivery without changing the audit trail.
- Dockerfile and Docker Compose for OpenCloudOS 9.

### Phase 3: Real SMS And Telegram Delivery

- Tencent Cloud SMS `SendSms` adapter.
- Telegram adapter based on the PA trading notification transport behavior.
- Per-channel delivery status, retry, and sanitized error recording.
- SMS and Telegram test endpoints.
- Telegram connectivity test for the overseas deployment environment.

Phase 3 is the production reminder completion line. Phase 1 and Phase 2 are useful for parsing, dashboard, and dry-run validation, but they do not provide real SMS or Telegram purchase alerts.

### Phase 4: Local Windows Strong Popup

- Upgrade existing PowerShell monitor script with a topmost strong popup.
- Keep one-browser-open-per-availability-window behavior.
- Support beep loop until acknowledgement.
- Prepare later server event polling with `LOCAL_SCRIPT_TOKEN` through `/api/local/events`.

## First Implementation Scope

Build Phase 1 and Phase 2 first:

- Node.js app with API, worker, static dashboard, SQLite, and dry-run delivery adapters.
- Dockerfile and Docker Compose for OpenCloudOS 9 server deployment.
- Deterministic Mac Studio discovery and detail parsing.
- Default alert rule for `Mac Studio + 512GB unified memory`.
- Existing Windows script remains local fallback in v1. Strong popup work is Phase 4 unless we choose to prioritize local reminders before real SMS and Telegram delivery.

Out of scope for first implementation:

- User accounts.
- Multi-user permissions.
- AI-based product recognition.
- Non-Apple sources.
- Non-Mac Studio product families.
- Complex price trend analytics.
