// A stand-in for Telegram, for the guides' pictures of a board's bot: enough of the bot API for Kanbanto to add a bot,
// connect a chat and post to it, with nothing leaving this computer. Start it before the throwaway site, and point the
// site at it:
//
//   node shots/telegram.mjs 5998
//   TELEGRAM_API_URL=http://127.0.0.1:5998 …the site…
//   GUIDES_TELEGRAM=http://127.0.0.1:5998 GUIDES_SQL=… GUIDES_SITE=… pnpm shots telegram
//
// Any token of the right shape is a bot here (named after the digits before the colon, unless a name follows
// "bot_" in it). The pictures script plays the people: POST /say/<token> with a Telegram update queues it for the bot.
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 5998)
const waiting = new Map()
/** What each bot was asked to send, to look at afterwards: GET /sent/<token>. */
const sent = new Map()
let n = 1000

const nameOf = (token) => /bot_([a-z0-9_]+)$/i.exec(token)?.[1] ?? `bot${token.split(':')[0]}`
const reply = (res, result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))

createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  const say = /^\/say\/(.+)$/.exec(req.url)
  if (say) {
    const token = decodeURIComponent(say[1])
    waiting.set(token, [...(waiting.get(token) ?? []), { update_id: ++n, ...body }])
    return reply(res, true)
  }
  const asked = /^\/sent\/(.+)$/.exec(req.url)
  if (asked) return reply(res, sent.get(decodeURIComponent(asked[1])) ?? [])
  const call = /^\/bot([^/]+)\/(\w+)$/.exec(req.url)
  if (!call) return res.writeHead(404).end()
  const [, token, method] = call
  if (method === 'getMe') return reply(res, { id: Number(token.split(':')[0]), is_bot: true, first_name: nameOf(token), username: nameOf(token) })
  if (method === 'getUpdates') {
    // (Answered at once: the site asks again straight away, which is fine for the minute the pictures take.)
    await new Promise((done) => setTimeout(done, 400))
    const left = (waiting.get(token) ?? []).filter((u) => u.update_id >= (body.offset ?? 0))
    waiting.set(token, left)
    return reply(res, left)
  }
  if (method === 'sendMessage' || method === 'editMessageText') sent.set(token, [...(sent.get(token) ?? []), { method, ...body }])
  if (method === 'sendMessage') return reply(res, { message_id: ++n, chat: { id: body.chat_id } })
  return reply(res, true)
}).listen(port, '127.0.0.1', () => console.log(`A stand-in for Telegram on http://127.0.0.1:${port}`))
