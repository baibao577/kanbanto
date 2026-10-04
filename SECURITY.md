# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:
**[Report a vulnerability](https://github.com/baibao577/kanbanto/security/advisories/new)**
(the repository's *Security* tab → *Report a vulnerability*).

Include what you found, how to reproduce it, and what someone could do with it. You'll get a reply as soon as
possible, and credit in the fix's release notes if you'd like.

Fixes go into the latest version. If you run Kanbanto yourself, keep it up to date — see
[Upgrades](docs/self-hosting.md#upgrades).

## How Kanbanto protects your data

**Accounts and sign-in**

- **Passwords** are hashed with scrypt; they are never stored or logged.
- **Sessions** are random tokens in an httpOnly, SameSite=Lax cookie, marked Secure over HTTPS. Only their SHA-256
  hash is stored, so a copy of the database can't be used to sign in. Changing a password signs out other devices and
  closes their live connections.
- **Guessing is limited:** sign-in, sign-up and joining are rate-limited per IP address, and each account allows 10
  wrong passwords in 15 minutes. Forwarded client addresses are believed only from the proxies named in `TRUST_PROXY`.
- **Email links** (confirm email, reset password) are single-use, expire, and only their hash is stored. Links in emails
  are built from the configured `APP_URL`, never from request headers.
- **Signing up doesn't reveal who has an account** once the site sends email: the answer is the same either way, and
  the address's owner is told by email. (Without email, sign-up says when an address is taken.)
- **An address counts as confirmed** only when proved by email: a confirmation link, a password reset link, or an
  invite emailed to it (not one whose link the inviter was shown). Email invites go straight to an account only if its
  address is confirmed.

**Boards**

- **Every change to a board** is checked on the server against the person's role, with the same rules as the app, and
  records put back by undo must be ones a command could have made.
- **Cross-site requests** are refused: changes must come from a page on the same site.
- **Who's on a board** is visible to its people only; only owners see their email addresses.
- **Workspaces** only add people to boards shared with the workspace. Their admins manage who's in it, but can't
  open its other boards (private ones stay private) until someone leaves and they take over that person's boards.
  Taking a board out of a workspace needs the workspace's admin, so nobody walks off with a team's board.

**Keys and secrets**

- **Email keys, mail server passwords, storage keys, the Google app's secret and people's calendar connections**
  saved in the website are encrypted (AES-256-GCM) with a key
  that's never in the database: `ENCRYPTION_KEY`, or one Kanbanto makes on first start and keeps in its own volume.
  The browser only ever sees a short hint of a key, and never a password. Kanbanto won't start in production with the
  public development key.
- **Only platform admins can point the server at other systems.** People's own email settings are Resend keys only,
  and their own storage must be at a public internet address: every connection is checked after the name is looked
  up, and redirects aren't followed, so nobody can make the server reach its private network. The site's own mail
  server and bucket, set by platform admins, may be anywhere (a company relay, a MinIO on your network) — so keep
  platform admin rights to the people who run the server.
- **Sent emails** are kept (for the sending limits) without their contents, and failed database queries are logged
  without the data they carried.

**Files**

- **Uploaded files** are always served as downloads (pictures inline), never as web pages, and common program and
  script types are refused. Files in a bucket are reached through 5-minute signed links.
- Uploads are checked (who, and the declared size) before the file is read. Files for a comment not yet posted are
  visible only to their uploader.

**API tokens, webhooks and AI assistants**

- **API tokens** are off until a platform admin turns them on. Only their SHA-256 is stored; each acts as its person,
  with their access, and can't reach account settings, other tokens or the Platform console. Read-only tokens can't
  change anything. Deleting a token, or turning tokens off, stops it at once.
- **Webhooks** are off until a platform admin allows them. By default they may only go to public `https://` addresses,
  checked after every name lookup, with redirects not followed, so board owners can't make the server reach its
  private network. Admins can allow any address for internal tools; only do so if you trust every board owner.
  Deliveries are signed with a per-webhook secret, stored encrypted.
- **Apps that connect by signing in** (OAuth, for MCP) are off until a platform admin allows them, by default only
  known AI apps. Each person approves each app on a page that shows where it sends them back to; codes are one-time,
  PKCE is required, access tokens last an hour and refresh tokens are replaced on every use (only hashes are stored).
  These tokens only reach the MCP endpoint, and disconnecting (or turning the setting off) stops them at once.
- **Calendar links** are off until a platform admin turns them on. A link is a long random address that works
  without signing in and shows only its person's cards' titles and dates (and a link back to each card): whoever has
  it can read those. Only its SHA-256 is looked up (an encrypted copy lets its person see it again), it's left out
  of the server's logs, making a new one stops the old one, and it stops with its account or the setting.
- **Google Calendar** needs a Google app set by a platform admin (its secret stored encrypted). Kanbanto asks each
  person only for calendars it makes itself, so it can't read or change their other calendars; their Google refresh
  token is stored encrypted. The titles and dates of their cards are sent to Google. Disconnecting removes the
  calendar and gives the access back.
- **AI assistants (MCP)** use API tokens or those sign-in tokens, with the same checks. There's no delete tool. Task text is written by people
  and can try to steer an assistant, so the docs recommend read-only tokens unless changes are needed.

**Platform admins**

- Admin rights are granted only on the server (`admin grant`), never through the website.
- Admins get **no access to boards** that aren't shared with them. They can make a password reset link for an account
  (to help someone locked out) — which would let them sign in as that person — so the person is told by email when
  a link is made, and using it signs them out everywhere.

For running Kanbanto safely on a server, follow the [security checklist](docs/self-hosting.md#security-checklist).
