# Troubleshooting

Find your problem below. Most answers start with **the logs** — Kanbanto usually says exactly what's wrong there.

```bash
docker compose logs --tail 100 app      # the last 100 lines
docker compose logs -f app              # follow live (Ctrl+C to stop)
docker compose ps                       # is everything running?
```

**Contents**
[Starting up](#starting-up) ·
[Opening Kanbanto](#opening-kanbanto) ·
[Signing in](#signing-in) ·
[Live updates](#live-updates) ·
[Email](#email) ·
[Files and storage](#files-and-storage) ·
[Database](#database) ·
[Still stuck?](#still-stuck)

## Starting up

### `docker: command not found`, or "Cannot connect to the Docker daemon"
Docker isn't installed or isn't running. Open **Docker Desktop** and wait until it says it's running, then try again.
On Linux: `sudo systemctl start docker`.

### Making or editing the `.env` file
Settings go in a file called exactly `.env` in the Kanbanto folder (you can copy `.env.example`). Its name starts with
a dot, so it's hidden by default: on a Mac press Cmd+Shift+. in Finder to see it; on Windows turn on View → Show →
Hidden items. Windows Notepad adds `.txt` when saving: choose **Save as type: All files** and type `.env`. After
changing it, run `docker compose up -d --wait`.

### "port is already allocated" / "address already in use"
Something else uses port 3000 (or 5433). Pick other ports in `.env`, e.g. `PORT=3001` and `DB_PORT=5434`, then
`docker compose up -d --wait` and open `http://localhost:3001`.

### The build fails or stops partway
- **Out of memory** (the log mentions "killed" or exit code 137): building needs about 2 GB of RAM. Add swap, or
  give Docker Desktop more memory (Settings → Resources).
- **Network errors** while downloading packages: run the command again.
- **"no space left on device"**: free up space with `docker system prune` (removes unused images; your data volumes
  are kept).

### The app keeps restarting
Run `docker compose logs --tail 50 app`. A line starting **"Kanbanto can't start"** says what to fix:
- **"APP_URL isn't set"**: set `APP_URL` in `.env` to the address people use (outside Docker Compose it has no default).
- **"ENCRYPTION_KEY is the public development key"**: remove `ENCRYPTION_KEY` from `.env` (Kanbanto then makes its own)
  or set a key of your own (`openssl rand -base64 32`).
- **"ENCRYPTION_KEY isn't valid"**: it must be 32 random bytes in base64, as `node dist/cli.js secret` makes.
- **"Couldn't save a new encryption key"**: Kanbanto can't write its key file. With Docker Compose this shouldn't happen
  (the `config` volume holds it); elsewhere, point `KEY_FILE` at a folder it can write to, or set `ENCRYPTION_KEY`.
- **"couldn't reach or update the database"** (`ECONNREFUSED`, `password authentication failed`): see [Database](#database).
- **An `SMTP_URL` problem**: see [Email](email.md#option-a-an-smtp-server).

Other causes:
- **A database update failed** (errors mentioning a migration or "relation … already exists"): don't delete anything;
  [open an issue](https://github.com/baibao577/kanbanto/issues) with the log lines.

## Opening Kanbanto

### The page doesn't load at `http://localhost:3000`
- Check it's running: `docker compose ps` should show `app` as running (healthy).
- Check the health address: `curl http://localhost:3000/api/health` should answer `{"ok":true}`.
- Using another `PORT`? Open that port instead.

### It works on the server but not from other computers
- With `BIND_ADDRESS=127.0.0.1` in `.env`, or the HTTPS add-on, Kanbanto listens only on the server itself — use
  `https://your-domain`, not `:3000`.
- A firewall in front of the server (your cloud provider's, or your office's) may block the port. With the HTTPS
  add-on, only 80 and 443 need to be open.

### "Kanbanto can't reach its server"
The page loaded but the API didn't answer — usually the app container is still starting or restarting. Wait a
moment and reload; otherwise check the logs.

### "Something went wrong" or a blank page
Reload the page (Ctrl+Shift+R / Cmd+Shift+R): after an update, a page that was open still has the old version. If it
keeps happening, open **Details** on the message (or the browser's developer console, F12) and include the error in an
[issue](https://github.com/baibao577/kanbanto/issues).

## Signing in

### I signed in but I'm immediately signed out (or sign-in "does nothing")
The browser isn't keeping the sign-in cookie. Usually a proxy/HTTPS mismatch:
- Behind your own HTTPS proxy, set `TRUST_PROXY=1` in `.env`, and make the proxy send `X-Forwarded-Proto: https` (the
  HTTPS add-on does both).
- Don't mix addresses: use exactly the address in `APP_URL`.

### "Too many wrong passwords for this email. Wait 15 minutes"
After 10 wrong passwords in 15 minutes, an account waits before it can sign in again (it protects against password
guessing). Wait, or reset the password. Behind your own proxy, if **everyone** keeps hitting sign-in limits, Kanbanto
sees all visitors as the proxy: set `TRUST_PROXY=1` in `.env`.

### I created an account but can't sign in
Once the site sends email, a new account confirms its address first: click the link in the "Confirm your email
address" email (it asks for your password, the one you chose when signing up, then signs you in; didn't sign up
yourself? Use **Forgot password** to make the account yours). No email? Check spam, then use **Send the link again** on the "Check your inbox"
page. An admin can also confirm it: Platform console → Accounts → ⋯ → Confirm email.

### "Requests must come from this site"
Kanbanto blocks changes whose page address doesn't match the server's. Behind a reverse proxy, pass the original
**Host** header (`proxy_set_header Host $host;` in nginx), or use the address in `APP_URL`. See
[HTTPS Option B](self-hosting.md#option-b-your-own-reverse-proxy-nginx-traefik-a-load-balancer).

### "Sign-up is closed"
Open sign-up was turned off (Platform console → Accounts). New people need a share link, access code or email invite
from a board owner.

### "Confirm your email address first"
Once email is set up, accounts must click the link in their confirmation email — including accounts created before
email was set up. They can ask for another from the "Check your inbox" screen. Platform admins don't need to.

If the address can't receive email (for example a made-up address on a family install), a platform admin can confirm
it for them: **Platform console → Accounts → ⋯ → Confirm email**.

### I forgot my password
- Signed up with Google? You have no password: use **Continue with Google**. (The steps below give you one too.)
- Email is set up: use **Forgot password?** on the sign-in page.
- Otherwise, a platform admin can give you a reset link (Platform console → Accounts → ⋯ → Password reset link).
  It works once, for 24 hours. (When the site sends email, you're also told by email that a link was made.)
- **You are the only admin?** On the server:
  `docker compose exec app node dist/cli.js user password you@example.com` prints a temporary password.

### Signing in with Google sends me back to the sign-in page
The page says why. The ones that need doing something:
- **"That email address already has an account here, and Google can't vouch that it's yours":** the address isn't a
  Gmail or Google Workspace one, or the account is tied to another Google account. Sign in with your password (or
  **Forgot password?**).
- **"No account uses that Google address, and sign-up is closed":** you need an invite, or you have an account under
  another address.
- **"Google hasn't confirmed that email address yet":** confirm the address in your Google account first.
- **"Google doesn't accept this site's Google app":** for whoever runs the site: the client ID or secret no longer
  works (Platform console → Integrations).
- **Google's own page says `redirect_uri_mismatch`:** for whoever runs the site: the Google app is missing the
  second redirect address the console shows (see
  [Signing in with Google](self-hosting.md#signing-in-with-google)).

### My password stopped working after I signed in with Google
Your account had never confirmed its email address, so the Google sign-in confirmed it and removed the old password
(someone else could have set it). Sign in with Google and add a password in **Account settings → Password**.

### I don't see "Platform console"
Only platform admins see it. Run `docker compose exec app node dist/cli.js admin grant you@example.com`, then reload
the page.

## Live updates

### Changes from others only appear after reloading, or the top bar says "Offline"
The live connection (a WebSocket) is being blocked, usually by a reverse proxy. It must pass WebSocket upgrades for
`/api/boards/…/live` — for nginx, the `Upgrade` and `Connection "upgrade"` headers in
[the example](self-hosting.md#option-b-your-own-reverse-proxy-nginx-traefik-a-load-balancer), and a long
`proxy_read_timeout`. Your changes are kept in the tab and sent when the connection returns.

## Email

Setting it up: see [Email](email.md).

### "Keys can't be saved until the server has an encryption key"
Kanbanto makes its key when it starts: restart it (`docker compose up -d --wait`) and check the logs for a line
starting "Kanbanto can't start" (see [The app keeps restarting](#the-app-keeps-restarting)).

### SMTP: "Couldn't connect to smtp.example.com:587"
- Check the server name and port with your mail provider or IT team.
- **Your hosting provider may block outgoing mail ports** (25, 465, 587), especially on new servers. Ask them to
  unblock the port, or use Resend, which sends over HTTPS.
- A company relay may only accept connections from inside your network or from allowed IP addresses: ask IT to allow
  your Kanbanto server's address.

### SMTP: "The mail server refused the username or password"
- Many services need an **app password** or special SMTP credentials rather than your normal password (Gmail and
  Google Workspace, Amazon SES, Brevo, Postmark — see the [settings table](email.md#option-a-an-smtp-server)).
- **Microsoft 365** may have SMTP sign-in turned off for your organisation. Use a connector instead (no password,
  allowed by IP address), or ask your admin to allow SMTP sign-in for that mailbox.

### SMTP: "Couldn't start an encrypted connection" or "doesn't offer STARTTLS"
The encryption setting doesn't match the port. Usually: **587 → STARTTLS**, **465 → TLS**, **25 → STARTTLS or None**.

### SMTP: "The mail server's certificate isn't trusted"
The server uses a certificate from your company's own authority, or a self-signed one. If it's your organisation's
server, turn on **Allow a self-signed certificate**. For a public service, check the server name is exactly right —
a certificate for another name is refused too.

### SMTP: "The mail server refused the email: 550 …" (or 553, 554)
The server doesn't let this account send from that address, or doesn't relay for your server. Send from an address the
account owns, or ask IT to allow relaying from your Kanbanto server's IP address.

### Kanbanto doesn't start after setting `SMTP_URL`
The logs say what's wrong (`docker compose logs --tail 20 app`). Common causes: `SMTP_FROM` isn't set, the address
doesn't start with `smtp://` or `smtps://`, or the password has a character like `@` that must be written as `%40`.
See [SMTP_URL](configuration.md#smtp_url).

### "New accounts can send 5 invite emails on their first day"
A brand-new account's invite emails are limited for a day (it stops throwaway accounts from sending spam). The invite
link is shown instead: send it yourself, or wait a day.

### "Resend refused the test email: … domain is not verified"
The sender's domain must be verified in Resend (Domains). Check the DNS records it asks for, wait until it shows
*Verified*, and try again.

### "You can only send testing emails to your own email address"
You're using Resend's shared `onboarding@resend.dev` sender. It only reaches your own Resend account's address.
Verify your own domain and send from it.

### Emails go to spam
- Check the email's headers in Gmail (⋮ → **Show original**): **SPF, DKIM and DMARC** should all say *PASS*.
- Add a DMARC record (see [Email](email.md#after-setting-up-email)) and a real footer (Platform console → Email → How emails look).
- Set `APP_URL` to your real `https://` address — links to `localhost` or plain IP addresses look suspicious.
- New domains need a few weeks of normal sending to build trust. Mark messages as *Not spam* while testing.

### Emails stopped arriving
- **Platform console → Email** shows whether sending works, with the reason if not (a revoked key, a changed
  password, domain problems).
- The **daily or monthly limit** may be used up (the usage bars show it). Invites stop first; the app then offers a
  link to share by hand. Raise the limits if your Resend plan allows.

### I lost the encryption key
It's lost if the `config` volume was deleted (for example `docker compose down -v`) and no copy was kept. Nothing on the
boards is lost: restart, then re-enter the email key or mail server password (Platform console → Email) and the
storage keys (Platform console → Storage; people who used their own keys re-enter them in Account settings).

## Files and storage

### "Files can be up to N MB" / uploads over a few MB fail
- The limit is in Platform console → Storage → Limits.
- Behind your own proxy, allow bigger requests (nginx: `client_max_body_size 50m;`). The HTTPS add-on allows 200 MB.

### "…out of file space"
Files count against the board owner's space (default 50 MB in total across their boards). Delete files, raise the
limit (Platform console → Storage), or connect a bucket (Account settings → File storage).

### "That address can't be used … must be on the public internet"
People's own storage has to be at a public `https://` address: Kanbanto won't connect to private network addresses
(`localhost`, `10.x`, `192.168.x`, cloud-internal addresses) on anyone's behalf. For storage on your own network (a
MinIO), a platform admin can set it as the site's storage in Platform console → Storage instead.

### "The region isn't right: this storage is set to …"
The bucket's storage expects another region than the one in **Region**. Put the one it names there. For a MinIO
without a region set, leave Region empty.

### Files in a bucket upload, but don't open (or pictures don't show)
A file opens in the browser through a short-lived link straight to the storage, at the **endpoint** you saved. So that
address has to work from people's browsers: not a name that only exists on the server or inside Docker
(`http://minio:9000`), and on `https://` if Kanbanto is. To put it right: save the bucket again with the address a
browser can reach (Platform console → Storage), then press **Move here** beside the earlier setting in "files kept
elsewhere". Kanbanto sees that both are the same bucket: nothing is copied or removed, the files are just looked for
at the new address from then on.

### "You have files waiting in comments you haven't posted"
Files attached to a comment wait until the comment is posted (at most 10, and 3 times the largest file size). Post or
cancel those comments, or remove their files. Unposted files are removed after a day.

### "Uploads need their size (a Content-Length header)"
Something between the browser and Kanbanto (a proxy) is sending uploads in chunks without their size. Configure the
proxy to pass the request as it is (nginx does by default).

### "The storage test failed"
Kanbanto writes and deletes a small file to check the bucket. The message says which part is wrong:
- *Couldn't reach the storage* — check the endpoint address (no bucket name at the end).
- *That bucket doesn't exist* — check the bucket name (and the region for Amazon S3).
- *The access key or secret isn't right, or it can't write to this bucket* — the key needs read **and write**
  permission on that bucket.

### Pictures show as broken images
The file may be damaged, or its storage was removed. If you use a bucket, check its key still works (Platform console
→ Storage shows the last problem).

Files in a **bucket used earlier** still open with the key saved for it back then. If that key was changed or revoked,
give Kanbanto the new one with **Update keys** (Platform console → Storage, or Account settings → File storage for
someone's own bucket), or bring the bucket's files over with **Move here**. A deleted bucket's files are gone.

### "There's no room to bring it back"

Restoring a file from the trash takes its space again. Delete some files (or raise the quota in Platform console →
Storage) and restore it again.

## Webhooks

### "That address didn't answer" / "didn't confirm it wants these"

Before a webhook is saved, Kanbanto sends its address a one-time code, and the address has to answer with it. See
[API → Webhooks](api.md#webhooks) for the three lines a receiver needs. (Sites that allow webhooks to any address
don't ask.)

## Pages and frames

### Kanbanto doesn't show inside a frame on another site, or a script added by a proxy doesn't run

That's on purpose: Kanbanto tells browsers not to show it in other sites' frames, and its page loads scripts only
from Kanbanto itself. A proxy or CDN that adds its own script to the page (analytics, "rocket loaders") will find it
blocked: turn that feature off for Kanbanto's address.

## Database

### I changed `POSTGRES_PASSWORD` and now Kanbanto can't connect
The password is fixed when the database is first created; changing `.env` later doesn't change it. Either put the old
password back, or change it inside the database to match:

```bash
docker compose exec db psql -U kankan -d kankan -c "ALTER USER kankan PASSWORD 'the-new-password';"
docker compose up -d
```

### Where is my data?
In Docker volumes: `kanbanto_pgdata` (the database), `kanbanto_uploads` (files) and `kanbanto_config` (the encryption
key). `docker volume ls` lists them. They survive restarts, updates and `docker compose down`. **Only
`docker compose down -v` deletes them** — don't use `-v` unless you mean it.

### Starting over from scratch
This **deletes all boards, accounts and files**:

```bash
docker compose down -v
docker compose up -d --build
```

## Still stuck?

[Open an issue](https://github.com/baibao577/kanbanto/issues) with:
- what you did and what happened (screenshots help);
- your setup (your computer or a server; the HTTPS add-on or your own proxy);
- the output of `docker compose logs --tail 100 app` — **remove any keys, passwords or email addresses first**
  (share-link tokens are already hidden in the logs).

Security problems: please report them privately instead — see [SECURITY.md](../SECURITY.md).
