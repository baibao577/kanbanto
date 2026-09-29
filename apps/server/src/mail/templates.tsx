import { render } from '@react-email/render'
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from './components'
import type { EmailKind } from '../db/schema'

/**
 * Every email is one shared layout filled with a little content. The emails are built here (not with the
 * provider's own templates) so they work with any key — the platform's or someone's own — and any provider.
 *
 * Written to read like the legitimate mail it is, which also keeps it out of spam folders: a clear sender, a
 * specific subject, a line saying why you got it, a signature and a footer with the site's address, the link
 * spelled out (so its domain is visible), a plain-text version, and none of the classic trigger words.
 */

/** Branding from the Platform console. */
export interface Brand {
  name: string
  color: string
  footer: string
}

/** What varies between emails. */
export interface EmailContent {
  subject: string
  /** The line inbox lists show next to the subject. */
  preview: string
  heading: string
  paragraphs: string[]
  button?: { label: string; href: string }
  /** Small print under the button ("Didn't ask for this?…"). */
  note?: string
  /** Why this person got the email (shown at the bottom). */
  reason: string
  /** The site's address, for the footer (defaults to the button link's site). */
  site?: string
}

const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif'
const muted = { fontSize: 12, lineHeight: '18px', color: '#6b7080' }

function siteOf(content: EmailContent) {
  try {
    return new URL(content.site ?? content.button?.href ?? '').origin
  } catch {
    return null
  }
}

