# Maestro — Core Module

Maestro is the Arpeggio API server. It implements persistence, business logic, HTTP routes, background jobs, and integrations. The **core** module is always enabled and provides the platform foundation that every feature module builds on.

Shared types and validators live in **armonia** (`../armonia`). Maestro imports schema-defs and Zod validators from armonia and implements the runtime layer on top.

## Responsibilities

- **Express API** with automatic route discovery under `modules/*/api/` (same-origin behind nginx — see `solfeggio/clusters/nginx/conf/gateway.conf`; this process does not apply CORS middleware)
- **Mongoose** models, services, indexes, and view configs
- **Authentication**, permissions, rate limiting, and request validation middleware
- **CRUD router factory** for standard list/select/create/edit/delete/restore endpoints
- **Connections** to MongoDB, Redis, Kafka, WebSocket, and Telegram
- **Cron job engine** (`cronjobs/engine`, `xServers/cronServer.ts`) with distributed locking and handler registry. The HTTP surface is manage-only (list, edit schedule/ops, run/pause/resume); create/delete are rejected. Jobs are seeded from registered handlers.
- **Notifications**, emails, media (GridFS), and audit logging
- **Environment** configuration and startup validation

## Directory layout

```
modules/core/
├── api/              # HTTP route handlers (company, user, finance, auxiliary)
├── connections/      # MongoDB, Redis, Kafka, WebSocket, Telegram clients
├── cronjobs/         # Cron engine, scheduling, locking, handler bootstrap
├── database/
│   ├── collections/  # Model registry and collected field metadata
│   ├── filter/       # DSL filter parsing for table/list queries
│   ├── plugins/      # ownership, audit, soft-delete, lifecycle, publicMedia
│   ├── schemas/      # Mongoose models (company, user, media, …)
│   ├── security/     # SchemaGuard — field-level read/write permissions
│   └── services/     # BaseCrudService and entity services
├── domain/           # Business logic (notifications, messages, chat, publicChat, ai, websocket)
├── environment/      # Config, constants, startup validator
├── kafka/            # Kafka producers/consumers
├── loggers/          # Winston-based server logging
├── modules.manifest.json  # The one module manifest: required modules and `dependsOn` (D01a)
├── utilities/
│   ├── endpoints/    # Route registry (auto-discovery)
│   ├── middlewares/  # auth, rate limiter, validateFormZod, dslFilter, …
│   ├── modules/      # ENABLED_MODULES resolution against the manifest
│   ├── erasure/      # Person erasure seam (modules plug in erasers, D57)
│   └── …             # emails, gridfs, mappers, security, metrics
└── websocket/        # WebSocket server helpers

xServers/             # Process entry points (api, websocket, kafka, cron, assistant, telegram)
initializer/          # MongoDB bootstrap — core + optional module models
```

## Route discovery

`xServers/apiServer.ts` scans `modules/<name>/api/` for each enabled module and registers routes automatically via `createRouteRegistry`. Route files export:

```ts
export const basePath = "/api/company/users";
export const {router} = createCrudRouter({ /* … */ });
```

Nested folders under `api/` mirror URL structure. Every code file is loaded except declarations and `*.test`/`*.spec` files; the loaders match the running extension (`.ts` in development, `.js` in production) through `modules/core/utilities/modules/moduleCodeFiles.ts`.

## CRUD router pattern

Most resources use `createCrudRouter` from `modules/core/api/crudRouterFactory.ts`. It wires:

- Auth + rate limiting + schema sanitization + DSL filters
- Zod validation (validators imported from **armonia**)
- `BaseCrudService` for list, select, single, create, edit, delete, restore
- Permission-aware field filtering via `SchemaGuard`
- Optional custom middleware (e.g. media upload)

## Database schema conventions

Each resource under `database/schemas/<resource>/` typically includes:

| File | Purpose |
|------|---------|
| `<resource>.ts` | Mongoose schema and model; validates against armonia `*SchemaDef` |
| `<resource>.service.ts` | Service class extending `BaseCrudService` |
| `<resource>.indexes.ts` | Index definitions |
| `<resource>.snippets.ts` | Reusable populate/projection snippets |
| `<resource>.views.ts` | View configs for sinfonia view engine |
| `<resource>.actions.ts` | Custom document actions (optional) |

Standard plugins: `ownershipPlugin`, `auditPlugin`, `softDeletePlugin`, `lifeCyclePlugin`. `publicMediaPlugin` marks SchemaDef `publicAccess` media. Not every schema takes the full stack.

