# Booking System — Architecture

An event-driven booking system made of several services. The core is a Next.js app that owns
all booking data and rules. Around it:

- Kafka carries domain events between services.
- A WebSocket service pushes live updates to browsers.
- A worker runs background jobs.
- A payment service isolates the payment provider.
- Redis provides caching, rate limits, locks and socket fan-out.

> **Placeholders:** the domain terms below (`resource`, `booking`, `slot`) are generic.
> Rename them to fit your business, e.g. room, court, doctor, or table.

---

## 1. Overview

**What it does.** Customers browse bookable resources, see live availability, hold a slot,
pay, and get confirmations and reminders. Staff manage resources, opening hours and bookings,
and watch a live calendar.

### Tech stack

| Concern | Choice |
|---|---|
| Main app (UI + API) | Next.js (App Router), React, TypeScript |
| UI | Tailwind CSS, shadcn/ui, TanStack React Query, react-hook-form + zod |
| Auth | Better Auth (email/password to start), sessions in MongoDB |
| Database | MongoDB (native `mongodb` driver, no ORM) |
| Cache / rate limit / locks / socket fan-out | Redis (`ioredis`) |
| Event bus | Kafka API via Redpanda (`kafkajs`) |
| Real-time | Socket.IO + `@socket.io/redis-adapter` (Express) |
| Background jobs | Node worker: Kafka consumers + `node-cron` with a Redis leader lock |
| Payments | Node payment service: Stripe (intents + webhooks) |
| Email | Transactional email provider, called only from the worker |
| Observability | winston JSON logs + OpenTelemetry (traces across HTTP and Kafka) |
| Deploy | Docker images per service, docker-compose, MongoDB Atlas |

### How the parts connect

```
                    ┌────────────────────────────┐
  Browser ─────────▶│        booking-app         │──── MongoDB (owner of all booking data)
     │   HTTP       │  Next.js UI + /api/*       │──── Redis (cache, rate limit)
     │              │  routes → services → DAL   │
     │              │  outbox → (relay) → Kafka  │──HTTP──▶ booking-payment ──▶ Stripe
     │              └──────────▲─────────────────┘   create intent        ▲
     │                         │ HTTP /api/internal/* (service key)      │ webhook
     │                         │                                         │
     │ Socket.IO     ┌─────────┴──────────┐         ┌──────────┐         │
     └──────────────▶│ booking-websocket  │◀────────│ Redpanda │◀────────┘ payment.events
       (signed token)│ Socket.IO + Redis  │ consume │ (Kafka)  │
                     │ adapter            │         └────▲─────┘
                     └────────────────────┘              │ consume / publish
                                                ┌────────┴───────────┐
                                                │   booking-worker   │──── Email provider
                                                │ outbox relay, email│──── Redis (leader lock,
                                                │ reminders, holds   │      idempotency)
                                                └────────────────────┘
```

### Why it is split this way

- **booking-app is the single owner of booking data.** Only it writes to `bookings`,
  `resources` and related collections, so every rule (double-booking guard, status
  transitions, permissions) lives in one place. Other services change bookings only through its
  internal API.
- **booking-websocket** holds long-lived connections, which scale and fail differently from
  HTTP. It only relays signals. It never reads the database directly.
- **booking-worker** keeps slow and scheduled work out of the request path: sending email,
  reminders, expiring holds, and publishing the outbox. Cron here runs under a Redis leader
  lock, so scaling the worker never runs a job twice.
- **booking-payment** keeps payment-provider keys and webhook verification out of the main
  app. It publishes the payment result as a Kafka event instead of writing booking data itself.

---

## 2. Folder structure

```
booking/
├── booking-app/          Next.js (UI + API + DAL + outbox writes)
├── booking-websocket/    Socket.IO server + Kafka consumers
├── booking-worker/       Outbox relay + Kafka consumers + scheduled jobs
├── booking-payment/      Stripe intents + webhooks → Kafka
├── packages/contracts/   Shared event types, topic names, zod schemas (imported by all services)
├── docker-compose.yml
└── .env.example files per service
```

**Why `packages/contracts`:** every producer and consumer imports the same event types and
topic constants, so a renamed field fails at compile time instead of silently in production.
Use a pnpm workspace.

### booking-app/src

