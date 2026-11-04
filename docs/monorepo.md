# What a monorepo is, and how this one works

## The idea

A **monorepo** ("monolithic repository") keeps several related projects in **one Git repository** instead of one repo per app. CampusOps has four projects that must always agree with each other:

```
campusops/
├─ apps/
│  ├─ api/        Bun + Hono HTTP API, Drizzle ORM, PostgreSQL, jobs, OpenAPI
│  ├─ web/        React + Vite management website (staff only)
│  └─ mobile/     Expo / React Native app (students + organiser scanning)
├─ packages/
│  └─ shared/     TypeScript contracts: Zod schemas, enums, pure domain rules, UI labels
├─ e2e/           Playwright browser walkthroughs (run with Bun)
├─ docs/          This documentation, phase reports, audits
├─ scripts/       Sandbox restore helper
├─ package.json   Root: workspace list + shared scripts
├─ bun.lock       ONE lockfile for every workspace
├─ biome.json     ONE linter/formatter config
├─ tsconfig.base.json  ONE strict TypeScript baseline
├─ .env.example   Template for local secrets (never commit real .env)
├─ render.yaml    Render blueprint for the API
├─ vercel.json    Vercel config for the website
└─ .github/workflows/ci.yml   lint → typecheck → migrate → seed → test → build
```

Why not separate repos? The mobile app, website and API all validate the **same** rules (event windows, QR types, eligibility, role labels). With `packages/shared` there is exactly one definition; a change is type-checked against all three apps in the same commit. Separate repos would drift.

## Workspaces

Root `package.json`:

```json
"workspaces": ["apps/*", "packages/*"]
```

Each app/package has its own `package.json` with a name like `@campusops/api`. When one declares `"@campusops/shared": "workspace:*"`, Bun links the local folder instead of downloading from npm. So:

```ts
import { QR_TYPES, decideAccess } from "@campusops/shared";
```

resolves to `packages/shared/src/index.ts` in every app. Metro (mobile) is configured to watch the repo root so it picks up shared source changes too.

## One lockfile, one install

`bun install` at the root installs everything and writes `bun.lock`. Commit that file. CI and Render use `bun install --frozen-lockfile`, which fails if the lockfile and manifests disagree — that is how "works on my machine" version drift is prevented. Mobile Expo packages are **exact-pinned** and verified with `npx expo install --check` + `expo-doctor` (see [mobile.md](mobile.md)).

## Scripts

Root scripts delegate with `bun run --filter <workspace> <script>`:

| Command | What runs |
|---|---|
| `bun run dev:api` | root `.env.local` → `apps/api` → `bun run src/index.ts` (no hot reload) |
| `bun run dev:web` | root `.env.local` → `apps/web` → Vite (proxy follows `API_PORT`, then `PORT`) |
| `bun run dev:mobile` | root `.env.local` → `apps/mobile` → Expo LAN server |
| `bun run db:migrate / db:seed / db:check` | `apps/api` DB scripts |
| `bun run admin:bootstrap` | one-time first Admin creation (production) |
| `bun run test` | `apps/api` → `bun test` (uses `TEST_DATABASE_URL`) |
| `bun run lint / format` | Biome over the whole repo |
| `bun run typecheck` | `tsc --noEmit` in shared → api → web → mobile |
| `bun run build:web` | `tsc` + Vite production build → `apps/web/dist` |
| `bun run build:mobile:web` | Expo static web export → `apps/mobile/dist` |
| `bun run e2e:*` | Playwright suites in `e2e/` |

You can also run a workspace script from its app directory; run root commands instead so the root `.env.local` is loaded consistently.

## TypeScript path mapping

`tsconfig.base.json` is strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Each app extends it. Web/mobile map `@campusops/shared` to source for type-checking; the API resolves it through the workspace link. Nothing is compiled to `dist` for the API — Bun runs TypeScript directly.

## Rules of thumb

1. Add a dependency in the app that uses it (`cd apps/web && bun add -E <pkg>`), not at the root, unless every app needs it.
2. Put shared types/rules in `packages/shared`; never copy an enum into an app.
3. Run `bun run check` before committing; CI runs the same commands.
4. Never edit `bun.lock` by hand.
