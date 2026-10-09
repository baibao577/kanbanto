import { defineConfig } from 'vitepress'

// Kanbanto's guides: what you can do with it, for the people using it (the technical docs are in ../docs).
// Built into plain pages by `pnpm build` (into .vitepress/dist), to be served under /guides.
export default defineConfig({
  title: 'Kanbanto guides',
  description: 'How to use Kanbanto: boards, cards, tasks inside tasks, working with people and with your AI assistant.',
  lang: 'en',
  base: '/guides/',
  cleanUrls: true,
  // (This folder's own README is for people writing guides, not a guide.)
  srcExclude: ['README.md'],
  appearance: false,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/guides/favicon.svg' }]],
  themeConfig: {
    // (Not the tab's icon, which turns light when the computer is in dark mode: these pages are always light.)
    logo: '/logo.svg',
    siteTitle: 'Kanbanto guides',
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Before', next: 'Next' },
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What Kanbanto is', link: '/start/what-is-kanbanto' },
          { text: 'Your first board', link: '/start/first-board' },
          { text: 'Finding your way around', link: '/start/finding-your-way' },
          { text: 'Bring your work in', link: '/start/import' },
        ],
      },
      {
        text: 'Everyday work',
        items: [
          { text: 'Cards', link: '/everyday/cards' },
          { text: 'Your Inbox', link: '/everyday/inbox' },
          { text: 'Add from anywhere', link: '/everyday/add-from-anywhere' },
          { text: 'Writing a description', link: '/everyday/descriptions' },
          { text: 'Tasks inside tasks', link: '/everyday/subtasks' },
          { text: 'Due dates and reminders', link: '/everyday/dates-and-reminders' },
          { text: 'Comments and files', link: '/everyday/comments-and-files' },
          { text: 'Your own fields', link: '/everyday/fields' },
          { text: 'Templates', link: '/everyday/templates' },
          { text: 'Search and filters', link: '/everyday/search-and-filters' },
          { text: 'Change several cards at once', link: '/everyday/several-cards' },
          { text: 'Done cards and the archive', link: '/everyday/done-and-archive' },
        ],
      },
      {
        text: 'Views and boards',
        items: [
          { text: 'The Board view', link: '/views/board' },
          { text: 'Limits', link: '/views/limits' },
          { text: 'Tell people when a card arrives', link: '/views/telling-rules' },
          { text: 'The Timeline view', link: '/views/timeline' },
          { text: 'The Outline view', link: '/views/outline' },
          { text: 'Board settings, stats and export', link: '/views/board-settings' },
        ],
      },
      {
        text: 'A knowledge base',
        items: [
          { text: 'A knowledge base on a board', link: '/knowledge/overview' },
          { text: 'Set up the board', link: '/knowledge/set-up' },
          { text: 'Write an article', link: '/knowledge/write' },
          { text: 'Write together', link: '/knowledge/together' },
          { text: 'Pages inside pages, and finding things', link: '/knowledge/organise' },
          { text: 'Review and keep it current', link: '/knowledge/review' },
          { text: 'Samples to copy', link: '/knowledge/samples' },
        ],
      },
      {
        text: 'Working with others',
        items: [
          { text: 'Share a board', link: '/people/sharing' },
          { text: 'Workspaces', link: '/people/workspaces' },
          { text: 'Notifications', link: '/people/notifications' },
        ],
      },
      {
        text: 'Working with AI',
        items: [
          { text: 'Connect your assistant', link: '/ai/connect' },
          { text: 'What to ask', link: '/ai/what-to-ask' },
          { text: 'Let an agent work through a list', link: '/ai/agent-queue' },
        ],
      },
      {
        text: 'Time and planning',
        items: [
          { text: 'Log time', link: '/time/log-time' },
          { text: 'My week', link: '/time/my-week' },
          { text: 'Planning people', link: '/time/planning' },
        ],
      },
      {
        text: 'Calendar, other apps and account',
        items: [
          { text: 'Cards in your calendar', link: '/more/calendar' },
          { text: 'Webhooks: tell another app', link: '/more/webhooks' },
          { text: 'Telegram: a bot for a board', link: '/more/telegram' },
          { text: 'Your account', link: '/more/account' },
        ],
      },
    ],
  },
})
