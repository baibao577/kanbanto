import { WEBHOOK_FORMAT_NAMES, type ChatFormat } from '@kanbanto/model/api'
import { HttpError } from '../http'

/**
 * Where each chat app gives out its channel addresses. On a site that only sends webhooks to public addresses, an
 * address is otherwise asked to confirm it wants them (it's sent a code and must answer with it), which a chat app
 * can't do. So a chat webhook may only point at the chat app itself: there, the address is what a channel's owner
 * made for it, and whoever holds it may post.
 */
const HOSTS: Record<ChatFormat, { hosts: string[]; suffixes?: string[]; path?: RegExp; example: string }> = {
  slack: { hosts: ['hooks.slack.com', 'hooks.slack-gov.com'], example: 'https://hooks.slack.com/services/…' },
  discord: {
    hosts: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'],
    path: /^\/api\/(v\d+\/)?webhooks\//,
    example: 'https://discord.com/api/webhooks/…',
  },
  'google-chat': { hosts: ['chat.googleapis.com'], example: 'https://chat.googleapis.com/v1/spaces/…' },
  // A channel's workflow (Power Automate). Its addresses moved from logic.azure.com to api.powerplatform.com in 2025.
  teams: {
    hosts: [],
    suffixes: ['.api.powerplatform.com', '.api.powerplatform.us', '.logic.azure.com', '.logic.azure.us'],
    example: 'https://….environment.api.powerplatform.com/…',
  },
}

/** Refuses an address that isn't the chat app's own. */
export function checkChatAddress(format: ChatFormat, url: string) {
  const rule = HOSTS[format]
  const u = new URL(url)
  const host = u.hostname.toLowerCase()
  const known = rule.hosts.includes(host) || (rule.suffixes ?? []).some((s) => host.endsWith(s))
  if (!known || (rule.path && !rule.path.test(u.pathname)))
    throw new HttpError(400, `That isn’t a ${WEBHOOK_FORMAT_NAMES[format]} address. Theirs look like ${rule.example}`)
}
