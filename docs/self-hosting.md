# Self-hosting Kanbanto

This guide is for running Kanbanto on a server for a team, company or group: your own domain, HTTPS, email, file
storage, backups and upgrades. Just want to try it on your own computer? Follow the
[quick start in the README](../README.md#run-it-on-your-computer) instead.

**Contents**
[What you need](#what-you-need) ·
[Install](#install) ·
[HTTPS](#https) ·
[First admin](#first-admin-and-who-can-sign-up) ·
[Email](#email) ·
[File storage](#file-storage) ·
[Backups](#backups) ·
[Upgrades](#upgrades) ·
[Other ways to run it](#other-ways-to-run-it) ·
[Security checklist](#security-checklist) ·
[Limits](#limits)

## What you need

| | |
|---|---|
| **A server** | Any Linux server or VM. 1 CPU and 1 GB RAM runs a small team; building the image needs about 2 GB (add swap on a 1 GB machine). A few GB of disk, plus room for attachments if you keep them on the server. |
| **Docker** | [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin (`docker compose version` should work). On Mac or Windows, Docker Desktop, which needs a paid subscription at larger companies. |
| **A domain** (recommended) | A name like `kanbanto.example.com`, with a DNS **A record** pointing at your server. Needed for HTTPS and for email. |
| **Open ports** | 80 and 443 (for the HTTPS add-on). Nothing else needs to be public. |
| **Optional** | For email: your organisation's mail server, an email service with SMTP, or a [Resend](https://resend.com) account. For files: a Cloudflare R2 / Amazon S3 / MinIO bucket. |

Kanbanto is one container (the web app and its API together) plus PostgreSQL. It updates its database by itself
when it starts.

## Install

**1. Get the code**

```bash
git clone https://github.com/baibao577/kanbanto.git kanbanto
cd kanbanto
```

**2. Choose how people will reach it** — decide this first, because it changes the settings:

| | For | Settings |
|---|---|---|
| **A. The HTTPS add-on** | A server with a domain and nothing else on ports 80/443 (the simplest) | `DOMAIN`, `COMPOSE_FILE` |
| **B. Your own proxy** | nginx, Traefik or a load balancer already handles HTTPS | `BIND_ADDRESS`, `TRUST_PROXY` |
| **C. Your network only** | An office network, no domain, no HTTPS | nothing extra |

**3. Create your settings file**

```bash
cp .env.example .env
```

Open `.env` and set:

| Setting | What to put |
|---|---|
| `APP_URL` | The address people will use, e.g. `https://kanbanto.example.com` (for C: `http://<server-ip>:3000`) |
| `POSTGRES_PASSWORD` | A long random password (`openssl rand -hex 24`). Set it **before the first start**. |
| A: `DOMAIN` | Your domain without `https://`, e.g. `kanbanto.example.com` |
| A: `COMPOSE_FILE` | `docker-compose.yml:deploy/docker-compose.https.yml` (so every `docker compose` command includes the add-on) |
| B: `BIND_ADDRESS` | `127.0.0.1`, so only your proxy on this machine can reach Kanbanto |
| B: `TRUST_PROXY` | `1` (one proxy in front), so Kanbanto sees each visitor's real address and that they use HTTPS |

Every setting is explained in [Configuration](configuration.md).

**4. Start it**

```bash
docker compose up -d --build --wait
```

The first build takes a few minutes; the command returns once Kanbanto is running. Check:

```bash
curl http://localhost:3000/api/health     # → {"ok":true}
```

> **The encryption key.** Email keys, mail server passwords and storage keys you save in the Platform console are
> encrypted with a key Kanbanto makes the first time it starts. It's kept in a Docker volume, never in the database, so
> a stolen database backup doesn't reveal them. **Keep a copy** with your backups:
> `docker compose exec app node dist/cli.js key` shows it. Lost it? Nothing on the boards is lost; you'd re-enter those
> keys in the console.

## HTTPS

Kanbanto should always be reached over HTTPS on a server: sign-in cookies are marked secure when the request came over
HTTPS, and browsers need it for some features.

### Option A: the built-in HTTPS add-on (simplest)

It adds [Caddy](https://caddyserver.com), which gets and renews a free certificate for your domain automatically.

1. Your domain's DNS A record points at the server, and ports 80 and 443 are open.
2. In `.env`: `DOMAIN`, `APP_URL=https://…` and `COMPOSE_FILE` as above.
3. `docker compose up -d --build --wait`, then open `https://kanbanto.example.com`.

Kanbanto itself now listens only on `127.0.0.1`, behind Caddy, and trusts Caddy's forwarded headers (the add-on sets
`TRUST_PROXY=1` for you).

### Option B: your own reverse proxy (nginx, Traefik, a load balancer…)

In `.env`, set `BIND_ADDRESS=127.0.0.1` and `TRUST_PROXY=1` (or your proxy's address, like `10.0.0.5`, if it runs on
another machine: then leave `BIND_ADDRESS` out). Point the proxy at `http://127.0.0.1:3000`. It must:

- pass the original **Host** header (Kanbanto refuses changes from other sites by comparing the browser's Origin to it);
- set **X-Forwarded-Proto** (so Kanbanto knows the request was HTTPS) and **X-Forwarded-For** to the visitor's address;
- allow **WebSocket upgrades** on `/api/boards/…/live` (for live updates);
- allow request bodies of at least 20 MB (board imports), or your largest-file setting if that's bigger.

For nginx:

```nginx
server {
    listen 443 ssl;
    server_name kanbanto.example.com;
    # ssl_certificate … ;  ssl_certificate_key … ;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

> Why `BIND_ADDRESS` and not a firewall rule? Ports that Docker publishes skip firewalls like UFW and firewalld, so a
> "deny 3000" rule wouldn't stop anyone. Binding to `127.0.0.1` does.

## First admin and who can sign up

1. Open your Kanbanto address and **create your account**.
2. Make it the **platform admin** on the server (admin rights are only ever given this way, never through the website):

   ```bash
   docker compose exec app node dist/cli.js admin grant you@example.com
   ```

3. Refresh: **Platform console** appears in the menu under your initials.

**For an internal team**, turn off open sign-up in **Platform console → Accounts → Anyone can create an account**.
People can then only join through a board's share link, access code or email invite, or a workspace's invite.

Other server commands (all run as `docker compose exec app node dist/cli.js …`):

| Command | Does |
|---|---|
| `admin grant <email>` / `admin revoke <email>` | Give or take away platform admin rights |
| `admin list` | Who the platform admins are |
| `user password <email>` | Set a temporary password for an account — e.g. you're the only admin and forgot your password |
| `key` | Show the encryption key in use, to keep a copy |
| `secret` | Print a new random key, if you'd rather set `ENCRYPTION_KEY` yourself |

The platform admin manages accounts (turn them off, give password reset links), email and storage, but **can't open
people's boards** unless someone shares a board with them.

Turning an account off keeps the person out: it's signed out everywhere, and its API tokens, connected apps and
calendar link are removed, along with the share links, access codes and waiting invites of the boards it owns and the
workspaces it runs (see [SECURITY.md](../SECURITY.md)).

**What to send your team:** the [guides](../guides/) explain Kanbanto to the people using it. **Guides** in the account
menu opens them (`GUIDES_URL` points it at your own copy, or takes it out).

## Email

Optional, but it enables confirming new accounts' addresses, **forgot password**, **invites by email**, **reminders by email**, and a **morning
summary** of what's due and who mentioned you. Kanbanto sends through your organisation's mail server or any email service (SMTP), or through
Resend: see **[Email](email.md)** for the settings of Microsoft 365, Google Workspace, Amazon SES and others.

## Calendars

Optional: people can see their cards' due dates and reminders in **Google Calendar** (kept up to date within
seconds), or in any calendar app through a private **calendar link**. Both are off until you turn them on in
**Platform console → Integrations**; Google Calendar needs a Google app that you make once. See
**[Calendar](calendar.md)**.

## Your own pages

A privacy policy, terms or an about page for your site: put them in a `pages` folder and Kanbanto serves them, with
links under the sign-in form. See **[Your own pages](configuration.md#your-own-pages)**.

## File storage

Card and comment attachments are stored on **the server's disk** by default (the `uploads` Docker volume), which is
fine for most teams. To keep files elsewhere, use any **S3-compatible bucket**:

| Provider | Endpoint | Region |
|---|---|---|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` (EU: `…eu.r2.cloudflarestorage.com`) | leave empty (`auto`) |
| Amazon S3 | `https://s3.<region>.amazonaws.com` | e.g. `eu-west-1` |
| MinIO | the address people's browsers reach it at, e.g. `https://files.example.com` | leave empty, unless your MinIO has a region set |
| Others (Backblaze B2, Wasabi…) | the provider's S3 endpoint | as the provider says |

**Cloudflare R2, step by step:**

1. Cloudflare dashboard → **R2 Object Storage** (turn it on the first time) → **Create bucket**, e.g. `kanbanto-files`.
   Leave public access **off** — Kanbanto uses short-lived signed links.
2. R2 → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to **that bucket only**.
   Copy the **Access Key ID**, the **Secret Access Key** (shown once) and the **S3 endpoint**.
3. Kanbanto → **Platform console → Storage → Use an S3 / R2 bucket**: fill in endpoint, bucket, keys →
   **Test and save**. Kanbanto writes and deletes a small test file before saving.

**MinIO, step by step** (tried with MinIO `RELEASE.2026-09-22`, with and without a region):

1. In MinIO, make a bucket, e.g. `kanbanto-files`, and an access key that can read and write it. Leave the bucket
   private.
2. Kanbanto → **Platform console → Storage → Use an S3 / R2 bucket**. **Endpoint** is MinIO's S3 address (the API
   port, 9000 unless you changed it, not the console's). Leave **Region** empty, unless your MinIO has one set
   (`MINIO_SITE_REGION`): then put that one in. If it's wrong, the test says which region the storage is set to.
3. **Test and save.**

Two things to get right, because a file opens in the person's browser through a short-lived link straight to MinIO:

- **The endpoint has to be an address people's browsers can reach**, not only the server. A name that only exists
  inside Docker (`http://minio:9000`) saves and uploads fine, and then no file opens. Use the address you'd type in a
  browser.
- **If Kanbanto is on `https://`, put MinIO on `https://` too.** Browsers don't show pictures from an `http://`
  address on an `https://` page.

MinIO as the site's storage may be on your private network. People's own buckets (Account settings) may not: see
below.

No CORS setup is needed. **Switching storage never breaks files already uploaded**, and doesn't move them by itself:
each file keeps opening from where it was saved. Switch back with **Stop using it**.

After a switch, the Storage page lists the **files kept elsewhere** (on the server's disk, or in a bucket used
earlier):

- **Move here** moves them to the storage in use, one by one, while Kanbanto stays usable. Stopping part-way is safe:
  what's left stays where it was.
- **Update keys** gives an earlier bucket new keys, for when its key was changed or revoked at the provider. Until
  then its files don't open.
- **Use again** makes an earlier bucket the storage in use again. Saving a bucket Kanbanto already knows brings its
  setting back, with the keys given now.
- **A bucket whose address changed** (a new domain, an inside name replaced by a public one): save it under the new
  address, then **Move here** from the earlier setting. Kanbanto checks whether the two are one and the same bucket;
  if so it copies and removes nothing, and only notes the new address for each file.

Keep an earlier bucket and its key until its files are moved. Once it holds no files it leaves the list, and Kanbanto
deletes its saved keys.

**Limits** (Platform console → Storage): space per person (default 50 MB, in total across all the boards they own) and
the largest file (default 10 MB). People can connect **their own bucket** (Account settings → File storage) for
unlimited space on their boards, and move the files already on their boards into it (or back, as far as their space
allows). Their buckets must be at a public `https://` address: Kanbanto won't connect to
private network addresses for them. (The site's own bucket, set by platform admins, may be anywhere, e.g. a MinIO on
your network.)

## Backups

Back up four things: **the database**, **the attachments** (if they're on the server's disk), **the encryption key**
and **your `.env` file**. Run these in the Kanbanto folder:

```bash
mkdir -p backups

# 1. The database (boards, accounts, comments, settings)
docker compose exec -T db pg_dump -U kankan -d kankan -Fc > backups/kanbanto-$(date +%F).dump

# 2. Attachments kept on the server's disk
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint tar app \
  czf /backup/uploads-$(date +%F).tgz -C /data/uploads .

# 3. The encryption key, and 4. your settings (keep these private: they unlock saved keys and the database)
docker compose exec -T app node dist/cli.js key > backups/encryption-key-$(date +%F).txt
cp .env backups/env-$(date +%F).txt
```

Copy the `backups` folder off the server (another machine, cloud storage). A daily cron job running these lines is a
good habit. Files in an R2/S3 bucket are already off the server; use your provider's own tools to back those up.

### Restore

On a fresh install, started once so the database exists. If it's a new server, first put the saved key in `.env` as
`ENCRYPTION_KEY=…` (and restart with `docker compose up -d --wait`), so the saved email and storage keys can be read.

```bash
docker compose stop app
docker compose exec -T db pg_restore -U kankan -d kankan --clean --if-exists < backups/kanbanto-2026-09-30.dump
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint sh app \
  -c 'tar xzf /backup/uploads-2026-09-30.tgz -C /data/uploads && chown -R node:node /data/uploads'
docker compose start app
```

**From the README's copy** (`kanbanto-backup.dump` and the `kanbanto-files` folder), on any computer:

```bash
docker compose stop app
docker compose cp ./kanbanto-backup.dump db:/tmp/kanbanto.dump
docker compose exec db pg_restore -U kankan -d kankan --clean --if-exists /tmp/kanbanto.dump
docker compose cp ./kanbanto-files/. app:/data/uploads/
docker compose run --rm --no-deps --user root --entrypoint chown app -R node:node /data/uploads
docker compose start app
```

## Upgrades

Releases are listed on GitHub with what changed in each (also in the [changelog](../CHANGELOG.md)).

```bash
cd kanbanto
# 1. Back up first (see above)
git pull                                   # or: git checkout v0.2.0, for a specific release
docker compose up -d --build --wait
```

Database changes are applied automatically when the new version starts. Check the logs if anything looks wrong:
`docker compose logs --tail 100 app`.

## Other ways to run it

### A platform like Railway, Render or Fly.io

Deploy from the repository's `Dockerfile`, add a PostgreSQL database, and set the environment variables from
[Configuration](configuration.md):

- `DATABASE_URL`, `APP_URL`, and `PORT` if the platform assigns one;
- **`ENCRYPTION_KEY`** (`openssl rand -base64 32`): platforms usually don't keep files between deploys, so Kanbanto
  can't keep a key it makes itself;
- **`TRUST_PROXY=1`**: the platform's proxy is in front of Kanbanto.

**Files:** most platforms wipe the container's disk on each deploy. Either attach a persistent volume at
`/data/uploads`, or (easier) use an R2/S3 bucket for file storage. **Server commands** (`admin grant` …) run in the
platform's shell or one-off command: `node dist/cli.js admin grant you@example.com` (working directory `/app/server`).
Health check: `GET /api/health`.

### Without Docker

You need Node.js 24, [pnpm](https://pnpm.io) and PostgreSQL 15 or newer.

```bash
pnpm install
pnpm build
cp apps/server/.env.example apps/server/.env
# Edit apps/server/.env: DATABASE_URL, APP_URL, WEB_DIST=../web/dist, UPLOADS_DIR=/var/lib/kanbanto/uploads,
# KEY_FILE=/var/lib/kanbanto/encryption.key, and TRUST_PROXY=1 behind a proxy on this machine. Remove the SMTP_URL /
# SMTP_FROM lines (they point at a development inbox), or set your own mail server there.
NODE_ENV=production pnpm start
```

Run it under a process manager (systemd, pm2) and put a reverse proxy with HTTPS in front (see Option B above).

## Security checklist

- [ ] HTTPS in front of Kanbanto (Option A or B), and nothing else can reach port 3000 (`BIND_ADDRESS=127.0.0.1`).
- [ ] `APP_URL` is your real `https://` address, and `TRUST_PROXY` matches your setup: set with a proxy in front, not
      set without one.
- [ ] Your own `POSTGRES_PASSWORD` (not the default), set before the first start. (Kanbanto says so in its log at
      start if it's still the default.)
- [ ] Open sign-up turned off, if it's for an internal team.
- [ ] Backups running and copied off the server, including the encryption key. Store the key and `.env` like passwords.
- [ ] The database port stays private (by default it listens only on `127.0.0.1:5433`).
- [ ] Keep Kanbanto updated. Security reports: see [SECURITY.md](../SECURITY.md).

## Limits

- **One Kanbanto container at a time.** Live updates are coordinated inside the running server, so don't run several
  copies behind a load balancer (see [Architecture](architecture.md#scaling)).
- **Email:** Resend, or an SMTP server with a username and password or none. Signing in to SMTP with OAuth
  (Microsoft 365, Google) isn't supported yet: use a connector or relay instead (see [Email](email.md)).
- **Sign-in:** email and password (no single sign-on yet).