```
app/
├── (public)/              landing, resource list, booking flow
├── (account)/             my bookings (signed in)
├── (admin)/               staff dashboard (staff/admin)
└── api/
    ├── resources/…, resources/[resourceId]/availability/route.ts
    ├── bookings/route.ts
    ├── bookings/[bookingId]/{cancel,reschedule,check-in}/route.ts   ← one folder per action
    ├── internal/bookings/[bookingId]/{confirm,expire}/route.ts      ← service-key only
    ├── socket-token/route.ts
    └── health/route.ts
features/<name>/{components,hooks,schemas,services,types}/
lib/
├── dal/<domain>/          <domain>.queries.ts, .mutations.ts, .types.ts, index.ts
├── mongo/                 index.ts (singleton), collections.ts, ensureIndexes.ts
├── redis.ts               singleton
├── outbox/                writeOutboxEvent(session, event)
├── auth.ts, http.ts (ok/fail), errors.ts (AppError), rate-limit.ts, serviceAuth.ts
utils/                     logger.ts, requireSession.ts, handleRouteError.ts, time.ts
proxy.ts                   cookie presence, CSP, security headers
```

### Other services

- **booking-websocket/src:** `index.ts`, `auth.ts`, `rooms.ts`, `handlers/`,
  `kafka/consumers/<topic>/{index,guards,handlers}.ts`
- **booking-worker/src:** `outbox/relay.ts`, `kafka/consumers/…`, `jobs/{expireHolds,sendReminders}.ts`,
  `lib/{email,leaderLock,idempotency}.ts`
- **booking-payment/src:** `routes/{intents,webhooks}.ts`, `providers/stripe.ts`, `kafka/producer.ts`

### Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Folders, route segments | kebab-case | `opening-hours/` |
| Dynamic params | camelCase | `[bookingId]` |
| Components | PascalCase `.tsx` | `BookingCalendar.tsx` |
| Hooks | `useX.ts` | `useAvailability.ts` |
| Services / utils | camelCase verb | `createBooking.ts` |
| DAL functions | `db` + Verb + Entity | `dbInsertBooking` |
| Collection getters | `get<Entity>Collection` | `getBookingsCollection()` |
| Collections | kebab-case plural | `bookings`, `opening-hours` |
| Types | `XxxDB` (stored) / `XxxAPI` (to client) / `XxxEvent` (Kafka) | `BookingDB`, `BookingConfirmedEvent` |
| Kafka topics | `booking.<domain>.events` + `.dlq` | `booking.booking.events` |
| Event types | `domain.verb` (past tense) | `booking.confirmed` |
| Socket events | `domain:verb` | `availability:changed` |
| Socket rooms | prefixed | `user:<id>`, `resource:<id>`, `staff` |
| Constants | UPPER_SNAKE | `HOLD_MINUTES` |
| Log events | UPPER_SNAKE | `BOOKING_CONFLICT` |

Enforce the style with ESLint from day one.

---

## 3. API layer

Every route has the same shape:

```ts
// booking-app/src/app/api/bookings/route.ts
export async function POST(req: NextRequest) {
  const log = createRouteLogger("bookings", "POST");
  try {
    const user = await requireSessionApi();
    if (!user) return fail("Unauthorized", 401);

    const limited = await rateLimit(req, `booking:${user.id}`, 10, 60);
    if (limited) return limited;

    const parsed = createBookingSchema.safeParse(await req.json());
    if (!parsed.success) return fail("Invalid input", 400, parsed.error.flatten());

    const booking = await createBooking({ user, input: parsed.data, log }); // service
    return ok({ booking: serializeBooking(booking) }, 201);
  } catch (err) {
    if (err instanceof AppError) return fail(err.message, err.status);
    handleRouteError(err, log);
    return fail("Something went wrong", 500);
  }
}
```

**Flow:** route (HTTP, auth, rate limit, validation) → **service** (rules, transaction,
outbox event) → **DAL** (queries) → MongoDB. Routes never import collections.

**One envelope everywhere** (`lib/http.ts`):

```ts
export const ok   = <T>(data: T, status = 200) => NextResponse.json({ success: true, ...data }, { status });
export const fail = (message: string, status: number, details?: unknown) =>
  NextResponse.json({ success: false, message, details }, { status });
```

**Internal routes** (`/api/internal/*`) are called only by other services. They use
`requireServiceAuth(req)`, one shared helper that compares a bearer key in constant time. They
never accept a user session.

