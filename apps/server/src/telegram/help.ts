/**
 * How a board's Telegram bot is used in the chat, in a few lines: what `/help` answers, and what the bot says once
 * when it's connected. The guide (guides/more/telegram.md) says the same at length, and a test holds the two
 * together: every line here is in the guide, word for word.
 */
export const HELP = {
  /** In someone's own chat with the bot. */
  private: [
    'Send me a message and it becomes a card. The first line is the title, the rest is the description.',
    'Say when in the first line ("call Sam tomorrow 3pm") and the card is due then.',
    'Send a photo or a file and it is attached; its caption is the title.',
  ],
  /** In a group. */
  group: [
    'Send /card and a title to add a card: /card Fix the sign-up page',
    'Reply to anyone’s message with /card to make a card of that message.',
    'Send a photo or a file with /card as its caption and it is attached.',
  ],
  /** After a card is made, everywhere. */
  after: [
    'Under my answer: Undo takes the card back, No date removes a date I read by mistake.',
    'Edit your message and the card changes with it.',
    'Reply to my answer and your words are a comment on the card.',
  ],
  /** The shortcuts in the menu, everywhere. */
  menu: ['Send /list to see the cards waiting in the list, and /board for a link to the board.'],
  /** …and the one more in someone's own chat with the bot. */
  own: ['Send /today for what is due today and tomorrow, what is overdue, and your reminders in the next 24 hours, on this board.'],
} as const

export const helpText = (kind: 'private' | 'group') =>
  [...HELP[kind], ...HELP.after, ...HELP.menu, ...(kind === 'private' ? HELP.own : [])].map((line) => `• ${line}`).join('\n')
