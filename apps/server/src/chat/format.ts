import type { ActivityItem } from '@kanbanto/model/activity'
import type { ChatFormat } from '@kanbanto/model/api'
import type { Change } from '@kanbanto/model/records'

/**
 * A webhook's news as text a chat app shows in a channel: "Ann moved “Deploy” to Done on Launch", the card's title
 * opening the card. The words are the activity log's own; each app gets them in the body it reads, with what people
 * typed made harmless there (a card called "@everyone" or "<!channel>" tells nobody).
 */

/** A piece of a line: plain words, or words that open an address. */
export interface Piece {
  text: string
  url?: string
}
export type Line = Piece[]
export interface ChatMessage {
  lines: Line[]
}

/** Lines of one change that a message shows; the rest are counted ("and 5 more"). */
const MAX_LINES = 8
const EXCERPT = 200
const DISCORD_MAX = 2000

const q = (s: string) => `“${s}”`
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** A sentence with the card's title turned into a link to the card. */
function linked(text: string, title: string | undefined, url: string | null): Line {
  const at = title ? text.lastIndexOf(q(title)) : -1
  if (!url || at < 0) return [{ text }]
  const end = at + q(title!).length
  return [{ text: text.slice(0, at) }, { text: q(title!), url }, { text: text.slice(end) }].filter((p) => p.text)
}

/**
 * What a change did, as the activity log says it. `cardUrl`: a card's address (null when the site's own isn't known).
 * Null when there's nothing to say (the change only reordered things).
 */
export function changeMessage(
  e: { actor: string | null; board: string; items: ActivityItem[]; changes: Change[] },
  cardUrl: (taskId: string) => string | null,
): ChatMessage | null {
  if (!e.items.length) return null
  const who = e.actor ?? 'Someone'
  // Only cards that are still on the board get a link: a deleted or archived one has nowhere to open.
  const titles = new Map<string, string>()
  for (const c of e.changes) {
    const after = c.entity === 'task' ? (c.after as { title: string; archivedAt?: string } | null) : null
    if (after && !after.archivedAt) titles.set(c.id, after.title)
  }
  const line = (item: ActivityItem): Line => {
    const title = item.taskId ? titles.get(item.taskId) : undefined
    return linked(item.text, title, title ? cardUrl(item.taskId!) : null)
  }
  if (e.items.length === 1) return { lines: [[{ text: `${who} ` }, ...line(e.items[0]), { text: ` on ${e.board}` }]] }
  const more = e.items.length - MAX_LINES
  return {
    lines: [
      [{ text: `${who}, on ${e.board}:` }],
      ...e.items.slice(0, MAX_LINES).map((item) => [{ text: '• ' }, ...line(item)]),
      ...(more > 0 ? [[{ text: `and ${more} more` }]] : []),
    ],
  }
}

/** `about`: the words of the card's description the comment is about (or the comment it answers is). */
export function commentMessage(c: { actor: string; board: string; title: string; body: string; about?: string }, url: string | null): ChatMessage {
  const words = short(c.body.replace(/\s+/g, ' ').trim(), EXCERPT)
  const about = c.about ? `, about ${q(short(c.about.replace(/\s+/g, ' ').trim(), 60))}` : ''
  return {
    lines: [
      [
        { text: `${c.actor} commented on ` },
        { text: q(c.title), ...(url && { url }) },
        { text: ` on ${c.board}${about}${words ? `: ${words}` : ''}` },
      ],
    ],
  }
}

/** `due`: in words ("Fri 3 Oct"), or null when the card has no due date. */
export function reminderMessage(r: { for: string; board: string; title: string; due: string | null }, url: string | null): ChatMessage {
  return {
    lines: [
      [{ text: `Reminder for ${r.for}: ` }, { text: q(r.title), ...(url && { url }) }, { text: ` on ${r.board}${r.due ? `, due ${r.due}` : ''}` }],
    ],
  }
}

/** The first message to a channel: it has to be accepted before the webhook is saved. */
export const helloMessage = (board: string): ChatMessage => ({ lines: [[{ text: `Kanbanto will post news from ${board} here.` }]] })
export const testMessage = (board: string): ChatMessage => ({ lines: [[{ text: `A test from Kanbanto for ${board}.` }]] })

