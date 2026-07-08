# Maestro — Core Module

Maestro is the Arpeggio API server. It implements persistence, business logic, HTTP routes, background jobs, and integrations. The **core** module is always enabled and provides the platform foundation that every feature module builds on.

Shared types and validators live in **armonia** (`../armonia`). Maestro imports schema-defs and Zod validators from armonia and implements the runtime layer on top.

## Responsibilities

- **Express API** with automatic route discovery under `modules/*/api/`
- **Mongoose** models, services, indexes, and view configs
- **Authentication**, permissions, rate limiting, and request validation middleware
- **CRUD router factory** for standard list/select/create/edit/delete/restore endpoints
- **Connections** to MongoDB, Redis, Kafka, WebSocket, and Telegram
- **Cron job engine** with distributed locking and handler registry
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
│   ├── plugins/      # ownership, audit, soft-delete Mongoose plugins
│   ├── schemas/      # Mongoose models (company, user, media, …)
│   ├── security/     # SchemaGuard — field-level read/write permissions
│   └── services/     # BaseCrudService and entity services
├── domain/           # Business logic (notifications, messages, finance, websocket)
├── environment/      # Config, constants, startup validator
├── kafka/            # Kafka producers/consumers
├── loggers/          # Winston-based server logging
├── utilities/
│   ├── endpoints/    # Route registry (auto-discovery)
│   ├── middlewares/  # auth, rate limiter, validateFormZod, dslFilter, …
│   ├── modules/      # ENABLED_MODULES resolution
│   └── …             # emails, gridfs, mappers, security, metrics
└── websocket/        # WebSocket server helpers

xServers/             # Process entry points (api, websocket, kafka, cron)
initializer/          # MongoDB bootstrap — core + optional module models
```

## Route discovery

`xServers/apiServer.ts` scans `modules/<name>/api/` for each enabled module and registers routes automatically via `createRouteRegistry`. Route files export:

```ts
export const basePath = "/api/company/users";
export const {router} = createCrudRouter({ /* … */ });
```

Nested folders under `api/` mirror URL structure. Files named `index.ts`, `*.route.ts`, or any `*.ts` (except `.d.ts`) are loaded.

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

Standard plugins: `ownershipPlugin`, `auditPlugin`, `softDeletePlugin`.

## Module selection

Set `ENABLED_MODULES` (comma-separated) to limit which folders under `modules/` load at runtime. When unset, every present module folder is enabled. `core` is always included.

Mirrors sinfonia's `VITE_ENABLED_MODULES` for client-side filtering.

## Path aliases

| Alias | Path |
|-------|------|
| `@coreModule/*` | `modules/core/*` |
| `@eCommerceModule/*` | `modules/eCommerce/*` |
| `@eCommerceMarketplaceModule/*` | `modules/eCommerceMarketplace/*` |
| `@propertyManagement/*` | `modules/propertyManagement/*` |
| `armonia/*` | `../armonia/*` |

## Server entry points

| Script | Entry | Purpose |
|--------|-------|---------|
| `npm run api:development` | `xServers/apiServer.ts` | REST API (dev, watches armonia) |
| `npm run websocket:development` | `xServers/webSocketServer.ts` | WebSocket server |
| `npm run kafka:development` | `xServers/kafkaServer.ts` | Kafka consumers/producers |
| `npm run cron:development` | `xServers/cronServer.ts` | Scheduled jobs |

## Related modules

Feature modules extend core and are documented separately:

- [`modules/eCommerce`](modules/eCommerce/README.md)
- [`modules/eCommerceMarketplace`](modules/eCommerceMarketplace/README.md)
- [`modules/propertyManagement`](modules/propertyManagement/README.md)

Armonia contract docs: [`../armonia/README.md`](../armonia/README.md)

## Development

```bash
npm run api:development   # start API with hot reload
npm test                  # vitest
npm run build             # compile TypeScript
```

Database initialization is controlled by `MONGO_DB.INIT` in environment config. See `initializer/index.ts` for core seed data and optional module model registration.