---

## 4. Data layer

### MongoDB connection (singleton)

```ts
// lib/mongo/index.ts
declare global { var _mongo: Promise<MongoClient> | undefined }
export function getClient() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  globalThis._mongo ??= new MongoClient(uri, { maxPoolSize: 20 }).connect();
  return globalThis._mongo;
}
export const getDb = async () => (await getClient()).db(process.env.MONGODB_DB);
```

Redis (`lib/redis.ts`) and the Kafka producer use the same lazy singleton pattern.

### DAL rules

- DAL functions only run queries. They take plain params plus an optional `session?: ClientSession`.
- There are no auth checks or business decisions in the DAL.
- Put preconditions in the filter (optimistic concurrency):
  ```ts
  collection.findOneAndUpdate(
    { _id, status: "confirmed" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
    { returnDocument: "after", session },
  );
  ```

### Collections

| Collection | Key fields |
|---|---|
| `user` / `session` / `account` | Better Auth; plus `role: "customer" \| "staff" \| "admin"` |
| `resources` | `name`, `timezone`, `slotMinutes`, `bufferMinutes`, `capacity`, `price`, `isActive` |
| `opening-hours` | `resourceId`, `weekday`, `open`, `close` (local time) |
| `closures` | `resourceId`, `startAt`, `endAt`, `reason` |
| `bookings` | `resourceId`, `userId`, `startAt`, `endAt` (UTC), `status`, `holdExpiresAt?`, `paymentIntentId?`, `code`, `version` |
| `resource-days` | `resourceId`, `date`, `version` (transaction lock) |
| `outbox` | `topic`, `key`, `event`, `createdAt`, `publishedAt?` |
| `payments` (owned by booking-payment) | `bookingId`, `providerId` (unique), `amount`, `status` |

```
user ─< bookings >─ resources ─< opening-hours
                       └──────< closures
bookings ── 0..1 ── payments (payment service)
```

### Booking rules

1. **Store all times in UTC.** Each resource stores its IANA `timezone`. Convert only for
   display and for slot generation.
2. **Status machine** (single file `features/bookings/status.ts`):
   `held` → `confirmed` → `completed` | `cancelled` | `no_show`, and `held` → `expired`.
3. **Prevent double booking in the database**, not only in code:
   ```ts
   await session.withTransaction(async () => {
     // Every booking on the same resource-day bumps this doc → concurrent bookers get a write conflict.
     await days.updateOne({ resourceId, date }, { $inc: { version: 1 } }, { upsert: true, session });
     const clash = await dbFindOverlappingBookings(resourceId, startAt, endAt, session);
     // overlap: existing.startAt < endAt && existing.endAt > startAt && status in ACTIVE_STATUSES
     if (clash) throw new AppError("Slot no longer available", 409);
     const booking = await dbInsertBooking({ ..., status: "held", holdExpiresAt }, session);
     await writeOutboxEvent(session, bookingHeld(booking));   // same transaction (see §9)
   });
   ```
   For fixed-length slots, also add a partial unique index on `{ resourceId, startAt }` for
   active statuses.
4. **Availability is computed, not stored:** opening hours − closures − active bookings and
   unexpired holds − buffers. Use a pure, unit-tested function. Cache the result in Redis
   (`avail:<resourceId>:<date>`, 60s TTL) and delete the key on every booking event for that
   resource-day.
5. **The Redis soft lock is for UX only.** `SET slotlock:<resourceId>:<startAt> <userId> NX PX 30000`
   while the user is on the checkout step, so others see the slot as "being booked". The
   database guard in rule 3 remains the source of truth.

---

## 5. Services

| Service | Owns | Does |
|---|---|---|
| **booking-app** | Users, resources, bookings, outbox | UI; public and internal API; availability; `createBooking`, `cancelBooking`, `rescheduleBooking`, `confirmBooking`, `expireHold`; asks payment for an intent; issues socket tokens |
| **booking-payment** | `payments` | Creates payment intents for a booking (amount comes from booking-app, never from the browser); verifies Stripe webhooks; publishes `payment.succeeded` / `payment.failed` / `payment.refunded`; issues refunds when asked |
| **booking-worker** | Nothing in the booking domain | Outbox relay; consumes `payment.events` → calls `POST /api/internal/bookings/:id/confirm`; consumes booking events → sends emails; cron: expire holds and send reminders (under a leader lock) |
| **booking-websocket** | Nothing | Consumes booking and resource events → emits small signals to rooms |

