# Build Plan — Court Booking System

This is the step-by-step plan for building the system described in
[BOOKING_ARCHITECTURE.md](BOOKING_ARCHITECTURE.md). We build one phase at a time.
Each phase ends with something you can run and test.

Status: **Agreed on 2026-11-26.** Current phase: **Phase 1**.

---

## Words we use

| Word | Meaning | Example |
|---|---|---|
| **Client** | A business (venue) that uses this booking system. Each client gets its **own copy** of the app. | Business 1 (badminton), Business 2 (basketball) |
| **Venue** | The place a client runs. One copy of the app = one venue. | "City Sports Hall" |
| **Court** | One bookable court at a venue. Each court has its own sport, hours and price. | Court 1 (badminton), Court 2 (badminton) |
| **Admin** | The venue owner's account. Manages everything, including staff accounts. | The owner of Business 1 |
| **Staff** | Helpers created by the admin. Manage courts, bookings and customers. | Front-desk employee |
| **Customer** | A player who signs up and books courts. Sees only their own bookings. | Someone booking Court 1 on Saturday |

```
You (developer) ── one codebase
   ├── Client: Business 1's copy (badminton) ── admin, staff, customers, courts
   └── Client: Business 2's copy (basketball) ── admin, staff, customers, courts
```

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Tenancy | **One copy per client** (single business per deployment) | Target is 2–3 business owners. Each has its own booking website (e.g. `sunrise-tennis.com`) and customers only see that one business, so data never needs to be shared. Simpler code, strongest separation, best for learning. Revisit if we expect more than ~5 clients or a single site listing all businesses. |
| Hosting for 2–3 clients | All copies share **one MongoDB Atlas cluster** (separate database + database user each) and **one server** (separate docker-compose stack each) | Keeps cost low without mixing data. Set up in Phase 14. |
| Sports / courts | **Not hard-coded.** Each owner creates their own courts (sport, hours, price) in the admin pages. | We don't know the clients' courts yet; the same code must work for badminton, basketball, tennis, or a mix. |
| What is booked | **Courts** (tennis, badminton, basketball…) | — |
| Courts per venue | **Many.** One venue (the client) has Court 1, Court 2, Court 3… | A venue owner runs several courts at once. |
| Availability and double-booking scope | **Per court**, never per venue | Court 1 booked 09:00–10:00 must not block Court 2 or Court 3 at 09:00–10:00. See "Data model" below. |
| Booking length | **Customer chooses**, e.g. 1, 2 or 3 hours. Each court sets `slotMinutes` (start-time step, e.g. 60 = on the hour), `minDurationMinutes` and `maxDurationMinutes`. | Players want longer sessions. Bookings must start and end on the same local day (no crossing midnight), so one lock per court-day is enough. |
| Staff accounts | **Many per venue.** The owner (`admin`) creates and disables `staff` accounts from a Staff page. | Owners need helpers. Public sign-up only ever creates `customer`; a role is never taken from a request body. |
| Pricing | **Per court:** `hourlyRateCents`. Booking price = rate × hours, saved on the booking (`priceCents`) when it is made. | Courts differ (indoor vs outdoor). Saving the price on the booking means later price changes don't alter existing bookings. Whole cents avoid rounding bugs. |
| Data separation between clients | **Separate deployment per client** (see "Client separation" below) | Each client's data lives in its own database with its own credentials and secrets. |
| Payments before Phase 12 | Bookings are created as `confirmed` ("pay at the venue") | Lets us build a useful app before payments. The `held` → `expired` flow arrives with payments. |
| Tests | Vitest | Fast, works with TypeScript out of the box. |
| Package manager | pnpm workspace | Required by the architecture for `packages/contracts`. |

### Names: architecture placeholder → our names

| Architecture | This project |
|---|---|
| resource | **court** |
| `resources` collection | `courts` |
| `resource-days` collection | `court-days` |
| `resourceId` / `[resourceId]` | `courtId` / `[courtId]` |
| `ResourceDB` / `ResourceAPI` | `CourtDB` / `CourtAPI` |
| socket room `resource:<id>` | `court:<id>` |
| topic `booking.resource.events` | `booking.court.events` |
| event `resource.updated` | `court.updated` |

"staff" still means the people who **manage** the venue (a user role), not a court.

---

## Data model (courts are independent)

One deployment = one venue. The venue has many courts, and **every court has its own
schedule**. Everything about availability and double booking is keyed by `courtId`.

