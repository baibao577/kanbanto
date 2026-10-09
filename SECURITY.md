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
  the address's owner is told by email, and an invite the address can't use is refused before that is looked at.
  (Without email, sign-up says when an address is taken.)
- **An address counts as confirmed** only when proved by email: a confirmation link, a password reset link, or an
  invite emailed to it (not one whose link the inviter was shown, or that went out through the inviter's own email
  service). Or by its owner signing in with Google, when the site offers that. Email invites go straight to an
  account only if its address is confirmed.
- **Signing in with Google** (off until a platform admin turns it on) asks Google only who the person is, and keeps
  only Google's ID for them. It reaches an existing account by address only when Google has checked the address and
  runs its mailbox (Gmail or Google Workspace). If that account never confirmed its address, its password, its
  sessions and whatever else acts as it (API tokens, connected apps, its calendar link) are removed in the same
  step that joins it, so whoever made it can't stay in, and can't slip a new password in as it changes hands. A
  reset link that confirms such an address does the same. Closed sign-up applies to it too.
- **A confirmation link works with the account's password**, or in the browser already signed in to it: reading the
  inbox isn't enough, so nobody can make an account for your address and have you confirm it for them. If someone
  did, "Forgot password" makes the account yours: your password, everyone else signed out.

**Boards**

- **Every change to a board** is checked on the server against the person's role, with the same rules as the app, and
  records put back by undo must be ones a command could have made. Imported files pass the same checks, whatever
  their format.
- **Cross-site requests** are refused: changes must come from a page on the same site.
- **Browsers are told what the app may do**: it loads scripts only from its own site, can't be put in a frame by
  another site, and over HTTPS browsers are told to keep using HTTPS.
- **What people write can't act on whoever reads it.** Descriptions and comments are shown as text and the few
  things Markdown stands for, never as HTML; links go only to web and mail addresses; and a picture in a text is
  one of the card's own files, never one from another site, which would tell that site who is reading. A
  **diagram** (a code block that says `mermaid`) is drawn in a page of its own that the browser lets load nothing
  but Kanbanto's scripts, and is shown as a picture: whatever its text names (a picture, a style, a label made of
  HTML), nothing is asked of any other site and nothing runs. Code is coloured from the words themselves.
- **Earlier versions of a description** (the newest 100 for each card) are for the board's people, not for
  visitors with its public link. Text taken out of a description can still be read there by them.
- **Who's on a board** (names, never email addresses) is visible to its people, and to visitors when an owner turns
  on "Anyone with the link can view": that's the owner's choice. Only owners see email addresses. Visitors with the
  link never see logged time.
- **Losing access takes effect everywhere**: live connections close, and notifications show nothing from a board you
  can no longer open.
- **Workspaces** only add people to boards shared with the workspace. Their admins manage who's in it, but can't
  open its other boards (private ones stay private) until someone leaves and they take over that person's boards.
  Taking a board out of a workspace needs the workspace's admin, so nobody walks off with a team's board.

**Keys and secrets**

- **Email keys, mail server passwords, storage keys, the Google app's secret, people's calendar connections and
  boards' Telegram bot keys** saved in the website are encrypted (AES-256-GCM) with a key
  that's never in the database: `ENCRYPTION_KEY`, or one Kanbanto makes on first start and keeps in its own volume.
  The browser only ever sees a short hint of a key, and never a password. Kanbanto won't start in production with the
  public development key.
- **Only platform admins can point the server at other systems.** People's own email settings are Resend keys only,
  and their own storage must be at a public internet address: every connection is checked after the name is looked
  up, and redirects aren't followed, so nobody can make the server reach its private network. The same goes for the
  address a browser gives for desktop notifications. The site's own mail
  server and bucket, set by platform admins, may be anywhere (a company relay, a MinIO on your network) — so keep
  platform admin rights to the people who run the server.
- **Sent emails** are kept (for the sending limits) without their contents, and failed database queries are logged
  without the data they carried.

**Files**

- **Uploaded files** are always served as downloads (pictures inline), never as web pages, and common program and
  script types are refused. Files in a bucket are reached through 5-minute signed links.
- **Imports are read once over, whatever is in them.** A spreadsheet, a Trello board or a board's own file is
  limited in size, in rows, columns, lists and comments, and is checked like any other change; nothing in it is
  fetched by the server (a Trello card's attachments become links). The same goes for what people write: a
  description made to be slow to read costs no more than another of its length.
- Uploads are checked (who, and the declared size) before the file is read. Files for a comment not yet posted are
  visible only to their uploader.
- **Profile pictures** are small (256 KB at most) and only PNG, JPEG or WebP, decided by the file's first bytes and
  not by what the request calls it. They are served as pictures, never as web pages. A picture's link is long and
  random, changes whenever the picture does, and works without signing in: people looking at a board through its
  public link see who its cards are assigned to. Anyone given that link can load that one picture, and nothing else.
  One that says it is more than 1,024 pixels a side is refused, since everyone's browser draws it.
- **A card's cover** is drawn from a small copy of the picture, made by the browser of whoever set it and checked
  the same way (PNG, JPEG or WebP by its first bytes, 300 KB and 1,280 by 2,560 pixels at most). The server never
  opens a picture. The small copy is read by whoever can read the file itself.

**API tokens, webhooks and AI assistants**

- **API tokens** are off until a platform admin turns them on. Only their SHA-256 is stored; each acts as its person,
  with their access, and can't reach account settings, other tokens or the Platform console. Read-only tokens can't
  change anything. Deleting a token, or turning tokens off, stops it at once. Tokens can't open a board's live
  connection.
- **A webhook's address has to agree**: before one is saved it's sent a one-time code and must answer with it, so a
  webhook can't be pointed at somebody else's server. A chat channel (Slack, Google Chat, Microsoft Teams,
  Discord) can't answer, so it is sent a first message instead and the webhook is saved only if the chat app takes
  it; on a site limited to public addresses, the address must be that chat app's own.
- **Webhooks** are off until a platform admin allows them. By default they may only go to public `https://` addresses,
  checked after every name lookup, with redirects not followed, so board owners can't make the server reach its
  private network. Admins can allow any address for internal tools; only do so if you trust every board owner.
  Deliveries to another app are signed with a per-webhook secret, stored encrypted; a chat channel's are not
  signed (nobody at that end checks). A chat channel's address is itself the key to posting there: it is kept as
  it was given, and a board's owners can read it back, so treat a copy of the database, and an owner's API token,
  as holding it.
- **A board's Telegram bot** is off until a platform admin allows bots. A board's owner gives it a bot of their
  own (its key is stored encrypted and never shown again), and connects one chat with a one-time code: only that
  chat is listened to, and anyone else who finds the bot gets no answer. The server asks Telegram for the bot's
  messages; nothing reaches the server from Telegram. The board's news (card titles, who did what, the start of
  comments) is sent to that chat and stays in its history, and what is written there becomes cards and comments
  as the person who connected it (in a group, as whoever wrote it, when the bot knows them). A chat adds at most
  20 cards a minute and 200 a day.
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
- Turning an account off keeps the person out: they're signed out everywhere; their API tokens, connected apps,
  calendar link and desktop notifications are removed; and so are the share links, access codes and waiting invites
  of the boards they own and the workspaces they run, so they can't come back in under another address.
- Admins get **no access to boards** that aren't shared with them. They can make a password reset link for an account
  (to help someone locked out) — which would let them sign in as that person — so the person is told by email when
  a link is made, and using it signs them out everywhere.

For running Kanbanto safely on a server, follow the [security checklist](docs/self-hosting.md#security-checklist).
