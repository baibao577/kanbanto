import type { ActivityItem } from '@kanbanto/model/activity'
import type { Change } from '@kanbanto/model/records'
import { describe, expect, it } from 'vitest'
import { changeMessage, chatBody, commentMessage, helloMessage, reminderMessage, type ChatMessage } from '../src/chat/format'
import { checkChatAddress } from '../src/chat/hosts'

const url = (taskId: string) => `https://kanbanto.example/#/b/b1?task=${taskId}`
const task = (id: string, title: string, extra: object = {}): Change =>
  ({ entity: 'task', id, before: null, after: { id, title, ...extra } }) as Change
const change = (items: ActivityItem[], changes: Change[], actor: string | null = 'Ann') =>
  changeMessage({ actor, board: 'Launch', items, changes }, url)!

const slack = (m: ChatMessage) => (chatBody('slack', m) as { text: string }).text
const google = (m: ChatMessage) => (chatBody('google-chat', m) as { text: string }).text
const discord = (m: ChatMessage) => chatBody('discord', m) as { content: string; allowed_mentions: { parse: string[] } }
const teams = (m: ChatMessage) =>
  (
    chatBody('teams', m) as {
      attachments: { contentType: string; content: { type: string; body: { type: string; text: string; wrap: boolean }[] } }[]
    }
  ).attachments[0]

describe('a change, in words for a chat', () => {
  const one = change([{ taskId: 'A3', text: 'moved “Deploy” to Done' }], [task('A3', 'Deploy')])

  it('one line: who, what, on which board, the title opening the card', () => {
    expect(slack(one)).toBe('Ann moved <https://kanbanto.example/#/b/b1?task=A3|“Deploy”> to Done on Launch')
    expect(google(one)).toBe('Ann moved <https://kanbanto.example/#/b/b1?task=A3|“Deploy”> to Done on Launch')
    expect(discord(one)).toEqual({
      content: 'Ann moved [“Deploy”](<https://kanbanto.example/#/b/b1?task=A3>) to Done on Launch',
      allowed_mentions: { parse: [] },
    })
    const card = teams(one)
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(card.content).toMatchObject({
      type: 'AdaptiveCard',
      body: [{ type: 'TextBlock', text: 'Ann moved [“Deploy”](https://kanbanto.example/#/b/b1?task=A3) to Done on Launch', wrap: true }],
    })
  })

  it('several lines are one message; past eight, the rest are counted', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ taskId: `T${i}`, text: `added “Card ${i}”` }))
    const many = change(
      items,
      items.map((x, i) => task(x.taskId, `Card ${i}`)),
    )
    const lines = slack(many).split('\n')
    expect(lines[0]).toBe('Ann, on Launch:')
    expect(lines[1]).toBe('• added <https://kanbanto.example/#/b/b1?task=T0|“Card 0”>')
    expect(lines).toHaveLength(10)
    expect(lines[9]).toBe('and 3 more')
    expect(teams(many).content.body).toHaveLength(10)
  })

  it('says nothing when nothing is worth a line; names nobody when the person is gone', () => {
    expect(changeMessage({ actor: 'Ann', board: 'Launch', items: [], changes: [task('A', 'x')] }, url)).toBeNull()
    expect(slack(change([{ text: 'added the list “Later”' }], [], null))).toBe('Someone added the list “Later” on Launch')
  })

  it('a card that is gone, or put away, has no link; nor has any when the site’s address isn’t known', () => {
    const gone: Change = { entity: 'task', id: 'A3', before: { id: 'A3', title: 'Deploy' }, after: null } as Change
    expect(slack(change([{ taskId: 'A3', text: 'deleted “Deploy”' }], [gone]))).toBe('Ann deleted “Deploy” on Launch')
    const archived = task('A3', 'Deploy', { archivedAt: '2026-10-06T00:00:00.000Z' })
    expect(slack(change([{ taskId: 'A3', text: 'archived “Deploy”' }], [archived]))).toBe('Ann archived “Deploy” on Launch')
    const unknown = changeMessage(
      { actor: 'Ann', board: 'Launch', items: [{ taskId: 'A3', text: 'added “Deploy”' }], changes: [task('A3', 'Deploy')] },
      () => null,
    )!
    expect(slack(unknown)).toBe('Ann added “Deploy” on Launch')
  })

  it('a renamed card links its new name', () => {
    const renamed = change([{ taskId: 'A', text: 'renamed “Launch” to “Launch!”' }], [task('A', 'Launch!')])
    expect(slack(renamed)).toBe('Ann renamed “Launch” to <https://kanbanto.example/#/b/b1?task=A|“Launch!”> on Launch')
  })
})

