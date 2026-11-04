# CampusOps developer documentation

Start here. Everything below is written for a developer who has never seen this repository.

| Guide | What it answers |
|---|---|
| [Getting started](getting-started.md) | Install tools, create the database, fill `.env`, run API + website + mobile locally |
| [Monorepo explained](monorepo.md) | What a monorepo is, how workspaces/imports/lockfile/scripts work here |
| [Environment variables](environment.md) | Every variable, where it goes (local / Render / Vercel / mobile), what is secret |
| [Architecture](architecture.md) | Request flow, auth/sessions, roles, approvals, QR rules, storage, jobs |
| [Testing](testing.md) | Unit/integration tests, browser e2e, mobile e2e, how to add tests, CI |
| [Deployment](deployment.md) | Neon → Render API → Vercel website → mobile builds, first Admin, email, S3, cron |
| [Troubleshooting](troubleshooting.md) | The errors you are most likely to hit and their fixes |
| [Security notes](security.md) | Threat model, what is enforced where, known limits |

Latest phase record: [Phase 6 report](phase6-report.md) · [Phase 6 critic audit](phase6-audit.md) · [verification log](phase6-verification.log). Earlier records and audits: `phase1-*` … `phase5-*`. Scope split between the two evaluations: [evaluation-scope.md](evaluation-scope.md).

## 60-second version

```powershell
bun install
Copy-Item .env.example .env.local
# Edit app-specific env files, then:
bun run db:migrate
bun run dev:api
bun run dev:web
bun run dev:mobile
```

Demo logins exist only when `SEED_DEMO_PASSWORD` is set locally. Production has no demo accounts; create the first Admin with `bun run admin:bootstrap`.
