/**
 * The site settings' defaults, in one place: the database columns use them, and so does the code whenever nothing's
 * been saved yet (see src/settings.ts). No imports, so the schema can use it too.
 */
export const SETTING_DEFAULTS = {
  openSignup: true,
  /** Emails the site sends per day / month: under Resend's free plan. Null means no limit. */
  emailDailyBudget: 90 as number | null,
  emailMonthlyBudget: 2800 as number | null,
  /** Invite emails each person may send per month with the site's email. Null means no limit. */
  userMonthlyAllowance: 20 as number | null,
  brandName: 'Kanbanto',
  brandColor: '#3b5bdb',
  emailFooter: '',
  /** File space each board owner gets in the site's storage, and the largest file. */
  storageQuotaMb: 50,
  maxFileMb: 10,
  /** People can make API tokens (for scripts, integrations and AI assistants). Off until a platform admin turns it on. */
  apiTokens: false,
  /** Board owners can add webhooks: off, to public addresses only, or to any address (this server's network too). */
  webhooks: 'off' as 'off' | 'public' | 'any',
  /**
   * Apps that connect to people's accounts with sign-in (OAuth), for MCP: Claude on the web and Desktop, ChatGPT.
   * Off; known AI apps only (see src/oauth.ts); or any app (each person still approves each one).
   */
  oauthApps: 'off' as 'off' | 'known' | 'any',
  /** People can make a private calendar link (an address calendar apps subscribe to). Off until a platform admin turns it on. */
  calendarLinks: false,
  /** People can sign in, and sign up, with Google (needs the site's Google app). Off until a platform admin turns it on. */
  googleSignIn: false,
  /** Board owners can connect a Telegram bot of their own to a board. Off until a platform admin turns it on. */
  telegramBots: false,
}