| Collection | Key fields | Scope |
|---|---|---|
| `venue-settings` | `venueId`, `name`, `currency` (single document) | venue-wide; `venueId` is checked at startup (see "Client separation") |
| `courts` | `name` ("Court 1"), `sport`, `timezone`, `slotMinutes`, `minDurationMinutes`, `maxDurationMinutes`, `bufferMinutes`, `hourlyRateCents`, `isActive` | one document per court |
| `opening-hours` | `courtId`, `weekday`, `open`, `close` | per court (courts can have different hours) |
| `closures` | `courtId`, `startAt`, `endAt`, `reason` | per court (e.g. "Court 2 resurfacing") |
| `bookings` | `courtId`, `userId`, `startAt`, `endAt` (UTC), `durationMinutes`, `priceCents`, `status`, `code`, `version`, `createdBy`, `cancelledBy?` | each booking belongs to exactly one court |
| `court-days` | `courtId`, `date`, `version` | the transaction lock — **one lock per court per day** |
| `user` / `session` / `account` | Better Auth + `role` (`customer` / `staff` / `admin`), `isActive` | venue-wide |

```
venue (the deployment)
 ├── Court 1 ─< opening-hours, closures, bookings, court-days
 ├── Court 2 ─< opening-hours, closures, bookings, court-days
 └── Court 3 ─< opening-hours, closures, bookings, court-days
```

**How "per court" is enforced:**

1. **Overlap check** (the main guard, because bookings have different lengths) looks only at
   bookings on the same court:
   `courtId = X AND startAt < newEnd AND endAt > newStart AND status is active`
   (buffer minutes are added around existing bookings).
2. **Transaction lock** bumps the `court-days` document for `{ courtId, date }`. Two people booking
   Court 1 on the same day wait for each other; someone booking Court 2 uses a different lock
   document and is never blocked. Because a booking never crosses midnight, it only ever needs
   one lock document.
3. **Unique index** on `{ courtId, startAt }` (partial: active statuses only) is an extra safety net.
   It only catches two bookings with the **same start time**; overlaps with different start times
   (Court 1 09:00–11:00 vs Court 1 10:00–11:00) are caught by steps 1 + 2.
4. **Availability** is calculated for one court and one chosen length at a time:
   `GET /api/courts/[courtId]/availability?date=…&duration=120`. The cache key is
   `avail:<courtId>:<date>`, and only that court's key is cleared when it changes.
5. **Live updates** go to the `court:<id>` room, so a change on Court 1 only refreshes Court 1's view.

**Example:** Court 1 is booked 09:00–10:00.
- Booking Court 1 at 09:00 → rejected (409 "Slot no longer available").
- Booking Court 1 08:00–10:00 (2 hours) → rejected, it overlaps 09:00–10:00.
- Booking Court 1 10:00–12:00 → allowed.
- Booking Court 2 or Court 3 at 09:00 → allowed.
- Court 1's 09:00 slot shows as taken; Courts 2 and 3 still show 09:00 as free.

---

## Client separation (one copy per client)

Every client (venue owner) gets their own deployment of the **same code**. Nothing is shared
between clients:

| Layer | Per client |
|---|---|
| Database | Own MongoDB database (own Atlas project in production) and own database user that can only access that database |
| Secrets | Own `BETTER_AUTH_SECRET`, `INTERNAL_SERVICE_KEY`, `SOCKET_TOKEN_SECRET`, Stripe keys… (never reused) |
| Domain | Own domain or subdomain, so login cookies can never be sent to another client |
| Redis, Redpanda, services | Own containers in their own docker-compose stack / private network |
| Backups | Own backups, restorable without touching other clients |
| Accounts | Customers, staff and admins exist only in that client's database |

**Safety check against configuration mistakes:** the `venue-settings` document stores a
`venueId`, and the app refuses to start if it doesn't match the `VENUE_ID` environment variable.
This catches the most likely mistake: copying one client's `MONGODB_URI` into another client's
settings.

**Inside one venue**, the normal security rules from the architecture still apply: customers see
only their own bookings, staff and admins see everything, and identity comes only from the session.

---

## Phases

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

### [x] Phase 0 — Project setup
- `.gitignore`, git repository, first commit, private GitHub repo (personal account).
- **You learn:** git basics, what to never commit.

### [ ] Phase 1 — Monorepo skeleton and the first route
- pnpm workspace at the root (`pnpm-workspace.yaml`) containing `booking-app/`.
- `booking-app`: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + ESLint + Prettier.
- First shared building blocks: `lib/http.ts` (`ok` / `fail`), `lib/errors.ts` (`AppError`),
  `utils/logger.ts` (winston), `utils/handleRouteError.ts`.
