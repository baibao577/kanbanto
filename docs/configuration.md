# Configuration

Kanbanto is configured in three places:

1. **The `.env` file** — a few settings for the server itself (addresses, network, secrets). Changed rarely; apply
   them with `docker compose up -d --wait`.
2. **The Platform console** — everything else, changed in the browser by a platform admin, no restart needed.
3. **Server commands** — for the few things that must not be possible from the website (like making someone admin).

## 1. The `.env` file

With Docker Compose, put these in `.env` next to `docker-compose.yml` (start from `.env.example`).

| Setting | Default | What it's for |
|---|---|---|
| `APP_URL` | `http://localhost:<PORT>` | The address people use to open Kanbanto, without a trailing slash. Used in links inside emails. Set it to your real `https://` address on a server. |
| `POSTGRES_PASSWORD` | `kankan` | The database password. Only takes effect when the database is first created (see [Troubleshooting](troubleshooting.md#i-changed-postgres_password-and-now-kanbanto-cant-connect)). |
| `PORT` | `3000` | The port Kanbanto is reachable on, on this machine. |
| `BIND_ADDRESS` | all addresses | `127.0.0.1`: reachable from this machine only (e.g. behind your own proxy on it). |
| `TRUST_PROXY` | none | How many proxies are in front of Kanbanto (`1` for one nginx or Caddy), or their addresses (`10.0.0.5,172.16.0.0/12`). Kanbanto then believes their `X-Forwarded-*` headers for the visitor's address (rate limits) and HTTPS (secure cookies). The HTTPS add-on sets it. Never set it without a proxy: anyone could then claim any address. |
| `ENCRYPTION_KEY` | made on first start | The key that encrypts the email keys, mail server passwords and storage keys saved in the Platform console: 32 random bytes in base64. Without it, Kanbanto makes one and keeps it in the `config` volume (`node dist/cli.js key` shows it). Set it to bring the key from a backup or another server. |
| `SMTP_URL` | — | Send email through this SMTP server instead of setting email up in the Platform console, e.g. `smtp://user:password@smtp.example.com:587`. See [below](#smtp_url). |
| `SMTP_FROM` | — | The sender for `SMTP_URL`, e.g. `Kanbanto <kanbanto@example.com>`. Required with `SMTP_URL`. |
| `GUIDES_URL` | the guides at kanbanto.com | Where **Guides** in the account menu goes: how to use Kanbanto, for the people using it. Put your own address here (a copy of the [`guides`](../guides) folder you serve, your team's handbook, or a page on this site like `/help`), or `off` to take the item out of the menu. |
| `DOMAIN` | — | Your domain, for the [HTTPS add-on](self-hosting.md#https). |
| `DB_PORT` | `5433` | The port the database is reachable on — only from this machine (`127.0.0.1`), for backups and development. |
| `LOG_FORMAT` | readable lines | `json`: one JSON object per line, for log collectors. |
| `COMPOSE_FILE` | — | Docker's own setting. `docker-compose.yml:deploy/docker-compose.https.yml` makes the HTTPS add-on permanent. |
| `COMPOSE_PROJECT_NAME` | `kanbanto` | Docker's own setting: the name the containers and data volumes are grouped under. Only change it to run a second copy on the same machine. |

### Server environment (running without Docker Compose)

The Kanbanto container (or `node dist/main.js`) reads these environment variables. Docker Compose fills them in from
the settings above.

| Variable | Default | What it's for |
|---|---|---|
| `DATABASE_URL` | `postgres://kankan:kankan@localhost:5433/kankan` | PostgreSQL 15+ connection string. |
| `APP_URL` | — | As above. **Required in production** (Kanbanto won't start without it): links in emails are never built from request headers, which anyone can fake. |
| `ENCRYPTION_KEY` | — | As above. |
| `KEY_FILE` | `./data/config/encryption.key` (Docker image: `/data/config/encryption.key`) | Where Kanbanto keeps the key it makes when `ENCRYPTION_KEY` isn't set. Must be persistent. |
| `TRUST_PROXY` | none | As above. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `UPLOADS_DIR` | `./data/uploads` (Docker image: `/data/uploads`) | Folder for attachments kept on the server's disk. Must be persistent (a volume). |
| `WEB_DIST` | — (Docker image: `/app/web`) | Folder with the built web app; when set, the server serves it. |
| `PAGES_DIR` | — (Docker image: `/app/pages`) | Folder with your site's own pages. See [Your own pages](#your-own-pages). |
| `NODE_ENV` | — (Docker image: `production`) | `production` for real use. |
| `SMTP_URL` / `SMTP_FROM` | — | As above. |
| `GUIDES_URL` | the guides at kanbanto.com | As above. |
| `LOG_FORMAT` | readable lines | As above. |
| `MAIL_TRANSPORT` | — | `log` prints emails to the terminal instead of sending them — for development only. |
| `FILES_FROM_URL` | on | `off` stops assistants having the server fetch a file from a web address (the `attach_file` tool's `url`). When on, only public `https` addresses are fetched, without following redirects, up to 25 MB or the largest file allowed if that's less. Files an assistant writes itself, and upload links, are not affected. |
| `ALLOW_PRIVATE_BUCKETS` | — | `true` lets people's own storage be on a private network address (development and tests only: it would let anyone make the server reach your network). |

### Your own pages

A site that's open to the public usually needs a few pages the app doesn't have: an about page, a privacy policy,
terms, an imprint. Put them in a folder named `pages` beside `docker-compose.yml` and rebuild
(`docker compose up -d --build`); without Docker, point `PAGES_DIR` at the folder.

| In the folder | Where it's served |
|---|---|
| `privacy.html` | `/privacy` (and `/privacy.html`) |
| `img/team.png` | `/img/team.png` |
| `links.json` | Not served: the links shown under the sign-in form |

`links.json` is a list of up to 8 links, to your pages or anywhere else:

```json
[
  { "label": "About", "url": "/welcome" },
  { "label": "Privacy", "url": "/privacy" },
  { "label": "Terms", "url": "/terms" }
]
```

- Pages are plain files: HTML, CSS, scripts, pictures, PDFs. Other kinds of files and hidden files aren't served.
- The main address (`/`) stays the app's, so a page can't be named `index.html`; neither can it sit under `/api`,
  `/oauth` or `/assets`.
- Pages are found when Kanbanto starts: restart after adding one (with Docker: rebuild, as above).
- They are part of the same site as the app, so only put pages there that you wrote or trust.

### `SMTP_URL`

| Example | Means |
|---|---|
| `smtp://user:password@smtp.example.com:587` | STARTTLS (the default for `smtp://`), signing in |
| `smtps://user:password@smtp.example.com:465` | TLS from the start |
| `smtp://relay.example.internal:25?security=none` | No encryption and no sign-in: a relay inside your network |
| `…?allow_self_signed=true` | Accept a certificate the server signed itself |

Without a port, it's 587 for STARTTLS, 465 for TLS and 25 for `security=none`. Write `@`, `:`, `/` and `#` in the
username or password as `%40`, `%3A`, `%2F` and `%23`. While `SMTP_URL` is set, the Platform console shows it but
can't change it, and people's own Resend keys still work. If it's malformed, Kanbanto stops at startup and says why.

## 2. The Platform console

Open it from the menu under your initials (platform admins only). Each section has its own address.

| Section | Setting | Default |
|---|---|---|
| **Overview** `#/admin` | Totals (accounts, boards, tasks) and a status card for sign-up, email and storage | — |
| **Accounts** `#/admin/accounts` | **Anyone can create an account** — off: people join only through a share link, access code or email invite | On |
| | Per account: **password reset link** (one-time, 24 hours, for you to pass on; the person is told by email), **confirm email** (you vouch for their address), **turn account off / on** (off: signed out everywhere, and its API tokens, connected apps, calendar link and the invite links of its boards and workspaces are removed) | — |
| **Email** `#/admin/email` | **Sending:** an **SMTP server** (server, port, encryption, username, password) or a **Resend** API key, and the sender address. Secrets are write-only and encrypted. See [Email](email.md). | Not set up |
| | **Limits:** emails per day and per month the site sends; invite emails per person per month (people with their own key aren't limited). Empty: no limit. | 90 / 2,800 / 20; none with SMTP |
| | **How emails look:** product name, button colour, footer | Kanbanto, blue, empty |
| | **Preview:** every email, and "Send it to me" | — |
| **Storage** `#/admin/storage` | **Where files are kept:** this server's disk, or an S3-compatible bucket (write-only secret, encrypted) | Server's disk |
| | **Limits:** space per person (in total, across the boards they own), and the same for each workspace (across its boards); largest file (1–200 MB) | 50 MB / 10 MB |
| **Integrations** `#/admin/integrations` | **People can make API tokens** (for scripts, other apps and AI assistants; turning it off stops every token) | Off |
| | **Webhooks:** off, to public `https://` addresses only, or to any address including this server's network (only if you trust every board owner). They also cover webhooks to a chat channel (Slack, Google Chat, Microsoft Teams, Discord); with "public addresses only", those have to point at the chat app's own addresses. | Off |
| | **Apps that connect by signing in** (OAuth, for MCP: Claude on the web and Desktop, ChatGPT): off, known AI apps only, or any app. The site must be reachable from the internet over https. | Off |
| | **People can make calendar links** (a private address calendar apps subscribe to; turning it off stops every link). See [Calendar](calendar.md). | Off |
| | **Google Calendar:** the client ID and secret of a Google app you make once, so people can connect their Google Calendar. The secret is write-only and encrypted. See [Calendar](calendar.md). | Not set up |

Things each person sets for themselves in **Account settings** (`#/account`): name, password, their
notifications (the morning summary email, reminder emails, desktop notifications, their time zone), their calendar (Google Calendar, a calendar link, and which boards are in it), their own Resend
key for invites, their own storage bucket (at a public `https://` address), and their API tokens. Board owners add
webhooks in Board settings. See [API, webhooks and AI](api.md).

## 3. Server commands

Run in the Kanbanto folder as `docker compose exec app node dist/cli.js <command>` (without Docker:
`pnpm --filter @kanbanto/server cli <command>`).

| Command | What it does |
|---|---|
| `admin grant <email>` | Makes an existing account a platform admin (sign up on the website first). |
| `admin revoke <email>` | Removes platform admin rights. |
| `admin list` | Lists platform admins. |
| `user password <email>` | Sets a temporary password for an account, signs it out everywhere, and prints the password. |
| `key` | Prints the encryption key in use, so you can keep a copy. |
| `secret` | Prints a new random key, for setting `ENCRYPTION_KEY` yourself. |

## Limits and defaults worth knowing

| | |
|---|---|
| Sessions | Last 30 days, extended while in use. Changing your password signs out your other devices (live connections included). |
| Signing up | Once the site sends email, new accounts confirm their address before signing in: the link in the email asks for their password, then confirms the address and signs them in. |
| Wrong passwords | 10 sign-in attempts a minute from one address, and 10 wrong passwords for one account in 15 minutes (then it waits). |
| Invites | 30 invitations an hour per person; 10 invite emails an hour; brand-new accounts send 5 invite emails on their first day. Joining with a code: 20 tries a minute. |
| Email links | Confirm email: 24 hours. Reset password: 1 hour, once. A reset link from an admin: 24 hours, once. Invites by email: until used or cancelled. Share links and access codes: until turned off or replaced. |
| Morning summary | At most one per person per day, around 8:00 in their time zone (UTC if they haven't set one), only when there's something in it: cards due today or overdue, reminders later today, mentions and news from the cards they follow that they haven't seen. |
| Custom fields | 50 fields in a library (a workspace's, or a person's own), plus up to 100 archived; 20 on a board, 3 of them on the card front; 50 options in a choice field; text values up to 500 characters (links 2,000). |
| Integrations | 20 API tokens per person; 10 webhooks per board; apps registering for sign-in: 20 an hour per address; a calendar link: 120 requests a minute. |
| Sent emails | Kept for 60 days (for the limits), without their contents: those are removed once sent. |
| Files | Deleted files stay in a trash for 30 days (restorable, if there's room in the owner's space). Files waiting in unposted comments: 10 per person, up to 3 times the largest file size, removed after a day. |
| Request size | 1 MB, except board imports (20 MB), changes to a board (10 MB) and file uploads (the largest file size). |
