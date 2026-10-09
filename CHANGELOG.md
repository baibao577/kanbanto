# Changelog

What changed in each release, newest first. Upgrading? See [Upgrades](docs/self-hosting.md#upgrades): back up first,
then `git pull` (or download the new release) and `docker compose up -d --build`. Database updates run by themselves.

## Unreleased

- **Code with colours, and diagrams written as text.** A code block that says its language (` ```ts `, or picked
  from the small list on the block while writing) has its words coloured by kind, read and written, and when read
  it names its language and has a button that copies it. A block that says no language is plain: nothing is
  guessed.

  A code block that says `mermaid` is drawn as a diagram: a flowchart, a sequence, a timeline. While you write,
  the drawing is under the text and follows it as you type; when read, the drawing shows, with its text one click
  away. The text is what is saved, so assistants write diagrams, anyone who can edit the card can change one, and
  GitHub draws the same picture. The part that draws is large and is fetched the first time a description with a
  diagram is opened, never before. A diagram is shown as a picture, so nothing in its text can run or fetch
  anything.

  Upgrading adds three packages to the web app (Mermaid, lowlight and highlight.js); the built app is about 5 MB
  larger on disk, and no larger to load until a description has code or a diagram.

  The guides: **Code** and **Diagrams** on the page about writing a description.

- **Fold a section away, and link to one.** Every heading of a description has a small arrow in the margin, while
  you read it and while you write it: click it and what is under that heading is put away, down to the next
  heading of its size. It is for you alone (nothing changes in the text, and someone writing it with you sees
  their own folds) and is remembered for that card in your browser. What is folded is still found by Contents and
  by a comment on its words, and while reading by your browser's search, each of which opens it; while writing, a
  section opens when the cursor gets into it. On the full page a heading also has a link button: the link it
  copies opens the page at that section.

- **Callouts, and a bar on tables.** A description can have a **callout**: a box that says Note, Tip, Important,
  Warning or Caution, for the line a reader must not miss. Type `/note` (or `/warning`, `/tip`…), and click its
  icon to change its kind. In the saved text it is a quote that starts with its kind, `> [!WARNING]`, the way
  GitHub writes them: one an assistant writes shows as a box, and what you write shows as one there.

  While the cursor is in a **table**, a small bar sits on it: add a row above or below, a column to the left or
  the right, line a column up left, centre or right, delete the row, the column or the table. Columns size
  themselves, and on a description's full page a table too wide for the text takes the width of the page.

  Mended on the way: a second line in a table's cell (<kbd>Shift+Enter</kbd>) showed as the letters `<br>`; cells
  pasted from a spreadsheet arrived under an empty heading row (and where the spreadsheet program also puts a
  picture of the cells on the clipboard, the picture was attached in their place); editing a description broke its footnotes, and a callout an assistant had written;
  with two people writing in the same heading, one's cursor was left behind when the other typed earlier in the
  line.

  After this update, a page that was open before it says **Load the page again** when you start writing a
  description: everyone writing a text has to be on the same version of the editor. Nothing is lost, and reading
  is as it was. For apps and assistants nothing changes: a description is Markdown, as before.

  The guides: **Callouts** and **Tables** on the page about writing a description.

- **Comment on the words of a description.** Open a description full page (**Expand**), select some words,
  while you read it or while you write it, and click **Comment**. The words are marked in the text and the
  comment sits beside it. Others **Reply** under it,
  and **Resolve** folds it away when it is settled (**Reopen**, or a new answer, brings it back). Everyone who can
  comment can do all of it, viewers too: nobody has to be able to edit the card.

  The same comment is in the card's Comments, with the words quoted above it: one conversation, shown in two
  places. Nothing is written into the description to hold a comment in place. The comment keeps its words and
  finds them again each time the text is shown, so it follows them when the text moves, and says "The text this
  was about has changed" when they have been rewritten. An assistant can rewrite a description, or several people
  can write in it at once, and no comment is lost.

  The people told are the ones told of any comment (the card's followers, anyone @mentioned); the line under the
  bell quotes the words and opens the description at them. Whoever wrote a comment gets one line when someone
  else resolves it.

  For apps: a comment may carry `passage` (the words) or `parentId` (the comment it answers), and has `resolved`;
  `PUT /api/boards/:id/comments/:commentId/resolved` settles one; `comment.added` says `about` and `replyTo`. For
  assistants: `get_task` shows which words a comment is about, and `add_comment` takes `about` and `reply_to`. A
  board's export file carries these comments with their answers. Upgrading adds four columns to one table.

  The guides: a new page, **Comment on the text**, in the knowledge base group.

- **Write a description together.** Several people can write the same description at the same moment. Open the
  card and click **Edit**: if someone is already writing, you are in the same text, with their cursor and name
  where they are and their words as they type them. The card says who is writing to everyone who has it open. It
  works in the card and full page, and on a phone.

  A description now **saves as you write**, a few seconds after you stop typing, where it used to be saved when
  you finished. The sign in the toolbar says **Saving…**, then **Saved**. With no connection it says **Offline**:
  keep writing, and your words join the others' when you are back. If that can't be (you were away so long that
  they had finished), what you wrote is offered back on the card to copy.

  While people are writing a description, it isn't changed from anywhere else: an assistant, an app or an undo
  that would replace it is told who is writing. It goes through once nobody has typed for two minutes. A box in a
  checklist can't be ticked from outside the editor meanwhile, either.

  **Earlier versions** of every description are kept from now on, whoever or whatever changed it. Open it full
  page and click **Versions** to read the text as it was and to bring a version back. A person's saves within ten
  minutes are one version, and a card keeps its newest 100.

  Also: undoing an older change to a card (its list, its date) no longer puts the description back to what it
  was at that moment. The card's History has one "edited the description" line for each writer about every ten
  minutes of writing, and followers are told once, not at every save.

  For apps: a command that would change a description being written is refused with 422 and
  `code: "being-written"`; `GET /api/boards/:id/tasks/:taskId/versions` lists a description's earlier versions;
  a webhook gets the saves of one stretch of writing as one `board.changed`. Upgrading adds one table.

  The guides: a new page, **Write together**, in the knowledge base group.

- **Pictures in a description, and a link to the full page.** A picture dropped or pasted into a description is
  now shown in the text, on a line of its own, while you read and while you write. The text still holds its name
  (📎steps.png), so moving that line moves the picture; named inside a sentence, a picture stays a small link. The
  full page a description opens into (**Expand**) has an address of its own and a **Copy link** button: the link
  opens the card with its description full page, to read.

  The guides have a new group, **A knowledge base**: how to keep a team's handbook on an ordinary board (articles
  as cards, pages inside pages as subtasks, lists for an article's life), with a set-up, three sample boards and
  seven article outlines to copy. No database change.

- **Change several cards at once.** In the Outline, point at a row and a box appears at its start. Tick a few
  rows (hold Shift for a run of them; the box in the Task heading ticks everything a search or a filter found).
  On the Board, hold ⌘ or Ctrl and click a card, or choose **Select** in its **⋯** menu; after that a plain click
  ticks the next card. A bar at the bottom of the view moves the ticked cards to a list, assigns them, adds or
  removes a label, sets a priority, dates or one of the board's own fields, archives or deletes them. Each is one change with one Undo,
  and a message says how many cards it changed. Adding a label keeps the labels a card already had. Ticking a card
  with subtasks ticks that card only; **Add their subtasks** takes what is under it too. On a phone, **Select**
  above the list shows the boxes.

  Someone given many cards at once is told once ("assigned “Homepage” and 11 more cards to you"), and so is
  anyone who follows more than three cards of one change.

  For apps: two new commands, `tasks.archive` and `tasks.delete`, put away or delete several cards as one
  change. No database change.

- **Group the Outline's rows.** **Display → Group by** gathers the rows under a heading for each list, person,
  priority or label, or for each value of one of the board's own fields (a choice, a person or a tick). Each task
  is under its own heading, with the tasks above it in grey to show where it belongs, so a step that is Ben's shows
  under Ben inside Ann's project; a task with two labels is under both. A heading says how many tasks are its own
  and what they add up to in the number columns, folds, and has a **+** that adds a task with its value. Sorting,
  filters and search work under the headings; rows aren't dragged while grouped. The grouping is saved with a
  preset. On a phone the headings are in the list. No database change.

- **Templates for cards and boards.** Start the next card, or the next board, from one you saved.

  A **card template** is a card with all its subtasks, for work that repeats with the same steps. Open a card,
  choose **⋯ → Save as template…**, and name it. On a board that has templates, **Add card** and **New task** get
  a small arrow that lists them: pick one and the card arrives in that list with its subtasks, as one change that
  one Undo takes back. A template keeps titles, descriptions, labels, priority, the board's own fields and which
  steps wait on which. It leaves out who a card was assigned to, dates, comments, files and logged time, so a card
  from a template starts with nobody assigned. Card templates belong to their board: everyone on it uses the same
  set, and the people who can edit save, rename and remove them (**Board settings → Templates**).

  A **board template** keeps a board's shape: its lists, labels, fields, rules and card templates, and never its
  cards or its people. A board's owners save one from the board's **⋯** menu. It goes where the board lives: a
  workspace's board gives the workspace a template for everyone in it, a Personal board gives you one of your
  own. Templates are listed under **Start with** when a board is made, after the starter boards.

  A template is a copy taken when it is saved. To change one, save over it (**Replace**). What was made from a
  template stays as it is when the template changes or goes.

  For assistants: `get_board` lists a board's card templates, and `create_tasks` takes `from_template`. For apps:
  see Templates in the API docs. The database gains two tables (migration 0045, which only adds).

- **Export a board as a spreadsheet, and a fuller whole-board file.** **⋯ → Export board…** now asks which kind of
  file. **A spreadsheet (.csv)** has one row for each card: its number, title, parent, list, assignee, priority,
  dates and labels, each of the board's own fields, the description, the time logged on it in hours, and when it
  was made, changed and done. It saves the cards your search and filter find (untick for all of them), and the
  archived cards too if you tick them. It opens correctly in Excel, Thai included, and a title that starts like a
  formula can't run as one. Its columns are named the way **Import cards…** reads them, so a sheet can be saved,
  changed and brought back.

  **The whole board (.json)** is the file there was, now with a tick **With comments and logged time**. Brought
  back with **Import a board…**, comments arrive in your name, each saying who wrote it, with their dates; logged
  time that was yours is yours, and other people's stays on its cards with their name in the note. Attached files,
  reactions and saved presets still stay behind. Anyone who can open a board can export it; visitors with the
  public link get it without comments and logged time.

  For apps: `GET /api/boards/<id>/extras` gives a board's comments and logged time, and `POST /api/boards/import`
  reads them from a file's `comments` and `time`.

- **Emoji reactions on comments.** Answer a comment with 👍 where another comment would only say "ok". Point at a
  comment and click the small smiley under it (always there on a phone), then pick one of six: 👍 agreed,
  ❤️ thanks, 🎉 well done, 😄 funny, 👀 I'm looking at it, ✅ done. Reactions sit under the comment as counts, yours
  tinted; click one to add yours or take it back, and point at one (press and hold on a phone) to see who. Everyone
  with the card open sees a reaction arrive. The comment's author gets one line under their bell for the comment,
  however many people react, and no email or desktop message: a reaction is quieter than a comment. Everyone who
  can comment can react, viewers too; visitors with the public link see reactions and can't add any.

  For assistants: `get_task` shows each comment's reactions and who added them. For apps: a comment has
  `reactions`, and `PUT /api/boards/<id>/comments/<comment id>/reactions` adds or takes back yours. The database
  gains one table (migration 0044, which only adds).

- **Tell people when a card arrives in a list, or leaves it.** A board's owners can have it tell people at the
  moment something happens: every new quote, an order ready to bake, an offer that was answered. In a list's "…"
  menu, **Tell people when a card arrives…** opens the rule about that list: tick people on the board, or
  **Whoever it is assigned to**, and it says the rule back in words ("When a card arrives in Quoted, tell Dana").
  A rule can be about arriving or leaving, can be given a name, and takes the same conditions as a limit under
  **Which cards**: several lists or none, who a card is assigned to, its priority, labels, a value of one of your
  own fields ("when a card arrives in On site where Trade is Roofing, tell Tom").

  A card arrives however it comes to be one of the rule's cards: moved in, made there, brought back from the
  archive or by Undo, arriving from another board or the Inbox, or changed so that it fits. It leaves when it
  stops being one, which includes being archived, deleted or moved to another board. The people named get a line
  under their bell with the card, what happened, who did it and the rule's name; several cards at once, or one
  person's moves within ten minutes, are one line. It is in the morning summary email too, and on the desktop and
  in Telegram for people who have those on for the cards they follow. Nobody is told about what they did
  themselves, and someone who also follows the card hears of the move once.

  Anyone a rule tells can switch it off for themselves, with **Stop telling me** under the bell or the switch
  behind the board's **Rules** button; the board's owners see who did. That button lists both kinds of rule above
  every view, and **Board settings → Rules** has them under two headings. A rule that
  names something that is gone tells nobody until it is changed, and says why. A board has up to 20 rules, limits
  included. Rules only tell: none moves or changes a card.

  For assistants: `get_board` lists a board's rules that tell people, in words. For apps: a rule of
  `kind: "when"` in the board's `rules`, a notification of `kind: "rule"`, and
  `PUT /api/boards/<id>/rules/<rule id>/mute`. The database gains two columns and a table (migration 0043, which
  only adds).

- **Limits: how much a list may hold.** A board's owners can give a list a limit from its "…" menu (**Limit…**):
  at most so many cards, or so much of a number field (hours of Estimate, money in open offers), for the whole
  list or for each person by what is assigned to them. The list's header shows where it stands, such as `4 / 3`:
  quiet while there is room, amber when full, red when over. Nothing is refused: a card can always be added, and
  the list says it is over. Everyone on the board sees the same number, whatever they filter or hide; with a
  filter on, the header says both what you see and what the limit counts. Where cards have subtasks, a limit
  counts what the board's lists show (the cards without subtasks, or the top-level cards), and that can be chosen.

  A limit can be about more than one list's cards. Under **Which cards** in the editor, tick the lists it is
  about (none: the whole board) and anything else its cards must be, with the Filter menu's own controls: who they
  are assigned to, their priority, their labels, a value of one of your own fields. So "at most 1 card in On site
  where Trade is Roofing", or "at most 4 cards for each person in Scheduled, On site or Snagging". A limit can be
  given a **name** ("Roofing crew"). A plain count sits beside the list's name; a limit that needs words with its
  numbers sits on a line under the header ("Crew hours 166 / 160 h"). A **Rules** button above every view says
  how many limits are over and lists them all, which is where a limit that isn't about one list shows; **Board
  settings → Rules** has the same list, and is where owners make, change and remove them.

  A limit is the first of a board's **rules**, kept with the board and worked out from it as it is, so nothing
  can fall out of step. One that names a list, a label, a person or a field that is gone is not worked out with
  what is left of it, and says so. Limits follow their fields when two are merged or the board moves to another
  workspace, and come along in a board's file.

  For assistants: `get_board` lists a board's limits in words, with what there is now and the room left under
  each. For apps: a board has `rules`; its owners change them with `POST`, `PATCH` and
  `DELETE /api/boards/<id>/rules`.

- **Card covers.** A card can show one of its pictures across its top on the Board: a product in a shop's orders,
  a design draft, a bug's screenshot. Open the card, point at a picture in **Files** and click **Use as cover**;
  the picture is marked "Cover" and its button becomes **Remove cover**. Every cover has the same shape on the
  Board, and a picture that is taller or wider is cut from the middle. Everyone who can open the board sees covers,
  visitors with its public link too. **Display → Covers** hides them for you on that board. Removing the file
  removes the cover (Undo brings both back), a card moved to another board keeps its cover, and the card's History
  says who set and removed it.

  The Board never loads the full picture: your browser makes a small copy when you choose a cover, and that is
  what is drawn and what browsers keep. Small copies use none of your file space. The Files list of a card draws
  them too, where a picture has one.

  For apps: a task has `cover`, a file's id; `GET /api/attachments/<file id>/thumb` is the small copy;
  `PUT /api/boards/<id>/attachments/<file id>/thumb` takes one (the server does not make them), and `PUT` or
  `DELETE /api/boards/<id>/tasks/<task id>/cover` sets or removes a cover. Assistants are told which of a card's
  files is its cover; they cannot set one yet.

- **Cards have names, like WEB-12.** Every card now has a short name: a few letters for its board and a number.
  The first card on a board is 1, the next is 2, subtasks too. A card keeps its number however it is renamed or
  moved between lists, and no number is given twice. Say it in a call, in a message, or to an assistant ("move
  WEB-12 to Done"). It is at the top of the open card, where a click copies a link to the card. On the board,
  **Display → Card numbers** shows it on every card; in the Outline, switch on the **Number** column, which also
  sorts. The board's search box finds a card by `web-12` or just `12`, and **Search cards** by `WEB-12` (with the
  cards that mention it). A card you have just added shows its name a moment later, once it is saved.

  A board's letters are made from its name (Website launch is WEB). Its owners can change them in **Board
  settings → General → Letters for card numbers**: every card is renamed at once, and a number written with the
  old letters still finds its card. No two boards in a workspace, or of your own, have the same letters; a board
  moved to where its letters are taken gets new ones. Your Inbox is always IN. A card moved to another board is
  numbered again there.

  **Mention a card in a description or a comment** by its name: type `WEB-12`, or type `/`, choose **Card** and
  pick it from a list (this board's cards at once, your other boards' as you type). Once saved, the name is a
  link that opens the card: in place on the same board, or on its own board. Only names with the letters of a
  board you can open become links, and not inside code or inside another link. A card that was moved to another
  board is still found: its old name, and old links to it, open it where it is now and say where that is, for
  everyone who can open that board.

  **The "/" menu** is now in two parts, **Mention** (Card) and **Put in** (headings, lists, a table and the rest),
  and it works in comments too, with a shorter list. Typing after the "/" puts what starts with those letters
  first. Menus that would run off the bottom of a card's window, such as "@" and "/" in the comment box, now open
  above the cursor.

  Cards and boards you already have are given their names the first time the server starts after the upgrade:
  cards in the order they were made, and where many were made in one go (an example board, a starter, an import)
  in the order the Outline shows them. This needs nothing from you; the server's log says how many it did.

  For assistants: every task comes with its `ref`, and a ref (`WEB-12`, or `12` on that board) is taken wherever a
  tool takes a task id; `find_tasks` finds by it; boards say their `code`. For apps: a task has `number` and a
  board `code` (and `pastCodes`); the number is in the answer to the command that made the task, never in the
  command; `PUT /api/boards/<id>/code` changes a board's letters; `/api/cards` rows have `ref`, and adding a card
  in one call answers with it. An exported board carries its numbers and letters, and gets them back when it is
  imported (other letters when its own are taken). A board's address takes `?n=12`, a card's number there;
  `GET /api/boards/<id>/whereis?n=12` (or `?task=<id>`) says where a card is now, across moves;
  `/api/cards?in=titles` makes `q` look at names and titles only.

- **Fixed: a card could be made with the id of an archived card,** through the API, which replaced that archived
  card. It is refused now, as it already was for a card on the board.

- **A card's history.** Beside a card's comments there is now a **History** tab: what happened to the card, newest
  first, with who did it, when, and through which app when it wasn't the website ("through Claude"). It says what a
  move was from and to ("moved it from To Do to Doing"), names the labels put on or taken off, and writes dates in
  your own time. Changes one person makes within a few minutes are shown together. It follows the card as it
  changes, and **Show earlier** brings older changes. It reads the board's activity, so it goes back 180 days;
  changes logged before this version name the card in each line. Everyone on the board can read it; visitors with
  the public link see the comments only. For apps: `GET /api/boards/<id>/tasks/<taskId>/activity`, and each line of
  the board's activity now also carries `own`, the same line in the card's own words.
- **Files and logged time are in the activity.** Until now the board's activity said when a file was attached, and
  nothing else about files or time. It now also says when a file is removed or brought back with Undo, and when time
  is logged ("logged 1h 30m", with the day when it is for another day), changed or removed; when an owner fixes
  someone else's entry, it says whose. They show in a card's History, and assistants see them in the board's recent
  activity. Typing in your time doesn't count as working on the card just then: My week's and the log box's "cards
  you touched" go by the day the time is for, as before.
- **The app says which version it is.** The foot of the account menu says, like "Kanbanto 0.1.0 · 7 Oct": the
  release, and the day this copy was built (a copy built from `main` between two releases says the last release's
  number, so the day tells it apart). Platform console → Overview says it too, the server's log when it starts, and
  `node dist/cli.js version`. Only people who are signed in are told (`version` in `/api/auth/me`); `/api/health`
  is unchanged. The bug report form asks for that line.

- **A new card window.** An open card is now two columns: the card itself, wide, on the left, and its comments on the
  right. What used to be a middle column of one-line fields is a row of six boxes under the title: **Status**,
  **Assignee**, **Priority**, **Dates**, **Labels** and **Time logged**. Each says what the card has, in grey when
  it has nothing, and is the button that changes it. **Dates** opens Start, Due, Reminders and Timeline color, says
  how long is left ("8 days left", "3 days late"), and shows a small alarm clock when a reminder is set. At the top
  are the board's name and the cards this one sits inside, **Set parent** (or **Change parent**), **Follow**, and a
  **⋯** menu with Focus on its subtasks, Move to another board, Complete and archive, Archive and Delete task. The
  window's ✕ sits in that row. On the left, Subtasks now come before Files, and a board's own fields are up to four
  boxes across. The top stays in place while the card scrolls. Below a wide screen it is one column with the
  comments last; on a phone the boxes are two a row, with Dates and Labels on rows of their own. People who can only
  view see the same boxes and can't change them, though Dates still opens to read the reminders.

- **Profile pictures:** Account settings → Profile has a **Picture** card: choose a picture, see it in the circle,
  save it. It then shows in place of your initials wherever you appear: on cards, in comments, in the lists of people
  on a board and in a workspace, in filters, the plan, search and the account button. The picture is cut to a square
  from its middle and shrunk in your browser before it is sent (a JPG, PNG or WebP of any size will do). Remove it
  to go back to your initials. People who have a board open see the new picture at once, and visitors of a board's
  public link see it too. For apps: a person now comes with `picture` beside their name (a path on the site, or
  nothing when they have none) in `/api/auth/me`, a board's `members`, comment authors and the other lists of
  people; pictures are set on the website, not with an API token.
- **A new name shows at once** on boards other people have open. Before, it could stay the old one there until
  something else on the board changed.
- **Telegram: a bot speaks for the board it is on, and only that one.** Two things reached past it. `/today` listed
  what was yours on every board you can open: it now lists the bot's own board. And your own news (reminders,
  mentions, the cards you follow) came through a bot on another board, or on your Inbox, when the card's board had
  none: now it comes only through a bot of yours on the card's own board, and a board where you have none sends
  nothing to Telegram. The bell, emails and desktop notifications are unchanged. To hear from several boards in
  Telegram, add a bot to each. Account settings → Notifications → Telegram says which boards your bots cover.
- **Timeline calendar: the day names stay in place.** Scrolling down a long month or two weeks, the row of Mon to
  Sun stays at the top of the calendar, so a column still says which day it is.
- **Fixed: a reminder gave the due time in UTC.** A reminder set for an exact moment ("tomorrow 9:00") said when
  the card was due as "Wed 7 Oct, 11:00 UTC", on Telegram, in the email and in the desktop notification. It now says
  it by the clock of the person being reminded, from the time zone in their Account settings ("Wed 7 Oct, 18:00"),
  and only an account with no time zone is still told in UTC.
- **Fixed: Undo couldn't be clicked while a card was open.** Removing a file or a time entry in a card shows
  "Removed… Undo" at the foot of the screen, but the open window took the click. Undo works there now, and leaves
  the card open.
- **Fixed: "Move to another board" with a long card title or board name.** The title ran off the window's edge and
  took the list of boards and the buttons with it, and the list sat over what was under it. Long names are cut short
  with "…" again, in the title, the list and the Move button.

## 0.1.0 — first public release (2026-10-07)

- **Boards of tasks inside tasks**, as deep as you like, shown as a **Board** (lists you name), a **Timeline** and an
  **Outline** (a table you can sort, filter and rearrange). Undo and redo, filters, search, zooming into a task.
  Lists can group subtasks under their parent; drag groups and cards into any order. A board whose statuses are set
  by hand opens with one card per task, its subtasks on its card.
  An open card lists what every card has one line each, the most used first, with dates and the rest in groups you
  can fold away.
- **Your Inbox, beside every board:** a board of your own for notes and cards that have no board yet, which only you
  can see. The tray in the top bar (or the I key) opens it as a panel at the left of any board and of your
  boards page, with how many cards wait in it. It shows its lists as a stack of sections that fold: add a card, drag
  it to another section to change its list, tick small things off without ever putting them on a board. Drag a card
  out onto a list of the open board and it lands where you drop it (on the Timeline or the Outline, anywhere on the
  view); a card's menu does the same without dragging, which is the way on a phone, where the Inbox opens over the
  board. It is a real board: open it as one to change its lists. It can't be shared, moved to a workspace, archived
  or deleted. Everyone has one, made the first time the app opens; tasks an assistant adds without naming a board go
  there. For those who had chosen a board as their Inbox (Board settings → "Use as my Inbox", now gone): if nobody
  else could open that board, it is their Inbox now, with its cards; otherwise it stays an ordinary board and their
  Inbox starts empty. For apps: `GET /api/inbox`, a place in the list for a card moved to another board (`order`),
  `inbox` on a board in `GET /api/boards`; `user.inboxBoardId` and the `set_inbox` tool are gone.
- **A quieter top bar on a board:** search, Share and More are small icons that say what they are when pointed at
  (search opens into its box when clicked, or with the / key; Share says how many people are on the board), "New
  task" is the one button with a word, and a thin line sets the board's own buttons apart from what is yours on
  every page: your Inbox, the bell and your account. On a phone, Share is the first thing under More.
- **Dates with or without a time:** start and due are whole days by default; add a time (24-hour) when it matters.
  Everyone sees it in their own time zone, and dates read day first ("Mon 12 Oct · 14:30").
- **Works on phones and tablets:** press and hold a card, list or row to drag it. Each card's menu can also move it to
  another list, or to the top or bottom of its own. It installs as an app too (the browser's "Install" or "Add to Home
  screen"): its own icon and window. It still needs a connection, and a site served over HTTPS.
- **Sharing:** workspaces for teams (everyone in one can open its boards, without being invited to each), or boards
  shared one by one; owners, editors and viewers; share links, access codes and invites by email; a public link anyone
  can view. Changes appear for everyone live.
- **Comments** with @mentions, a notification bell and a daily email summary; **attachments** on cards and in comments.
  A description can @mention people too: they're told once, when their name is first written there.
- **Custom fields:** add your own fields to cards: text (or a link, an email, a phone number), a number with a unit,
  a date, a choice from a list of options, or a checkbox. A field is defined once in a library, a workspace's
  (its admins) or your own for Personal boards, and each board's owners pick the ones it uses, their order, and up to
  three that show on the card front. On an open card they are its first section, a box for each. Taking a field off
  a board, or archiving it, keeps its values; deleting an
  archived field for good removes them. Values go along when a card or a board moves, where the other side has a
  field for them, and with an exported board. In the Outline each field is a column: sort by it, change values in
  place, hide the ones you don't need, and drag a column's name sideways to put the columns in your own order
  (Alt+Shift and an arrow key does it without a mouse; a saved preset keeps the order). Filter by a field in every
  view (saved presets keep it), and in Search cards across boards, with a test that fits its kind: text that contains
  a word, doesn't, is exactly or isn't; a number that is, is at least, at most or between; a date that is today, this
  week, next month, in the next or last so many days, or between two days; any of a choice's options or none of
  them; a linked card found by typing its title; a person, or "Me", which is whoever is looking, so one saved "Mine"
  works for everyone. Due and Start take the same date tests, Assignee has "Me", and a board's search box looks in
  its text fields too. For apps: `due`, `fv` and `timeZone` on `GET /api/cards`; assistants ask with the same tests
  (`find_tasks`). Numbers that add up are totalled: in the Outline's bottom row and for a task with its subtasks, and
  under each list on the Board for the fields its owners choose. A **Card link** field joins cards, on the same
  board or across the boards of a workspace: a deal points at a company, picked by title, and the company lists the
  deals that point at it, with their total; links follow a card that moves, and you only see the title of a card
  you can open. A **Person** field holds one or several people of the board (a reviewer, an account owner), to read,
  sort and filter by: nobody is told, which is what Assignee is for. Two fields that turned out to mean the same
  thing can be **merged**: it says first how many cards change, a card that has both keeps the one its board shows,
  and boards and saved filters follow. **Starter boards** (a sales pipeline, a support desk, store orders, bookings) come with their
  lists, fields, saved filters and a few example cards, each card linked to a client on a **Clients** board that
  comes with the first starter and is shared by the ones after: open a client and see every deal, request, order
  and booking that is for them. Assistants read, set and find by fields, by name, and can add and
  change them (`manage_fields`).
- **Following cards:** you're told about new comments and what happens to the cards you're part of (moved to another
  list, assigned, due date, description, archived or deleted): the ones you made, are assigned, commented on or were
  mentioned on, which includes being told when a card is given to you. Follow or unfollow any card from its side
  column, or unfollow from the bell. Several changes in a row are one line, and never your own. Search cards has a
  **Following** search for them, and assistants can follow a task for you (`follow_task`).
- **Files for assistants and the API:** an assistant can put a file on a card: one it writes (a report, notes, a
  CSV), one fetched from a public web address, or, when it works on a computer, a local file sent to a one-time
  upload link (`attach_file`, `upload_link`); on the card itself, or posted in a comment. It sees a card's files
  and can read text files and look at pictures (`read_file`). Uploading with an API token, files in comments and
  pointing at a file in text (`📎name`) are documented, and `comment.added` webhooks list a comment's files. A
  second file with a name the card already has is numbered (`report (2).pdf`), so a mark always means one file;
  attaching a file to a card is a line in the board's activity. `FILES_FROM_URL=off` stops the server fetching
  files from web addresses.
- **File storage on MinIO**, tried against a real one (the docs have the steps): a wrong Region now says which
  region the storage is set to. Fixed: a bucket saved a second time under another address (its address changed) lost
  its files when they were moved "from the earlier bucket"; Kanbanto now recognises that both are one bucket and
  only notes the new address.
- **Integrations:** personal API tokens (once a platform admin turns them on), webhooks per board with signed
  deliveries and retries, an MCP endpoint for AI assistants, a Skill for Claude Code, and an API reference at
  `/api/docs` on every site. Claude on the web and in Claude Desktop (and ChatGPT) can connect by signing in (OAuth),
  when a platform admin allows it. For assistants: a 180-day activity log of who changed what (and through which app),
  a team overview, searches by priority, label and time, and your Inbox for quick capture.
- **Cards in your calendar:** connect Google Calendar (Account settings → Calendar) and your cards' due dates and
  reminders appear in a calendar of Kanbanto's own there, updated within seconds; or make a private calendar link
  for Apple Calendar, Outlook and others. Your cards are the ones assigned to you, plus nobody's cards on boards
  only you are on; you choose which boards are in it. Platform admins turn each on in the console (Google Calendar
  needs a Google app, see [Calendar](docs/calendar.md)).
- **Sign in with Google:** "Continue with Google" on the sign-in and sign-up pages, once a platform admin turns it on
  (Platform console → Integrations; it uses the Google app made for Google Calendar, with a second redirect address).
  Someone new gets an account at once, with their name from Google and no confirmation email, since Google has
  checked the address. Someone whose address already has an account gets that same account, and their password keeps
  working (for Gmail and Google Workspace addresses; an account that never confirmed its address is confirmed by it
  and loses its old password). An account made this way has no password until one is added in Account settings →
  Password. Closed sign-up still needs an invite. Sign-up can also be **Google only**: Platform console → Accounts →
  "Who can create an account" has three choices now, anyone, anyone but only with Google, or nobody without an
  invite. With Google only, the sign-up page shows just the Google button, someone with an invite can still use an
  email address and a password, and people who have a password sign in as before. See
  [Signing in with Google](docs/self-hosting.md#signing-in-with-google).
- **Your site's own pages:** a `pages` folder (an about page, a privacy policy, terms) is served next to the app,
  with links to them under the sign-in form. See [Your own pages](docs/configuration.md#your-own-pages).
- **Priorities** (urgent, high, medium, low) on tasks: shown on cards, and in the Outline, filters and sorting. Boards
  can say **what they're for**.
- **Move a task to another board**, with its subtasks, comments and files (from its menu, or the card's panel). You see
  what fits before it moves: lists and labels are matched by name, and people who aren't on that board are named.
- **Descriptions and comments are formatted:** headings, bold, lists, checklists you can tick, code, quotes, tables
  and links, written in a light editor (Markdown shortcuts or a small toolbar) and saved as Markdown. Long text folds
  with "Show more", and a description can be read full page with its headings to jump to. Files and mentions work as
  before.
- **Writing a description, without losing your place or your words:** what you type is kept as a draft in the
  browser and offered back after a reload or a closed tab, with a "Saved" / "Not saved yet" sign; it's saved when
  you finish (clicking away, Esc, ⌘Enter) or with ⌘S. Esc leaves the editor instead of closing the card. Click a word
  to edit and the cursor is on that word. The toolbar stays in view, with numbered lists and quotes; "/" opens a menu
  of headings, lists, a table, a divider and a code block (inside a table: its rows and columns); pasted Markdown
  comes in formatted. In the card the editor stops at half the window and scrolls. **Expand** is now a place to
  write: it opens ready to type from an empty description or straight from the card's editor (same text, same
  cursor), looks like the page you'll read, keeps Contents beside you as headings appear, and counts your words.
- **Reminders** on cards: at a time you type in plain words ("tmr 10:00", "fri 2pm") or pick, or before the due date
  (following it: when it's due, or from 15 minutes to 5 days before). They go to whoever is assigned, under the bell and by email (which can be turned off), and to
  webhooks as `reminder.due`. Assistants can set and list them.
- **Desktop notifications** (Web Push, no app to install), turned on per computer in Account → Notifications:
  reminders, @mentions and news from the cards you follow pop up even when Kanbanto isn't open; clicking one opens
  the card.
- **Morning summary email** around 8:00 in your own time zone (set from your browser, changeable): cards due today and
  overdue, reminders later today, and mentions and news from the cards you follow that you haven't seen. Only when there's something; it replaces the daily
  mention email.
- **Times in plain words** when adding or renaming a card ("buy cat next monday 1pm" becomes "buy cat", due then, with
  a reminder if you like) and in the Due and Start pickers.
- **Webhooks** live in Board settings: each can send only some events (card changes, comments, reminders), and has a
  delivery log showing what was sent and what came back, with "Send again".
- **The Timeline as a calendar:** the Timeline tab has a switch, Bars or Calendar, and each board remembers which
  it last showed. The calendar is for boards whose cards happen on a day (bookings, deliveries, posts) more than
  they last days: each day lists the cards on it, a card on the day it is due with its time, one with a start and a
  due date stretching across its days. A month, two weeks, a week or a day at a time; days and weeks list cards in
  time order (no hour-by-hour grid). Click + on a day to add a card there (a time in the title, "Call Sam 3pm",
  becomes its time; nobody is assigned), drag a card to another day to change its date, click a day's number to see
  that day alone. A Subtasks switch (off to start) also shows subtasks that have a date of their own, each saying
  what it is under. A card shows its title in full, its priority, how many of its subtasks are done and who it is
  assigned to, and a row of days grows to fit its cards. Search, filters and "Hide done" apply. On a phone
  a month is dots with the picked day's cards under it, and weeks are a list day by day.
- **A tidier bar under the tabs:** it is the same in every view now, Presets, Filter and Display (and Log time).
  What belongs to one view sits in that view: the Timeline has a row of its own (Bars or Calendar, Today, and how
  much time to show), and Expand all and Collapse all are small buttons in the "Task" heading of the Outline and of
  the Timeline's bars. The Timeline has a Display menu like the others, with "Hide done tasks" (it was a button
  there, and a switch in the Outline's Display) and, for the calendar, Subtasks. On a board shown in rows, "Expand
  all rows" and "Collapse all rows" are in Display, beside the choice of rows.
- **Sort by when cards were created or last updated:** a list on the Board can be ordered by Created or Updated
  (the list's ⋯ → Order cards by), beside priority, due date and title, and "Reverse the order" turns any order
  round (oldest first, least important first, Z to A). The Outline has two more columns, Created and Updated, off
  until switched on in Display, and sorts by them like any column; on a phone, where the Outline has no headings to
  click, Display has "Sort by". "Updated" is the last real change to a card (its title, list, dates, description and
  so on): dragging it to another place doesn't count, and the line at the foot of an open card now says the same
  date. Fixed on the way: on a phone, a submenu (a list's "Order cards by" and "Color", a board's background and
  "Move to") opened half off the screen with its words cut off; it now stays on the screen. And choosing a list's
  order, folding or hiding a list no longer rebuilds the whole board, which sent a wide board back to its left end.
- **Assistants change several tasks in one go:** a new tool, `update_tasks`, makes the same change to many tasks
  of a board (their list, assignee, priority, dates, labels to add or take off, the board's own fields), and with
  `with_subtasks` to everything under them, so a task moves to another list together with its subtasks. It is one
  change: one line in the activity, one message to webhooks, one undo. A wrong id or name changes nothing. For apps,
  the command behind it is `tasks.update`.
- **Bring your work in:** a board from Trello, and cards from a spreadsheet. "Import a board…" on the boards page
  now takes the file Trello's "Export as JSON" gives: lists in their order, cards with their dates and labels,
  checklists as subtasks, comments with the dates they were written (in your name, each saying who wrote it), custom
  fields as fields of yours, archived cards as archived cards. Before anything is made, a screen says what will come
  over, lets you say what each list counts as (read from its name where it says, in English or Thai), and names
  what stays behind: people, uploaded files (each card links to its own in Trello) and comments older than what
  Trello exports. On a board, ⋯ → "Import cards…" turns rows pasted from Excel or Google Sheets, or a .csv file, into
  cards: say what each column is (guessed from its name: title, description, list, dates, labels, assignee,
  priority, parent card, or one of the board's fields), read the check (how many cards, which lists and labels are
  new, which rows are left out, which cells couldn't be read), then add them as one change with one undo. Dates are
  read as people type them, Thai months and Buddhist-era years included, and a column that could be day first or
  month first is settled from its own values or asked about once. Each assignee is told once. For scripts:
  `POST /api/boards/<id>/tasks/import` (with `dryRun` for the check), and a new command, `tasks.import`.
- **Add from anywhere:** put something in your Inbox without opening Kanbanto first. A button for your browser's
  bookmarks bar (Account settings → Add from anywhere) opens a small window with the page's title, its address and
  the words you had selected; press Add, and it closes. On Android, Kanbanto installed from Chrome is in the list of
  apps things are shared to. The window can also send the card to a board. Nothing is saved until you press Add,
  and the button holds no password. For scripts and automation tools (n8n, Zapier, Make, a shortcut): one call adds
  a card with plain names, `POST /api/inbox/cards` or `POST /api/boards/<id>/cards`, where a due date can be a day,
  a moment or words ("tomorrow 3pm"). Fixed on the way: an assistant's `update_task` with `due: null` or
  `start: null` now takes the date off, as its description says (it used to leave it).
- **A Telegram bot for a board:** a board's owner makes a bot at @BotFather and adds it in Board settings →
  People & apps (the Telegram box), then connects one chat by sending the bot a code. That chat gets the board's news as sentences,
  and what is sent there becomes cards: every message in your own chat with the bot, `/card …` in a group, or
  `/card` in reply to someone's message. The first line is the title, a time in it ("tomorrow 3pm") is the due
  date by your clock, photos and files are attached. The bot answers with what it understood and two buttons, Undo
  and No date; editing your message changes the card, and a reply to the bot's answer is a comment. The bot's menu has
  `/list` (the cards waiting in the list), `/board` (a link to the board) and, in your own chat with a bot,
  `/today` (what is overdue, due today and tomorrow, and your reminders in the next 24 hours). A bot connected to your
  own chat also tells you your reminders and mentions, from every board (Account settings → Notifications →
  Telegram); on your Inbox, what you send it lands in your Inbox. One bot serves one board; only the connected chat counts; the token is
  kept encrypted. A platform admin allows bots or not (Platform console → Integrations, off to start). The site
  needs no address Telegram can reach. Times in plain words are now read by the server too, in a person's time
  zone.
- **Webhooks to a chat channel:** a webhook can be sent to a channel in Slack, Google Chat, Microsoft Teams or
  Discord. Choose the app when adding it ("Send to") and paste the address the chat app gives for the channel. The
  channel then gets each change as a sentence, "Ann moved “Deploy” to Done on Launch", with the card's title opening
  the card; comments come with how they start, reminders with who they're for. The same three switches decide what
  is sent, and the log shows each message. Putting cards in another order says nothing. Nothing people typed can
  mention anyone in the chat. The channel is sent a first message when the webhook is added, and the webhook is
  only saved if the chat app takes it; these webhooks have no signing secret. Remember that card titles, names and
  the start of comments are then readable by everyone in that channel. For apps: `format` when adding a webhook.
- **Outline** uses the full width, with columns you choose and compact (or comfortable) rows (Display), indent guides
  and lightly tinted projects; on phones it's a nested list with each task's details underneath.
- **Card age** (Display → Card age): a chip with the days since anything happened on a card (moved to another list,
  edited, commented on, or its subtasks), after 3 days; amber from a week, red from two. Filter → "No activity
  lately" for any number of days, and "Recently changed" for the opposite (the last 3 days, or the number you choose);
  `find_tasks` takes `idle_days` for assistants. Cards' footers are two tidy lines:
  what needs attention, then the counts and the assignee.
- **Complete and archive** (a card's menu): finishes it and its subtasks, then archives it. Every archived card keeps
  the list it was archived from and whether it was completed, whatever happens to the lists later. The Archived
  cards page filters Completed / Not completed and opens a card right there (the usual card, read-only, with
  Restore and Delete); assistants can archive as completed too.
- **Done cards out of the way:** Display → Done lists shows only cards done or touched lately (14 days, or the
  number you choose), with "12 older · Show". The Outline and Timeline can hide done tasks, with a line saying how
  many. Fixed: with done tasks hidden, Expand all, Collapse all and each row's arrow did nothing (they were switched off as they are while searching, when what is found shows unfolded); they work now, and while searching or filtering the two buttons are greyed out instead of doing nothing.
- **Archive older done cards:** a done list's menu (or "Archive…" beside its older cards) archives, in one go, the
  cards done more than a number of days ago, each with its subtasks. It says how many will go first, and Undo brings
  them back. A finished card under work that isn't finished stays. Assistants do the same with `archive_done_tasks`.
- **Big boards stay light:** archived cards are no longer downloaded with a board; the app fetches one when it's
  opened, and the ones Stats and Export need. In the API, `GET /api/boards/<id>/archived` gives a board's archived
  cards by date range (archived, done or made between two moments), and `find_tasks` finds them by when they got done
  or were archived, so "what did we finish in March?" still has an answer after the cards are put away.
- **"What was I working on in January to March?"** Assistants can ask for the tasks worked on in a stretch of time
  (`find_tasks` with `worked_after` and `worked_before`): made or changed then, where a change is an edit, a move, a
  comment, logged time, finishing or archiving. Each result says what happened. Changes older than the 180-day
  activity log are only known when they were a task's last one.
- **More board backgrounds:** 12 designs besides the 12 colors (sunset, ocean, aurora, forest, midnight, …), and a
  custom one: pick any hue and a light, medium or deep shade, and the gradient and text colors are made for you.
- **Favourite boards:** star a board on the boards page or from its name menu; favourites come first on both.
- **Presets** on each board: save the filters and Display options as a named preset ("Focus", "Review") that
  everyone on the board can pick. Editors save, update, rename and delete them.
- **Public links** say that visitors also see the board's comments and files (and how many files there are).
- **Archive** cards (with their subtasks) and boards instead of deleting them. Archived cards have their own page
  (board ⋯ → Archived cards, or from search) across all your boards, where they can be searched, opened read-only,
  restored where they were, or deleted for good; archived boards are read-only and kept under "Archived boards" on the
  boards page.
- Assistants can **set up boards**: create one, change its settings, lists and labels. Sharing and deleting stay in
  the app.
- **Email** through any SMTP server or Resend, with limits to stay within a free plan. **File storage** on the server's
  disk or in an S3-compatible bucket (Cloudflare R2, Amazon S3, MinIO); people can bring their own.
- **Security review** before the first public release, with fixes: undo and imported files can no longer store a card
  whose parent links go round in a loop, or a reminder whose time isn't one (either could stall the server or stop
  reminders for every board), and old-format files pass the same checks as exports; desktop-notification addresses
  must be public ones, and a browser stops getting notifications when it signs out, when the password changes or
  the account is turned off; the bell and the morning email show nothing from a board you can no longer open; API
  tokens can't change your profile or open live connections; logged time isn't sent to visitors with the public
  link; assistants can't comment on an archived board; an invite sent with the inviter's own email service no
  longer counts as proof of the address; a file restored from the trash needs room in the quota; reminder emails
  for someone else count against whoever set them; the storage settings refuse non-JSON bodies before reading them;
  a confirmation link asks for the account's password outside the browser that signed up; sign-up with an invite the
  address can't use answers the same whether or not it has an account; someone removed from a board can no longer
  move its files to their own storage; a plan project can only be linked to a board its planner can open, and plan
  undo can't add an outsider's account; the app-connection page approves exactly what it shows; a sign-in under way
  doesn't survive a password change; webhook replies are read only as far as they're kept, and one webhook's slow
  address no longer holds back the others; searching archived cards, undo and live updates stay quick on very large
  boards. A second pass added: a new webhook address must answer a one-time code before it's saved; the app sends a
  content-security policy and no-framing, no-sniff, referrer and HSTS headers; unused reset and confirmation links
  end when the password changes; turning an account off also removes its API tokens, connected apps and calendar
  link; simultaneous requests can't get past the wrong-password limit, the email limits, the file quota or the
  last-owner rule; a board made private stops showing its logged time in the workspace's plan; CI actions are pinned
  to exact commits; a warning at startup when the database still has the default password. A third
  pass: turning an account off also ends the share links, access codes and invites of the boards and workspaces that
  person runs, so they can't come back under another address; plans stay within their size limits through undo and
  splitting, plan dates are between 2000 and 2100, and an assistant's search text is capped; one webhook's backlog,
  one person's pile of mentions or one odd reminder can no longer hold up webhooks, morning emails or calendar sync
  for others; the image's base is named by its exact contents.
- **Guides** for the people using it, in [`guides/`](guides/): a page for each thing you'd want to do (your first
  board, cards, sharing, workspaces, assistants, time and planning, calendars), with pictures taken from the app by a
  script, built into a small website with VitePress. **Guides** in the account menu opens them (at kanbanto.com by
  default; `GUIDES_URL` points it at your own, or `off` takes it out).
- **Self-hosting:** one Docker Compose file, an optional HTTPS add-on, backups and restores, a Platform console for
  settings, and server commands for the rest. The encryption key for saved keys is made automatically.