### How they communicate

| From → To | Mechanism | Auth |
|---|---|---|
| booking-app → booking-payment | HTTP `POST /intents`, `POST /refunds` | `PAYMENT_SERVICE_KEY` bearer |
| Stripe → booking-payment | Webhook | Stripe signature |
| booking-payment → others | Kafka `booking.payment.events` | — |
| booking-app → others | Kafka via outbox (`booking.booking.events`, `booking.resource.events`) | — |
| booking-worker → booking-app | HTTP `/api/internal/bookings/*` | `INTERNAL_SERVICE_KEY` bearer |
| Browser ↔ booking-websocket | Socket.IO | Signed socket token (`SOCKET_TOKEN_SECRET`) |

Each key has one purpose. The socket-token secret is not the service key.

### Payment flow, end to end

```
1. POST /api/bookings              → booking "held" (10 min) + outbox booking.held
2. booking-app → payment /intents  → client secret → browser pays with Stripe
3. Stripe webhook → booking-payment → verify signature, re-fetch intent, publish payment.succeeded
4. worker consumes payment.succeeded → POST /api/internal/bookings/:id/confirm (idempotent)
5. booking-app: held → confirmed (filter status:"held") + outbox booking.confirmed
6. websocket → "booking:updated" to user:<id>, "availability:changed" to resource:<id>
   worker   → confirmation email
If the hold expires first: worker job → /internal/bookings/:id/expire → booking.expired
   → payment arriving later is refunded automatically (worker → payment /refunds).
```

---

## 6. Authentication and authorization

- **Better Auth** with email/password, sessions in MongoDB and an httpOnly secure cookie.
  OAuth and magic links can be added later as plugins.
- **Session helpers:**
  - `requireSession()` for pages: redirects if there is no session.
  - `requireSessionApi()` for routes: returns `null`.
- **Role helpers:** `requireRole(user, "staff")` and `canAccessBooking(user, booking)`. These
  are the only ways to check roles and ownership; don't write inline checks.
- **Middleware** (`proxy.ts`): a cheap cookie-presence check, CSP and security headers. Real
  validation happens server-side.
- **Roles:**
  - `customer`: own bookings only.
  - `staff`: all bookings and resources.
  - `admin`: everything, plus users.
- **Identity comes only from the session.** Never accept `userId` from a body, query or socket
  payload.
- **Socket tokens:**
  - `GET /api/socket-token` returns a short-lived (15 min) HMAC- or JWT-signed `{ userId, role, exp }`.
  - The client fetches a new token before reconnecting.
  - booking-websocket verifies the token in `io.use` and stores the identity on `socket.data`.
- **Service-to-service:** a bearer key per caller/purpose, checked by one shared
  `requireServiceAuth` helper with a constant-time compare.

---

## 7. Security

| Measure | How |
|---|---|
| Rate limiting | Redis fixed window (`rl:<key>:<ip-or-user>`, atomic Lua `INCR`+`EXPIRE`) on sign-in, sign-up, password reset, booking create, and socket connects. Decide fail-open vs fail-closed per endpoint; auth endpoints should fail closed. |
| Input validation | zod `safeParse` on every mutating route, internal routes and Kafka consumers (guards). Reject unknown fields. |
| Protected routes | Authenticated is the default; public paths are an explicit, reviewed allowlist. Internal routes require a service key. |
| Socket rooms | The server decides rooms from the token: `user:<id>` is your own only, `staff` needs the staff role, and `resource:<id>` is allowed for anyone because it only carries availability signals. |
| Webhooks | Verify the Stripe signature, re-fetch the intent before acting, and dedupe by event id. |
| Money | Amounts are calculated server-side from the booking; the browser never sends prices. |
| Headers | Nonce CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS, strict referrer. |
| CORS | booking-app: same-origin, none. booking-websocket: an explicit `CORS_ORIGINS` allowlist. booking-payment: no browser access (internal plus webhook only). |
| Secrets | Env vars only; `.env.example` with names; `.env*` gitignored and dockerignored; never log env values or full requests; one key per purpose. |
| Containers | Multi-stage builds, non-root user, env injected at runtime, Trivy/`pnpm audit` in CI. |
| Network | Only booking-app (3000), booking-websocket (3001) and the payment webhook are public. Redis, Redpanda and internal routes stay on the private network. |