## Platform lists (D160)

Countries, states, cities and currencies belong to the platform company (`Company.isPlatformOwner`) and are shared by every company: `ownershipPlugin(…, {tenantScoped: false})`, seeded once for the platform in `createCompanies`. Their CRUD routes spread `platformListRouteOptions` (`modules/core/api/platformListRoute.ts`): every company reads and selects the platform's rows, only a session in the platform company writes them (`platform_company_required`). Records in any company reference these rows directly; never look them up with a `company` filter or copy them.

A list becomes requestable with `requestablePlugin` (`database/plugins/requestablePlugin.ts`): a company other than the platform that holds the model's `request` action permission creates a missing entry with the list's own create route, and the row is stored as `requestStatus: "requested"` (with `requestedAt`, `requestedBy`, `requestedByCompany(Name)`), seen only by that company and the platform and offered by no select. Decisions record `decidedAt`, `decidedBy` and `decisionNotes`; a rejected or withdrawn entry keeps that status and is deleted, and cannot be restored (`entry_request_closed`); the company requests it again instead; the sheet shows them in `requestSheetGroup`, whose requesting company opens through `POST /api/companies/single` (a company the user belongs to, or any company for an admin of the platform company). The router gets `approve` and `reject` (permission `decideRequest`, platform only; reject deletes the row and needs a reason) and `withdraw` (permission `request`, the requesting company only), from `api/requestableActions.ts`. Notifications: `ENTRY_REQUESTED`, `ENTRY_REQUEST_APPROVED`, `ENTRY_REQUEST_REJECTED`.


## Address books (D163)

A person's saved addresses are core `UserAddress` (`api/user/private/userAddress.ts`, `/api/user/userAddress`): one book per person, stored in the platform company and shown on every site they sign in to. Every route, including the storefront `/my` routes and `setDefault`, reaches only the caller's own rows (`userAddressService.bookClause`). A shop's staff read their buyers' books through eCommerce's `productOrder/customerAddresses` action, read-only; an order keeps its own copy of the address it ships to.

## Platform-only models (D161)

`platformOnlyPlugin(schema)` makes a model the platform company's: `createCrudRouter` refuses its routes and actions to any other company (`platform_company_required`), and the access map reports no access there, so the panel hides it. A module lets its companies keep their own rows by listing the model in its `moduleBootstrap.platformOnlyUses` (registered under the module's folder name; core names no module). Mail servers (`SmtpServer`, listed by Swiss Outreach) and messaging providers (`MessagingProvider`) use it: `sendMail` sends every company's mail through the platform's servers, from their address under the company's name with Reply-To the company, and `sendMessagingNotification` uses the platform's provider. Swiss Outreach sends campaigns with `sendMail(companyId, mail, {ownServers: true})`, through the company's own servers (the platform's when it has none).

## Module selection

Set `ENABLED_MODULES` (comma-separated) to limit which folders under `modules/` load at runtime. When unset, every present module folder is enabled. `core` is always included, and each requested module brings the modules it `dependsOn` in `modules/core/modules.manifest.json` (the one manifest, also read by the sinfonia build and the root checks).

Mirrors sinfonia's `VITE_ENABLED_MODULES` for client-side filtering.

## Path aliases

| Alias | Path |
|-------|------|
| `@coreModule/*` | `modules/core/*` |
| `@eCommerceModule/*` | `modules/eCommerce/*` |
| `@financeModule/*` | `modules/finance/*` |
| `@propertyManagement/*` | `modules/propertyManagement/*` (no `Module` suffix) |
| `@propertyDevelopmentModule/*` | `modules/propertyDevelopment/*` |
| `@carRentalModule/*` | `modules/carRental/*` |
| `@dentalClinicModule/*` | `modules/dentalClinic/*` |
| `@swissOutreachModule/*` | `modules/swissOutreach/*` |
| `@initializer` | `initializer/index.ts` |
| `armonia/*` | `../armonia/*` |

## Server entry points

| Script | Entry | Purpose |
|--------|-------|---------|
| `npm run api:development` | `xServers/apiServer.ts` | REST API (dev, watches armonia) |
| `npm run websocket:development` | `xServers/webSocketServer.ts` | WebSocket server |
| `npm run kafka:development` | `xServers/kafkaServer.ts` | Kafka consumers/producers |
| `npm run cron:development` | `xServers/cronServer.ts` | Scheduled jobs |
| `npm run assistant:development` | `xServers/assistantServer.ts` | AI assistant (chat channel bot) |
| `npm run telegram:development` | `xServers/telegramServer.ts` | Telegram bot |

