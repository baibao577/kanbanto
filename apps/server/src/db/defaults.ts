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
}