- `GET /api/health` returning `{ success: true, status: "ok" }`.
- Vitest set up with one tiny test.
- **Run/test:** `pnpm dev` → open `http://localhost:3000/api/health`; `pnpm test`; `pnpm lint`.
- **You learn:** monorepos, Next.js App Router folders, the route → response envelope pattern.

### [ ] Phase 2 — MongoDB
- `docker-compose.yml` with **only** `mongo` (single-node replica set, needed for transactions).
- `lib/mongo/` singleton, `collections.ts` getters, `ensureIndexes.ts`.
- `.env.example` for booking-app (`MONGODB_URI`, `MONGODB_DB`, `VENUE_ID`, …names only).
- `venue-settings` document + the startup check that `venueId` matches `VENUE_ID`.
- `/api/health` now also checks the database.
- **Run/test:** `docker compose up -d mongo`, then health shows `db: "ok"`; stop Mongo and see it fail.
- **You learn:** Docker basics, why a singleton connection, env variables, replica sets.

### [ ] Phase 3 — Authentication and roles
- Better Auth (email/password), sessions stored in MongoDB, `role`: customer / staff / admin.
- `lib/auth.ts`, `utils/requireSession.ts` (`requireSession`, `requireSessionApi`),
  `requireRole`, `proxy.ts` (cookie check + security headers).