describe('what people typed can’t tell anyone, or start anything, in the chat', () => {
  const title = '<!channel> @everyone *x* [a](b) <users/all> & <@U123>'
  const hostile = change([{ taskId: 'A', text: `added “${title}”` }], [task('A', title)])

  it('Slack: its three characters are written out', () => {
    const text = slack(hostile)
    expect(text).toContain('&lt;!channel&gt;')
    expect(text).toContain('&lt;@U123&gt;')
    expect(text).toContain('&amp;')
    // The only "<" left opens the link to the card.
    expect(text.match(/</g)).toHaveLength(1)
  })

  it('Google Chat: no tag survives, and the link ends where it should', () => {
    const text = google(hostile)
    expect(text).not.toContain('<users/all>')
    expect(text).not.toContain('<!channel>')
    expect(text).toContain('<​users/all›')
    expect(text.match(/>/g)).toHaveLength(1)
    expect(text.endsWith('”> on Launch')).toBe(true)
  })

  it('Discord: no mention is acted on, and markdown is written out', () => {
    const body = discord(hostile)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.content).toContain('\\*x\\*')
    expect(body.content).toContain('\\[a\\]\\(b\\)')
    expect(body.content).toContain('\\<@U123\\>')
  })

  it('Teams: markdown is written out', () => {
    const [block] = teams(hostile).content.body
    expect(block.text).toContain('\\*x\\*')
    expect(block.text).toContain('\\[a\\]\\(b\\)')
  })

  it('Discord takes 2,000 characters: whole lines are left off, and one long line is cut', () => {
    const long = 'x'.repeat(450)
    const items = Array.from({ length: 8 }, (_, i) => ({ taskId: `T${i}`, text: `added “${long}${i}”` }))
    const body = discord(
      change(
        items,
        items.map((x, i) => task(x.taskId, `${long}${i}`)),
      ),
    )
    expect(body.content.length).toBeLessThanOrEqual(2000)
    expect(body.content.endsWith('\nand more')).toBe(true)
    const single = discord(commentMessage({ actor: 'Ann', board: 'Launch', title: '*'.repeat(500), body: 'ok' }, null))
    expect(single.content.length).toBeLessThanOrEqual(2000)
  })
})

describe('comments, reminders and the first message', () => {
  it('a comment: who, on which card, and how it starts', () => {
    const m = commentMessage({ actor: 'Ann', board: 'Launch', title: 'Deploy', body: `Shipped\n\nthis   morning. ${'z'.repeat(300)}` }, url('A3'))
    const text = slack(m)
    expect(text.startsWith('Ann commented on <https://kanbanto.example/#/b/b1?task=A3|“Deploy”> on Launch: Shipped this morning. zzz')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThan(320)
  })

  it('a reminder: for whom, which card, when it’s due', () => {
    expect(slack(reminderMessage({ for: 'Ben', board: 'Launch', title: 'Deploy', due: 'Fri 3 Oct' }, null))).toBe(
      'Reminder for Ben: “Deploy” on Launch, due Fri 3 Oct',
    )
    expect(slack(reminderMessage({ for: 'Ben', board: 'Launch', title: 'Deploy', due: null }, null))).toBe('Reminder for Ben: “Deploy” on Launch')
  })

  it('the first message says what the channel will get', () => {
    expect(chatBody('slack', helloMessage('Launch'))).toEqual({ text: 'Kanbanto will post news from Launch here.' })
  })
})

describe('a chat webhook’s address has to be the chat app’s own (where the site only sends to public addresses)', () => {
  const ok = (format: Parameters<typeof checkChatAddress>[0], address: string) => expect(() => checkChatAddress(format, address)).not.toThrow()
  const no = (format: Parameters<typeof checkChatAddress>[0], address: string) => expect(() => checkChatAddress(format, address)).toThrow(/isn’t a/)

  it('Slack', () => {
    ok('slack', 'https://hooks.slack.com/services/T0/B0/abc')
    no('slack', 'https://example.com/services/T0/B0/abc')
    no('slack', 'https://hooks.slack.com.example.com/services/T0/B0/abc')
  })

  it('Discord', () => {
    ok('discord', 'https://discord.com/api/webhooks/1/abc')
    ok('discord', 'https://discordapp.com/api/v10/webhooks/1/abc')
    no('discord', 'https://discord.com/channels/1/2')
    no('discord', 'https://example.com/api/webhooks/1/abc')
  })

  it('Google Chat', () => {
    ok('google-chat', 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t')
    no('google-chat', 'https://googleapis.com.example.org/v1/spaces/AAA/messages')
  })

  it('Microsoft Teams (a channel’s workflow)', () => {
    ok(
      'teams',
      'https://abc123.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=s',
    )
    ok('teams', 'https://prod-12.westeurope.logic.azure.com:443/workflows/x/triggers/manual/paths/invoke?sig=s')
    no('teams', 'https://api.powerplatform.com.example.com/x')
    no('teams', 'https://example.com/workflows/x')
  })
})

/**
 * Against a real channel: only when asked, with the address the chat app gave for it. Each one named is sent the
 * first message, a change with a link, and a card whose title tries to mention everyone, for someone to look at in
 * the channel (nothing there should be pinged, and the title should read as typed).
 *
 *   CHAT_TEST_SLACK=https://hooks.slack.com/services/… pnpm --filter @kanbanto/server exec vitest run test/chat.test.ts
 *
 * Also CHAT_TEST_GOOGLE, CHAT_TEST_TEAMS and CHAT_TEST_DISCORD.
 */
const channels = [
  ['slack', process.env.CHAT_TEST_SLACK],
  ['google-chat', process.env.CHAT_TEST_GOOGLE],
  ['teams', process.env.CHAT_TEST_TEAMS],
  ['discord', process.env.CHAT_TEST_DISCORD],
] as const
describe.skipIf(!channels.some(([, address]) => address))('a real channel', () => {
  for (const [format, address] of channels)
    it.skipIf(!address)(`${format} takes the messages`, async () => {
      checkChatAddress(format, address!)
      const hostile = '<!channel> @everyone @here *bold* [a](https://example.com) <users/all> & _so on_'
      const messages = [
        helloMessage('Launch'),
        change([{ taskId: 'A3', text: 'moved “Deploy” to Done' }], [task('A3', 'Deploy')]),
        change([{ taskId: 'A', text: `added “${hostile}”` }], [task('A', hostile)]),
      ]
      for (const message of messages) {
        const res = await fetch(address!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chatBody(format, message)),
        })
        expect(res.status, await res.text()).toBeGreaterThanOrEqual(200)
        expect(res.status).toBeLessThan(300)
      }
    })
})