---

## 8. Error handling

- **`AppError(message, status)`** covers expected failures (400/401/403/404/409/429). Routes map
  it to `fail()`.
- **Unexpected errors:** `handleRouteError(err, log)` logs `EXCEPTION` with the stack, and the
  route returns a generic 500. Stack traces never go to the client.
- **Logging:** `createRouteLogger(endpoint, method)` gives a winston child with `requestId`,
  `duration()` and UPPER_SNAKE events. Every service uses the same logger setup, with `trace_id`
  and `span_id` injected.
- **Tracing:** OpenTelemetry in every service. The trace context goes into Kafka headers and
  internal HTTP calls, so one booking can be followed app → Kafka → worker → app → websocket.
- **Kafka consumers:**
  ```
  parse → guard (zod) → idempotency check → handler with retry (3x, exponential backoff + jitter) → DLQ
  ```
  - Invalid messages go straight to the DLQ.
  - A DLQ consumer in the worker alerts by email or Slack and never re-publishes.
- **UI:** `error.tsx` / `global-error.tsx` show a fallback with retry. The client `apiFetch`
  throws `ApiError` and shows toasts.

---

## 9. Real-time and messaging

### Kafka (Redpanda)

**Event envelope** (`packages/contracts/events.ts`):

```ts
interface EventEnvelope<T> {
  id: string;            // uuid, used for idempotency
  type: string;          // "booking.confirmed"
  source: string;        // "booking-app"
  subject: string;       // bookingId
  time: string;          // ISO UTC
  correlationId: string;
  schemaVersion: number;
  data: T;
}
```

**Message key** = the aggregate id (`bookingId`, or `resourceId` for resource events), so events
for the same entity stay in order.

| Topic | Producer | Consumers | Events |
|---|---|---|---|
| `booking.booking.events` | booking-app (outbox) | websocket, worker | `booking.held`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `booking.expired`, `booking.completed`, `booking.no_show` |
| `booking.resource.events` | booking-app (outbox) | websocket | `resource.updated`, `resource.closure.added`, `availability.changed` |
| `booking.payment.events` | booking-payment | worker | `payment.succeeded`, `payment.failed`, `payment.refunded` |
| `*.dlq` | each consumer on final failure | worker (alerts) | Original event + error, retry count, source offset |

**Consumer groups:** `booking-websocket-<topic>` and `booking-worker-<topic>`. Each service gets
its own group, so each receives every event.

**Transactional outbox: why and how.** Publishing to Kafka after the DB commit can lose events if
the process crashes in between. Instead:

1. The service writes the event into the `outbox` collection **in the same transaction** as the
   booking change.
2. The worker's relay reads unpublished rows (or a change stream), publishes them to Kafka, and
   sets `publishedAt`.
3. Delivery is at-least-once, so consumers must be idempotent.

**Idempotency:** before handling an event, consumers run
`SET processed:<group>:<eventId> 1 NX EX 604800` in Redis. If the key already exists, the event
is skipped. Handlers that change data also use status filters (e.g. confirm only if `held`), so a
duplicate is harmless.

### WebSockets (booking-websocket)

- **Setup:**
  - Socket.IO on Express, path `/ws`.
  - `@socket.io/redis-adapter` so emits reach clients on every instance.
  - `io.use(verifySocketToken)` checks the token.
- **Rooms:** assigned by the server on connect from the token:
  - `user:<userId>` for everyone
  - `staff` if the role is staff/admin
- **Client joins:** the client may request `resource:<id>` for the calendar it is viewing. Those
  rooms are allowed because they carry no personal data. All other join requests are rejected.
- **Events are signals; the client refetches through the authorized API:**

| Socket event | Room(s) | Trigger |
|---|---|---|
| `availability:changed` `{ resourceId, date }` | `resource:<id>`, `staff` | any booking/resource event for that day |
| `booking:updated` `{ bookingId, status }` | `user:<ownerId>`, `staff` | booking status events |
| `hold:expiring` `{ bookingId, expiresAt }` | `user:<ownerId>` | worker, 2 minutes before expiry |