// ── Each app's own writing ──────────────────────────────────────────────────────

/** Slack: &, < and > are the only characters with a meaning of their own (a mention is written <!channel>, <@U…>). */
const slack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Google Chat has no way to escape "<" (a mention is written <users/all>): an invisible space after it breaks the
 * tag instead. Inside a link's words, ">" would end the link.
 */
const googleChat = (s: string) => s.replace(/</g, '<​')
const googleChatLabel = (s: string) => googleChat(s).replace(/>/g, '›')

/**
 * Telegram (its HTML): &, < and > written out, and an invisible joiner after each @, so "@someone" in a card's title
 * is those characters and mentions nobody.
 */
export const telegramHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/@/g, '@\u2060')
/**
 * Telegram only makes a link of an address on the internet: one on this computer ("http://localhost:3000", a site
 * being tried out) is shown as plain words, link or no link. So there the words stay words, and "Open" becomes the
 * address itself, to tap and copy.
 */
const telegramLinks = (url: string) => {
  try {
    return new URL(url).hostname.includes('.')
  } catch {
    return false
  }
}
/** Words that open an address, in Telegram's HTML (just the words, where Telegram wouldn't make the link). */
export const telegramLink = (url: string | null, words: string) =>
  url && telegramLinks(url) ? `<a href="${telegramHtml(url)}">${telegramHtml(words)}</a>` : telegramHtml(words)
/** "Open ›" for an address (or the address itself to copy, where Telegram wouldn't make the link). */
export const telegramOpen = (url: string | null, words = 'Open ›') =>
  !url ? '' : telegramLinks(url) ? telegramLink(url, words) : `<code>${url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`

/** A message for Telegram, from text already written in its HTML: no preview of the page a link goes to. */
export const telegramText = (html: string) => ({ text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })

/** Markdown (Discord, Teams): a backslash before every character that would start something. */
const markdown = (s: string) => s.replace(/[\\*_~`|>#[\]()<]/g, '\\$&')

function write(format: ChatFormat, line: Line): string {
  return line
    .map((p) => {
      switch (format) {
        case 'slack':
          return p.url ? `<${p.url}|${slack(p.text)}>` : slack(p.text)
        case 'google-chat':
          return p.url ? `<${p.url}|${googleChatLabel(p.text)}>` : googleChat(p.text)
        case 'discord':
          // (The address in <…>: Discord then shows no preview of the page under the message.)
          return p.url ? `[${markdown(p.text)}](<${p.url}>)` : markdown(p.text)
        case 'teams':
          return p.url ? `[${markdown(p.text)}](${p.url})` : markdown(p.text)
        case 'telegram':
          return telegramLink(p.url ?? null, p.text)
      }
    })
    .join('')
}

/** Discord takes 2,000 characters: whole lines are left off the end, and a single line too long is cut. */
function discordContent(lines: string[]): string {
  const kept = [...lines]
  while (kept.length > 1 && kept.join('\n').length > DISCORD_MAX - 20) kept.pop()
  const text = kept.length < lines.length ? `${kept.join('\n')}\nand more` : kept.join('\n')
  return text.length > DISCORD_MAX ? `${text.slice(0, DISCORD_MAX - 1)}…` : text
}

/** The body the chat app reads (what's POSTed to the channel's address, and kept in the delivery log). */
export function chatBody(format: ChatFormat, message: ChatMessage): object {
  const lines = message.lines.map((line) => write(format, line))
  switch (format) {
    case 'slack':
    case 'google-chat':
      return { text: lines.join('\n') }
    case 'discord':
      // No mention in the text tells anyone, whatever a card is called.
      return { content: discordContent(lines), allowed_mentions: { parse: [] } }
    case 'telegram':
      // (Sent through the board's bot, which adds the chat: see telegram/bots.ts.)
      return telegramText(lines.join('\n'))
    case 'teams':
      // A channel's "Workflows" address takes a message holding an Adaptive Card.
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: lines.map((text) => ({ type: 'TextBlock', text, wrap: true })),
            },
          },
        ],
      }
  }
}