- Sign-up, sign-in, sign-out pages; a seed script to create the first admin (the venue owner).
- Public sign-up always creates a `customer`.
- Admin "Staff" page: create staff accounts, disable/enable them (disabled users can't sign in).
- **Run/test:** sign up as a customer; as admin create a staff account and sign in with it;
  check a customer is blocked from admin pages, staff can open them, only admin sees the Staff page.
- **You learn:** sessions vs tokens, httpOnly cookies, why identity only comes from the session.

### [ ] Phase 4 — Courts, opening hours, closures (staff side)
- DAL: `lib/dal/courts`, `lib/dal/opening-hours`, `lib/dal/closures`.
- Services + API routes: create/edit/deactivate courts (including hourly rate and min/max booking
  length), set weekly opening hours, add closures. Staff and admin can do this.
- zod schemas, `(admin)` dashboard pages using React Query + react-hook-form.
- Public court list page.
- **Run/test:** as admin, add Court 1, Court 2 and Court 3 with different hourly rates, give them
  opening hours, and add a closure to Court 2 only. Check Court 1 and Court 3 are unaffected.
- **You learn:** route → service → DAL layering, validation with zod, `XxxDB` vs `XxxAPI` types.

### [ ] Phase 5 — Availability (tests first)
- Pure function: opening hours − closures − active bookings − buffers → free slots,
  in the court's timezone, stored as UTC.
- Availability is always calculated for **one court and one chosen length**: only that court's
  hours, closures and bookings. A start time is free only if the **whole** booking fits.
- Pure price function: `hourlyRateCents × hours` (tested).
- **Write the unit tests first:** normal day, closure, buffer, DST change, day fully booked,
  **a booking on Court 1 does not remove the slot from Court 2**, a 2-hour booking needs two free
  hours in a row, a booking can't run past closing time, min/max length enforced.
- `GET /api/courts/[courtId]/availability?date=…&duration=…`.
- Venue view: pick a date and a length (1h / 2h / 3h), see every court side by side with its own
  free start times and price.
- **Run/test:** `pnpm test`; open the venue page and see different free slots per court; switch
  from 1h to 2h and see fewer start times.
- **You learn:** UTC vs local time, pure functions, test-driven development.

### [ ] Phase 6 — Making a booking (tests first)
- `features/bookings/status.ts` — the single status machine.
- `createBooking` service: transaction + `court-days` version bump + overlap check +
  partial unique index `{ courtId, startAt }` on active statuses.
- **Write the race tests first:**
  - 10 people book **Court 1 at 09:00** at once → exactly 1 succeeds, 9 get 409.
  - 3 people book **Court 1, Court 2 and Court 3 at 09:00** at once → all 3 succeed.
  - Two people at once book **Court 1 09:00–11:00** and **Court 1 10:00–12:00** (different start
    times, overlapping) → exactly 1 succeeds.
- The server calculates `priceCents` from the court's rate; the browser never sends a price.
- `POST /api/bookings` (body: `courtId`, `startAt`, `durationMinutes`), booking flow UI,
  "My bookings" page with a booking code and price.
- **Run/test:** book Court 1 09:00–11:00; try Court 1 10:00 in another browser → "Slot no longer
  available"; then book Court 2 at 09:00 → succeeds. Change Court 1's rate and check the existing
  booking keeps its old price.
- **You learn:** transactions, race conditions, why the database is the source of truth.

### [ ] Phase 7 — Managing bookings
- Cancel, reschedule (customer, own bookings only), check-in / complete / no-show (staff).
- Staff can also cancel any booking and look up customers and their bookings; `cancelledBy`
  records who did it.
- `canAccessBooking`, every update filters on the expected current status.
- Staff day calendar: one column per court, so staff see all courts at once.
- **Run/test:** cancel → slot becomes free again; a customer can't cancel someone else's booking.
- **You learn:** authorization rules, optimistic concurrency.

### [ ] Phase 8 — Redis
- Add `redis` to docker-compose, `lib/redis.ts` singleton.
- Rate limiting (sign-in, sign-up, booking create), availability cache (60s, cleared on change),
  UX soft lock while a user is on the checkout step.
- **Run/test:** spam sign-in → 429; check cache hits in logs.
- **You learn:** caching and invalidation, rate limiting, fail-open vs fail-closed.

### [ ] Phase 9 — Events: outbox, Redpanda, contracts, worker relay
- `packages/contracts`: event envelope, topic names, zod schemas.
- `outbox` written in the same transaction as each booking change.
- Add `redpanda`, `redpanda-console`, `redpanda-init` to docker-compose.
- `booking-worker` (new service) with only the **outbox relay**.
- **Run/test:** make a booking → see `booking.confirmed` in Redpanda Console (localhost:8080).
- **You learn:** event-driven design, the transactional outbox, why at-least-once delivery.

### [ ] Phase 10 — Worker jobs
- Kafka consumers with guard → idempotency → retry → DLQ.
- Confirmation/cancellation emails (dev email provider or console), reminders cron,
  Redis leader lock, DLQ alert consumer.
- **Tests first** for idempotent consumers.
- **Run/test:** book → email arrives; send the same event twice → only one email.
- **You learn:** idempotency, retries with backoff, dead-letter queues, leader election.

### [ ] Phase 11 — Live updates (booking-websocket)
- New service: Socket.IO + Redis adapter, consumes booking/court events.
- `GET /api/socket-token`, rooms `user:<id>`, `court:<id>`, `staff`.
- `SocketProvider` invalidates React Query caches.
- **Run/test:** two browsers on the same court page → book in one, the slot disappears in the other.
- **You learn:** WebSockets, rooms, signed tokens, why events are only signals.

### [ ] Phase 12 — Payments (booking-payment, Stripe test mode)
- New service: payment intents, webhook verification, `booking.payment.events`.
- Bookings now start as `held` (10 min) → `confirmed` on payment; expire-holds job;
  automatic refund for late payments.
- **Run/test:** pay with Stripe test card `4242…`; let a hold expire; Stripe CLI for webhooks.
- **You learn:** payment flows, webhooks, never trusting prices from the browser.

### [ ] Phase 13 — Observability
- OpenTelemetry in every service, trace context through HTTP and Kafka headers, `trace_id` in logs.
- **Run/test:** follow one booking across app → Kafka → worker → websocket in a trace viewer.
- **You learn:** distributed tracing, structured logs.

### [ ] Phase 14 — Production readiness
- Multi-stage Dockerfiles (non-root), healthchecks, graceful shutdown, resource limits.
- Full docker-compose, CSP with nonce, CI (lint, typecheck, test, audit/Trivy), MongoDB Atlas.
- "Set up a new client" checklist: new database + database user, new secrets, new domain,
  new `VENUE_ID`, first admin account, backups.
- **Run/test:** `docker compose up` runs the whole system; CI passes on a pull request; start the
  app with the wrong `VENUE_ID` and check it refuses to start.
- **You learn:** containers in production, CI/CD, security hardening.

---

## Rules while building
- Only build what the current phase asks for (no Redis before Phase 8, no Kafka before Phase 9,
  no WebSockets before Phase 11, no payments before Phase 12).
- Follow section 11 of BOOKING_ARCHITECTURE.md.
- Never commit real secrets — only `.env.example` with variable names.
- At the end of each phase: summary, how to run/test, a short exercise, commit and push,
  then mark the phase `[x]` here.
