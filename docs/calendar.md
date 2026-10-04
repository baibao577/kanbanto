# Calendar

Putting people's cards in the calendar they already use. This is part of [Self-hosting](self-hosting.md); every
setting is also listed in [Configuration](configuration.md).

Optional, and off until a platform admin turns it on. There are two ways, and you can offer either or both
(**Platform console → Integrations**):

| | What people get | What you set up |
|---|---|---|
| **Google Calendar** | They sign in with Google once; Kanbanto adds a calendar of its own to their Google account and keeps it up to date within seconds. | A Google app, made once in Google Cloud (below) |
| **Calendar links** | A private address that Apple Calendar, Outlook and other calendar apps subscribe to. Apps look again about every hour; Google only a few times a day. | One switch |

Each person then connects in **Account settings → Calendar**, and chooses which boards are in their calendar.

## What's in a person's calendar

- **Their cards with a due date:** cards assigned to them, on every board they can open, and on boards where they are
  the only person, the cards assigned to nobody.
- **A due date is one event:** all day, or half an hour starting at its time when it has one. Only the due date is
  used, not the start date.
- **A reminder** that would reach them is an alert on that event when the due date has a time and the reminder comes
  before it (up to four weeks, five per card). Otherwise it's a short event of its own at the time it fires, titled
  "⏰" and the card's name. In a calendar link every reminder is an event of its own, because calendar apps mostly
  ignore the alerts in a calendar they subscribe to.
- **Done cards** stay, ticked ("✓ Pay rent"), without their reminders. Archived cards and archived boards are taken
  out, and come back when restored.
- Each event links back to its card.

It goes **one way**, from Kanbanto to the calendar: an event changed or deleted in Google Calendar is put back the
next time its card changes. Kanbanto still sends its own reminders (the bell, email, desktop notifications) as before.

## Google Calendar

You make a Google app once; everyone on your site connects through it. It asks people for one permission: to make
calendars of its own and manage the events in them. It can't see or change their other calendars.

1. Open [Google Cloud → APIs & Services](https://console.cloud.google.com/apis/dashboard), make a project, and under
   **Library** turn on the **Google Calendar API**.
2. Under **OAuth consent screen** (Google Auth Platform), set the app's name and your contact address.
   - Everyone on your site is in your Google Workspace: choose **Internal**, and you're done with this step.
   - Otherwise choose **External**, and then **publish the app** ("In production"). Left in "Testing", Google ends
     every connection after 7 days, and only test users you list can connect.
   - Under **Data access**, add the scope `https://www.googleapis.com/auth/calendar.app.created`. Google may ask to
     review an External app before it lets everyone connect without a warning page.
3. Under **Credentials** (Clients), create an **OAuth client ID** of type **Web application**. Add the **authorized
   redirect URI** that the Platform console shows you: your site's address followed by
   `/api/account/calendar/google/callback`.
4. In **Platform console → Integrations → Google Calendar**, paste the **client ID** and **client secret**, and save.
   The secret is stored encrypted and never shown again.

People now see **Connect Google Calendar** in Account settings → Calendar. Disconnecting removes Kanbanto's calendar
from their Google account. "Stop using it" in the console stops every connected calendar from updating until a Google
app is saved again.

Your site doesn't need to be reachable from the internet for this: Kanbanto calls Google, and people's own browsers
carry them to Google and back. Google does require the redirect address to be `https://` on a real domain name (not
a bare IP address); `http://localhost` is allowed for trying it out.

## Calendar links

Turn on **People can make calendar links**. Each person makes a link in Account settings → Calendar and adds it to
their calendar app as a calendar to subscribe to (in Apple Calendar: File → New Calendar Subscription).

A link works without signing in, so **whoever has it can read the titles and dates of that person's cards**, and
nothing else. People can make a new link (the old one stops working at once) or turn theirs off; turning the setting
off stops every link.

## When it doesn't update

- **"Last problem" in Account settings → Calendar** says what Google answered. When Google can't be reached,
  Kanbanto tries again after 1, 5 and 30 minutes, then every few hours, and catches up by itself.
- **"Connect again"** means Google no longer accepts the connection: the person took the access away in their Google
  account, or the Google app is still in "Testing" (see step 2). Connecting again carries on with the same calendar.
- **A subscribed link is slow in Google Calendar.** Google decides when to look again, a few times a day. Connect
  Google Calendar instead.
- **Alerts don't ring from a link.** Calendar apps often leave out the alerts of calendars you subscribe to; in Apple
  Calendar, untick "Remove alerts" on the subscription.