- **Presence:** if you need it, store it in Redis (`presence:<userId>` with a TTL refreshed by a
  heartbeat), never in per-instance memory.
- **Client:** a singleton `socket.io-client` with `auth: cb => cb({ token })`. It fetches a fresh
  token on `connect_error`. A `SocketProvider` maps events to React Query `invalidateQueries`.

---

## 10. Infrastructure

### Containers (`docker-compose.yml`, one private network)

| Service | Port | Role | Depends on |
|---|---|---|---|
| `booking-app` | 3000 (public) | UI + API | redis, redpanda (healthy) |
| `booking-websocket` | 3001 (public) | Socket.IO | redis, redpanda |
| `booking-worker` | — | Outbox relay, consumers, cron | redis, redpanda, booking-app |
| `booking-payment` | 4000 (webhook path public) | Payments | redpanda |
| `redis` | internal | Cache, rate limits, adapter, locks, idempotency (AOF on) | — |
| `redpanda` | internal (19092 for local dev) | Kafka broker | — |
| `redpanda-console` | 8080 (local only) | Kafka UI | redpanda |
| `mongo` (local dev only) | 27017 | Replica set (needed for transactions); MongoDB Atlas in prod | — |

**Every service has:**

- a multi-stage Dockerfile on a pinned Node LTS alpine image, running as a non-root user
- a `/health` route that actually exists, plus a matching `HEALTHCHECK`
- resource limits and log rotation in compose
- graceful shutdown on SIGTERM: stop consumers → close sockets → flush telemetry

**Topic creation:** a one-shot `redpanda-init` job (`rpk topic create …`) at startup. Don't rely
on auto-create.

**CI/CD:** lint, typecheck, test, audit/Trivy on PRs. Tag-driven deploys build and push images per
service.

### Environment variables (names only; ship a `.env.example` per service)

**booking-app**

```
MONGODB_URI, MONGODB_DB
BETTER_AUTH_SECRET, BETTER_AUTH_URL, APP_URL
REDIS_URL, KAFKA_BROKERS
PAYMENT_SERVICE_URL, PAYMENT_SERVICE_KEY
INTERNAL_SERVICE_KEY            # verifies calls from the worker
SOCKET_TOKEN_SECRET
NEXT_PUBLIC_SOCKET_URL, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL, NODE_ENV
```

**booking-websocket**

```
PORT, CORS_ORIGINS, SOCKET_TOKEN_SECRET, REDIS_URL, KAFKA_BROKERS
OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL
```

**booking-worker**

```
KAFKA_BROKERS, REDIS_URL, MONGODB_URI, MONGODB_DB   # Mongo only for the outbox relay
APP_INTERNAL_URL, INTERNAL_SERVICE_KEY
PAYMENT_SERVICE_URL, PAYMENT_SERVICE_KEY            # refunds for late payments
EMAIL_PROVIDER_API_KEY, EMAIL_FROM, DLQ_ALERT_TO
OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL
```

**booking-payment**

```
PORT, PAYMENT_SERVICE_KEY, KAFKA_BROKERS, MONGODB_URI, MONGODB_DB
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, LOG_LEVEL
```

---

## 11. Rules to follow from day one

1. **booking-app owns booking data.** Other services change it only through `/api/internal/*`.
2. **Thin routes, services own the rules, the DAL only queries.** No collection imports in routes.
3. **One response envelope, one `AppError`, one `apiFetch`, one `requireServiceAuth`, one
   `requireRole`.** Never duplicate them.
4. **Shared contracts:** event types, topics and zod schemas live in `packages/contracts`.
5. **Store times in UTC;** each resource has its own timezone.
6. **Guard against double booking in the database** (transaction lock and/or unique index).
   Redis locks are for UX only.
7. **Status transitions live in one file;** every update filters on the expected current status.
8. **Write events through the outbox** in the same transaction. Consumers are idempotent and
   end in a DLQ.
9. **Real-time events are signals.** Rooms are assigned by the server from the token, and
   identity never comes from the client.
10. **One secret per purpose.** Never log secrets or full requests.
11. **Cron runs only in the worker,** under a Redis leader lock.
12. **Every service** has a real `/health` route, graceful shutdown, OpenTelemetry and structured
    logs.
13. **Tests first** for availability calculation, the double-booking race, status transitions,
    and idempotent consumers.
