# Email

Setting up email for Kanbanto: through your organisation's mail server or any email service (SMTP), or with
[Resend](https://resend.com). This is part of [Self-hosting](self-hosting.md); every setting is also listed in
[Configuration](configuration.md).

Optional, but it enables: confirming new accounts' email addresses, **forgot password**, **invites by email**, and a
**daily summary of @mentions**. Without it, people share boards with links and codes, and an admin hands out
password reset links.

Kanbanto sends email in one of two ways (**Platform console → Email → Sending**):

| | Use it when |
|---|---|
| **SMTP server** | Your organisation already has email (Microsoft 365, Google Workspace, a company mail relay), or you use an email service such as Amazon SES, Postmark, Mailgun or Brevo. |
| **Resend** | You don't have any of those. Free for about 100 emails a day, 3,000 a month; you need a domain name. |

Whichever you choose, **Save and send a test** emails you first, and nothing is saved unless that works — the reason
is shown instead.

## Option A: an SMTP server

In **Platform console → Email**, choose **SMTP server** and fill in the server, port, encryption, username, password
and the address to send from. Common settings:

| Service | Server | Port · encryption | Sign-in |
|---|---|---|---|
| Company mail relay | ask your IT team | 25 · None, or 587 · STARTTLS | usually none: IT allows your Kanbanto server's IP address |
| Microsoft 365 (connector) | `<your-domain-with-dashes>.mail.protection.outlook.com` | 25 · STARTTLS | none: add a connector for your server's IP in the Exchange admin center |
| Microsoft 365 (mailbox) | `smtp.office365.com` | 587 · STARTTLS | the mailbox's address and password, if your organisation still allows SMTP sign-in (Microsoft is phasing it out; the connector is the lasting option) |
| Google Workspace (relay) | `smtp-relay.gmail.com` | 587 · STARTTLS | none: allow your server's IP in Admin console → Gmail → Routing → SMTP relay service |
| Google Workspace / Gmail (account) | `smtp.gmail.com` | 587 · STARTTLS | the address and an [app password](https://support.google.com/accounts/answer/185833) |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 · STARTTLS | SMTP credentials from the SES console (not your AWS access keys) |
| Postmark | `smtp.postmarkapp.com` | 587 · STARTTLS | your server API token, as both username and password |
| Mailgun | `smtp.mailgun.org` (EU: `smtp.eu.mailgun.org`) | 587 · STARTTLS | SMTP credentials from your Mailgun domain |
| Brevo | `smtp-relay.brevo.com` | 587 · STARTTLS | your SMTP login and SMTP key |

- **The sender address** must be one the server lets you send from (for services: an address on a domain you've
  verified with them).
- **"Allow a self-signed certificate"** is only for a company mail server whose certificate isn't from a public
  authority. Leave it off otherwise.
- **Some hosting providers block outgoing mail ports** (25, 465, 587) on new servers. If the test says it couldn't
  connect, ask your provider to unblock them, or use Resend, which sends over HTTPS.
- **Limits** (per day, per month, invites per person) are turned off when you switch to SMTP — they exist to keep
  within Resend's free plan. Set them again if your mail server has a sending limit.

**Or set it in `.env`** (useful if you manage servers as configuration, or keep secrets out of the database):

```bash
SMTP_URL=smtp://kanbanto%40example.com:the-password@smtp.example.com:587
SMTP_FROM="Kanbanto <kanbanto@example.com>"
```

Then `docker compose up -d`. `smtp://` uses STARTTLS and `smtps://` TLS; for a relay without encryption or sign-in use
`smtp://relay.example.internal:25?security=none`, and add `allow_self_signed=true` for a self-signed certificate.
Characters like `@`, `:`, `/` or `#` in the username or password must be written as `%40`, `%3A`, `%2F`, `%23`. The console
then shows this setting without letting anyone change it; try it with **Send it to me** under Preview.

## Option B: Resend

1. **In Resend:** add your domain under *Domains* and create the DNS records it shows (SPF/DKIM). Wait until it's
   *Verified*. Resend's shared `onboarding@resend.dev` sender only delivers to your own Resend address — fine for a
   test, not for real use.
2. **In Resend → API Keys:** create a key with **Sending access**, limited to your domain.
3. **In Kanbanto → Platform console → Email:** choose **Resend**, paste the key and a sender such as
   `Kanbanto <noreply@kanbanto.example.com>`, then **Save and send a test**.
4. Adjust **Limits** to stay within your Resend plan.

People can also connect **their own** Resend key (Account settings → Email sending); their invites then go out from
their domain and don't count against the site's limits.

## After setting up email

- **How emails look:** product name, button colour and footer (a postal address in the footer helps with spam
  filters). **Preview** shows each email and can send it to you.
- **A DMARC record** in your DNS is recommended, e.g. `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:you@example.com`.
- **New accounts confirm their address:** after signing up, people get a link by email, which confirms it and signs
  them in. Signing up with an address that already has an account gets the same answer, and the address's owner
  gets a note instead, so sign-up can't be used to find out who has an account.
- **Accounts created before email was set up** are asked to confirm their address the next time they open Kanbanto.
  The console shows how many there are. If you know someone's address can't receive email, confirm it for them in
  **Platform console → Accounts → ⋯ → Confirm email**.
- **Admin reset links:** when a platform admin makes a password reset link for someone, that person gets an email
  saying so.

Emails not arriving, or landing in spam? See [Troubleshooting → Email](troubleshooting.md#email).
