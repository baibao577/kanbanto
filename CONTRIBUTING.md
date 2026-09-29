# Contributing

Thanks for helping with Kanbanto! Bug reports, ideas and pull requests are welcome at
[github.com/baibao577/kanbanto](https://github.com/baibao577/kanbanto/issues).

- **Found a bug?** Open an issue with what you did, what happened, and the server logs if relevant
  (see [Troubleshooting](docs/troubleshooting.md#still-stuck)).
- **A security problem?** Please report it privately — see [SECURITY.md](SECURITY.md).
- **A bigger change?** Open an issue first to talk it through, so your work fits where the project is going.

## Development setup

You need **Node.js 24**, **pnpm 10** (`corepack enable` sets it up) and **Docker** (for PostgreSQL).

```bash
pnpm install
pnpm db:up                                   # PostgreSQL (port 5433, plus a test database) and Mailpit in Docker
cp apps/server/.env.example apps/server/.env
pnpm dev                                     # web on http://localhost:5173, API on :3000 (Vite passes /api through)
```

Sign up at <http://localhost:5173>, then make yourself admin: `pnpm admin grant you@example.com`. The server makes its
own encryption key the first time it starts (in `apps/server/data/config`, ignored by git).

In development, emails go to **Mailpit**, a pretend inbox: read them at <http://localhost:8025>. To try the Platform
console's email settings instead, comment out `SMTP_URL` in `apps/server/.env` (set up SMTP there with server
`localhost`, port `1025`, encryption None). Or set `MAIL_TRANSPORT=log` to print emails in the `pnpm dev` terminal,
which also accepts any Resend key.

| Script (from the root) | What it does |
|---|---|
| `pnpm dev` | Web (Vite, hot reload) and API server (tsx watch) |
| `pnpm build` | Type-check and build the web app, then bundle the server |
| `pnpm start` | Run the built server (serves the web build if `WEB_DIST` is set) |
| `pnpm test` | Model, server (against the `kankan_test` database) and web tests |
| `pnpm lint` / `pnpm typecheck` | Oxlint / TypeScript in every package |
| `pnpm format` / `pnpm format:check` | Prettier: format everything / check it's formatted |
| `pnpm db:generate` | After changing `apps/server/src/db/schema.ts`: write a new SQL migration |
| `pnpm db:migrate` | Apply migrations now (the server also does this on start) |
| `pnpm admin grant\|revoke\|list` | Platform admins |

To try the production image locally: `docker compose up -d --build --wait` (see the [README](README.md)).

[Architecture](docs/architecture.md) explains how the pieces fit together, and where to add things (a command, a view,
an email, a setting).

## Before you open a pull request

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The same checks run on every pull request (GitHub Actions), with the Docker build.

- **Add tests** for model rules (`packages/model`), server routes (`apps/server/test`) and web logic (next to the file,
  as `*.test.ts`).
- **Board rules live in `packages/model`.** The server re-runs the same commands, so a rule enforced only in the UI
  isn't enforced.
- **Database changes:** edit `apps/server/src/db/schema.ts`, then `pnpm db:generate`. **Never edit or regenerate a
  migration that's already committed** — existing installs have applied it. Add a new one instead.
- Some internal names still say `kankan` (the database, the session cookie, browser storage keys). Keep them: renaming
  would sign everyone out or break existing installs.

## Style

- TypeScript everywhere, formatted with Prettier (`pnpm format`; `.editorconfig` covers the rest).
- UI: shadcn/ui components, Tailwind with the design tokens in `apps/web/src/index.css` (no raw colours), Phosphor
  icons.
- **Words people see are plain language.** "Turn off sign-up", not "Disable registration". Error messages say what
  happened and what to do next.

## License of contributions

Kanbanto is distributed under the [Sustainable Use License](LICENSE.md), and its maintainer (baibao577) also offers it
under commercial licenses. So that both stay possible, by submitting a contribution (a pull request, a patch or
anything else meant to be included in Kanbanto) you:

- confirm it's your own work, or that you otherwise have the right to submit it under these terms;
- grant baibao577 a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, modify,
  sublicense and distribute your contribution, as part of Kanbanto or on its own, under the Sustainable Use License,
  under commercial licenses, or under any other license;
- keep the copyright in your contribution: this is a license, not a transfer.

If your employer has rights to your work, make sure they agree before you contribute. A formal contributor license
agreement may replace this section later; contributions made before then stay under these terms.