**Production runtime (D106):** `npm run build` emits maestro and armonia JavaScript into `dist/` (`tsconfig.build.json`, `noEmitOnError`) and copies the non-TypeScript assets beside it (`scripts/build/copyRuntimeAssets.mjs`). The plain scripts (`npm run api`, `kafka`, `websocket`, `cron`, `assistant`, `telegram`) run that output with `node --enable-source-maps -r tsconfig-paths/register` from `dist/maestro`, which is `/maestro` in the image; they do not work from the source folder. The build also emits every operator script as `scripts/<name>.js`; the `npm run` forms of `kafka:replay-dlq`, `sync:demo-companies` and `health:rewrap-keys` use ts-node and need the sources, so in a container run the compiled file with the same arguments: `docker exec maestroApi-<instance> node -r tsconfig-paths/register scripts/<name>.js` (`replayKafkaDeadLetters.js <topic> [--execute]`, `syncDemoCompanies.js`, `rewrapHealthDataKeys.js`; solfeggio README, "Managing running services").

The root `npm run dev -- up <profile>` starts a whole vertical with its own database, Redis DB, Kafka prefix and ports ([`../scripts/dev/README.md`](../scripts/dev/README.md)).

## Related modules

Feature modules extend core and are documented separately:

- [`modules/eCommerce`](modules/eCommerce/README.md)
- [`modules/propertyManagement`](modules/propertyManagement/README.md)
- [`modules/propertyDevelopment`](modules/propertyDevelopment/README.md)
- [`modules/carRental`](modules/carRental/README.md)
- [`modules/dentalClinic`](modules/dentalClinic/README.md)
- [`modules/swissOutreach`](modules/swissOutreach/README.md)
- `modules/finance` (invoices, payments, Stripe) has no README of its own.

Armonia contract docs: [`../armonia/README.md`](../armonia/README.md)

## Development

```bash
npm run api:development   # start API with hot reload
npm test                  # vitest (needs no .env: vitest.config.ts supplies test defaults)
npm run lint              # ESLint governance rules
npm run build             # compile TypeScript
```

Database initialization is controlled by `MONGODB_INIT` (`MONGO_DB.INIT` in the environment config). See `initializer/index.ts` for core seed data and optional module model registration.

## TypeScript (do not flip global `strict`)

`maestro/tsconfig.json` leaves `strict`, `noImplicitAny`, and `strictNullChecks` **off**. Turning them on for the whole package is out of scope: Core factories still use `form: any`, `asyncHandler`, and `createCrudRouter` config `any`. New code is written as if those flags were on (TS-01, `docs/architecture/rules/typescript.md`). TypeScript is 5.9.3, the same version as armonia and sinfonia. `eslint.config.mjs` holds the governance rules only: no `console.*` outside tests (D38, use the logger) and no date-fns/moment (D36). The root `npm run lint` freezes existing findings in a baseline.

## New non-CRUD handlers: `AuthenticatedMWType` vs Zod form

For **new** routes only, type the handler as `AuthenticatedMWType & SomeFormType` after `authMW("private")` + `validateFormZod`. Canonical: `modules/propertyManagement/api/realEstate/private/dashboard.ts`. Do not fold form fields into `AuthenticatedMWType`. Do not rewrite `createCrudRouter`.

## MongoDB driver

Maestro stays on `mongodb` ^4 (Mongoose 6). Filter **types** live in Armonia; Mongo query handlers (`OPERATOR_HANDLERS`) live in `modules/core/database/filter/operators.ts` so they use this package's driver. Do not bump Maestro's `mongodb` major without a Mongoose upgrade.

## Dates

dayjs is the only date library in all three packages (D36). Business rules ("today", expiry) use the company timezone; calendar values are local `YYYY-MM-DD` strings.

## Token refresh

Login issues `JWT_EXPIRES_IN` (access) and `REFRESH_TOKEN_EXPIRES_IN` (refresh). `SESSION_EXPIRES_IN` is the server session/cookie TTL. There is no refresh HTTP route. The panel stores the refresh token and, on 401, shows relogin (`markSessionExpired`). Adding silent refresh needs a product check against those TTLs.