function Layout({ brand, content }: { brand: Brand; content: EmailContent }) {
  const { button } = content
  const site = siteOf(content)
  return (
    <Html lang="en">
      <Head>
        <title>{content.subject}</title>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
      </Head>
      <Preview>{content.preview}</Preview>
      <Body style={{ backgroundColor: '#f4f5f7', fontFamily: font, margin: 0, padding: '32px 12px' }}>
        <Container style={{ maxWidth: 520, margin: '0 auto' }}>
          <Text style={{ fontSize: 16, fontWeight: 700, color: '#1f2330', margin: '0 0 16px 4px' }}>{brand.name}</Text>
          <Section style={{ backgroundColor: '#ffffff', borderRadius: 12, border: '1px solid #e3e5ea', padding: '28px 28px 20px' }}>
            <Heading style={{ fontSize: 20, lineHeight: '28px', fontWeight: 600, color: '#1f2330', margin: '0 0 12px' }}>{content.heading}</Heading>
            {content.paragraphs.map((p, i) => (
              <Text key={i} style={{ fontSize: 15, lineHeight: '24px', color: '#3d4252', margin: '0 0 12px' }}>
                {p}
              </Text>
            ))}
            {button && (
              <>
                <Section style={{ margin: '20px 0 16px' }}>
                  <Button
                    href={button.href}
                    style={{
                      backgroundColor: brand.color,
                      color: '#ffffff',
                      fontSize: 15,
                      fontWeight: 600,
                      borderRadius: 8,
                      padding: '12px 20px',
                      textDecoration: 'none',
                    }}
                  >
                    {button.label}
                  </Button>
                </Section>
                <Text style={{ ...muted, margin: '0 0 12px', wordBreak: 'break-all' }}>
                  If the button doesn’t work, copy this link into your browser:
                  <br />
                  <Link href={button.href} style={{ color: brand.color }}>
                    {button.href}
                  </Link>
                </Text>
              </>
            )}
            <Text style={{ fontSize: 15, lineHeight: '24px', color: '#3d4252', margin: '16px 0 0' }}>
              Thanks,
              <br />
              The {brand.name} team
            </Text>
            {content.note && (
              <>
                <Hr style={{ borderTop: '1px solid #e3e5ea', margin: '20px 0 12px' }} />
                <Text style={{ ...muted, margin: 0 }}>{content.note}</Text>
              </>
            )}
          </Section>
          <Text style={{ ...muted, color: '#8a8f9c', margin: '16px 4px 0' }}>{content.reason}</Text>
          {brand.footer && <Text style={{ ...muted, color: '#8a8f9c', margin: '8px 4px 0', whiteSpace: 'pre-line' }}>{brand.footer}</Text>}
          <Text style={{ ...muted, color: '#8a8f9c', margin: '8px 4px 0' }}>
            {brand.name}
            {site && (
              <>
                {' · '}
                <Link href={site} style={{ color: '#8a8f9c', textDecoration: 'underline' }}>
                  {new URL(site).host}
                </Link>
              </>
            )}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

/** The finished email: HTML for mail apps, plain text for spam filters and text-only readers. */
export async function renderEmail(brand: Brand, content: EmailContent) {
  const element = <Layout brand={brand} content={content} />
  const [html, text] = await Promise.all([
    render(element),
    // Headings stay as written: ALL-CAPS text is a (mild) spam signal.
    render(element, { plainText: true, htmlToTextOptions: { selectors: [{ selector: 'h1', options: { uppercase: false } }] } }),
  ])
  // A subject is one line: names and titles people typed can't add header lines to it.
  // oxlint-disable-next-line no-control-regex
  return { subject: content.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), html, text }
}

const ROLE_WORDS = { owner: 'manage', editor: 'add and update tasks on', viewer: 'view' } as const

/** The wording of each email. */
export const emails = {
  verify: (brand: Brand, d: { name: string; email: string; url: string }): EmailContent => ({
    subject: `Confirm your email address for ${brand.name}`,
    preview: `One step left to finish setting up your ${brand.name} account.`,
    heading: 'Confirm your email address',
    paragraphs: [
      `Hi ${d.name},`,
      `Thanks for creating a ${brand.name} account. Please confirm that ${d.email} is your email address, so we can reach you about your boards and help you get back in if you forget your password.`,
    ],
    button: { label: 'Confirm email address', href: d.url },
    note: 'This link works for 24 hours.',
    reason: `You’re receiving this because an account was created on ${brand.name} with this email address. If that wasn’t you, you can ignore this email and no account will be activated.`,
  }),

  reset: (brand: Brand, d: { name: string; url: string }): EmailContent => ({
    subject: `Reset your ${brand.name} password`,
    preview: 'Use this link to choose a new password. It works for 1 hour.',
    heading: 'Reset your password',
    paragraphs: [
      `Hi ${d.name},`,
      'We received a request to reset the password for your account. Choose a new password with the button below. For your security, you’ll be signed out on your other devices.',
    ],
    button: { label: 'Choose a new password', href: d.url },
    note: 'This link works for 1 hour and can be used once.',
    reason:
      'You’re receiving this because someone asked to reset the password for this email address. If it wasn’t you, you can ignore this email: your password stays the same.',
  }),

  /**
   * `added`: they had an account and are on the board now · `accept`: they have an account, and accepting (signed in
   * with this address) adds them · `signup`: no account yet. With `workspace`, the invite is to a workspace (`board`
   * is then its name, and `role` doesn't apply).
   */
  invite: (
    brand: Brand,
    d: {
      inviter: string
      board: string
      role: 'owner' | 'editor' | 'viewer'
      url: string
      kind: 'added' | 'accept' | 'signup'
      email: string
      workspace?: boolean
    },
  ): EmailContent => {
    const what = d.workspace ? `the workspace “${d.board}”` : `the board “${d.board}”`
    const wants = d.workspace ? `would like you to join ${what}` : `would like you to ${ROLE_WORDS[d.role]} ${what}`
    return {
      subject: `${d.inviter} invited you to “${d.board}” on ${brand.name}`,
      preview:
        d.kind === 'added'
          ? d.workspace
            ? `You’re now in ${what}.`
            : `You can now ${ROLE_WORDS[d.role]} “${d.board}”.`
          : `Join ${d.inviter} in ${what}.`,
      heading: `${d.inviter} invited you to “${d.board}”`,
      paragraphs:
        d.kind === 'added'
          ? [
              'Hi,',
              d.workspace
                ? `${d.inviter} added you to ${what} on ${brand.name}. You can now open the boards its members share with it, and it’s listed on your boards page.`
                : `${d.inviter} added you to ${what} on ${brand.name}. You can now ${ROLE_WORDS[d.role]} it, and it’s listed on your boards page.`,
            ]
          : d.kind === 'accept'
            ? ['Hi,', `${d.inviter} ${wants} on ${brand.name}.`, `To join, sign in as ${d.email} and accept.`]
            : [
                'Hi,',
                `${d.inviter} ${wants} on ${brand.name}, a tool for planning projects as tasks and subtasks.`,
                `To join, create an account with this email address (${d.email}). It takes less than a minute.`,
              ],
      button: { label: d.kind === 'added' ? (d.workspace ? 'Open your boards' : 'Open the board') : 'Accept the invitation', href: d.url },
      note: d.kind === 'added' ? undefined : `The invitation only works for ${d.email} and can be used once.`,
      reason: `You’re receiving this because ${d.inviter} invited ${d.email} to ${d.workspace ? 'a workspace' : 'a board'} on ${brand.name}. If you weren’t expecting it, you can ignore this email.`,
    }
  },

  digest: (
    brand: Brand,
    d: { name: string; site: string; items: { actor: string; task: string; board: string; excerpt: string }[]; more: number },
  ): EmailContent => {
    const n = d.items.length + d.more
    return {
      subject: n === 1 ? `${d.items[0].actor} mentioned you on ${brand.name}` : `You were mentioned ${n} times on ${brand.name}`,
      preview: d.items.map((i) => `${i.actor} on “${i.task}”`).join(', '),
      heading: n === 1 ? 'You were mentioned' : `You were mentioned ${n} times`,
      paragraphs: [
        `Hi ${d.name}, here’s what you missed:`,
        ...d.items.map((i) => `${i.actor} on “${i.task}” (${i.board}): “${i.excerpt}”`),
        ...(d.more ? [`…and ${d.more} more.`] : []),
      ],
      button: { label: `Open ${brand.name}`, href: d.site },
      reason: `You’re receiving this daily summary because you were mentioned in comments on ${brand.name}. You can turn it off in Account settings → Notifications.`,
    }
  },

  test: (brand: Brand, d: { from: string; to: string; site?: string }): EmailContent => ({
    subject: `Your ${brand.name} email settings are working`,
    preview: `Emails from ${brand.name} will be sent from ${d.from}.`,
    heading: 'Your email settings are working',
    paragraphs: [
      'Hi,',
      `This message confirms that ${brand.name} can send email from ${d.from}. Account confirmations, password resets and board invitations will now be delivered to your members.`,
      'You can change the sender, limits and look of these emails at any time in the Platform console.',
    ],
    reason: `You’re receiving this because the email settings for ${brand.name} were saved with ${d.to} as the test address.`,
    site: d.site,
  }),

  /**
   * Security notices about your account: `admin-reset` (a platform admin made a password reset link for it) ·
   * `account-exists` (someone tried to sign up with this address, which already has an account).
   */
  notice: (brand: Brand, d: { name: string; what: 'admin-reset' | 'account-exists'; site: string }): EmailContent =>
    d.what === 'admin-reset'
      ? {
          subject: `A password reset link was made for your ${brand.name} account`,
          preview: 'A platform admin made a link for choosing a new password for your account.',
          heading: 'A password reset link was made for you',
          paragraphs: [
            `Hi ${d.name},`,
            `A platform admin of ${brand.name} made a link for choosing a new password for your account. If you asked them to, there’s nothing more to do.`,
            'If you didn’t, contact your admin. Your password stays the same until the link is used, and the link stops working after 24 hours.',
          ],
          reason: `You’re receiving this because a platform admin made a password reset link for this account on ${brand.name}.`,
          site: d.site,
        }
      : {
          subject: `You already have a ${brand.name} account`,
          preview: 'Someone tried to create an account with this email address. You can sign in instead.',
          heading: 'You already have an account',
          paragraphs: [
            `Hi ${d.name},`,
            `Someone (probably you) tried to create a ${brand.name} account with this email address. You already have one, so no new account was made.`,
          ],
          button: { label: 'Sign in', href: `${d.site}/#/signin` },
          note: 'Forgot your password? You can reset it from the sign-in page.',
          reason: `You’re receiving this because someone tried to sign up on ${brand.name} with this email address. If it wasn’t you, you can ignore this email.`,
          site: d.site,
        },
} satisfies Record<EmailKind, (brand: Brand, d: never) => EmailContent>

/** Sample content for previews in the Platform console. */
export function sampleEmail(kind: EmailKind, brand: Brand, appUrl: string): EmailContent {
  switch (kind) {
    case 'verify':
      return emails.verify(brand, { name: 'Sam', email: 'sam@example.com', url: `${appUrl}/#/verify/sample` })
    case 'reset':
      return emails.reset(brand, { name: 'Sam', url: `${appUrl}/#/reset/sample` })
    case 'invite':
      return emails.invite(brand, {
        inviter: 'Sam',
        board: 'Website launch',
        role: 'editor',
        url: `${appUrl}/#/join/sample`,
        kind: 'signup',
        email: 'alex@example.com',
      })
    case 'digest':
      return emails.digest(brand, {
        name: 'Sam',
        site: `${appUrl}/`,
        items: [
          { actor: 'Alex', task: 'Homepage copy', board: 'Website launch', excerpt: '@Sam can you check the pricing section before Friday?' },
          { actor: 'Jo', task: 'Logo', board: 'Website launch', excerpt: 'Two options attached, @Sam which one do you prefer?' },
        ],
        more: 0,
      })
    case 'test':
      return emails.test(brand, { from: `${brand.name} <noreply@example.com>`, to: 'you@example.com', site: appUrl })
    case 'notice':
      return emails.notice(brand, { name: 'Sam', what: 'account-exists', site: appUrl })
  }
}
