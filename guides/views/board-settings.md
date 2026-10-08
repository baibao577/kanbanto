# Board settings, stats and export

Everything about the board itself is under the **⋯** at the top.

![The board's menu](/images/board-menu.webp){.small}

## Board settings

![Board settings](/images/board-settings.webp)

Changes are saved as you make them.

**General** (what everyone on the board sees)

- **Name.**
- **What's this board for?** A sentence or two. It shows on your boards page, and AI assistants read it to pick the
  right board when you say "add it to the launch board".
- **Letters for card numbers.** What the board's [card names](/everyday/cards#a-card-s-name) start with: WEB in
  WEB-12. They are made from the board's name; its **owners** can change them (2 to 5 letters or digits, starting
  with a letter). Every card is renamed at once, and a number written with the old letters still finds its card.
  Two boards in the same workspace, or two of your own, can't have the same letters. Your Inbox is always **IN**.

  ![Board settings, with the letters for card numbers ringed](/images/number-3-letters.webp)
- **When a task has subtasks, its status…**
  - **Follows its subtasks** (recommended): it is Done when all its subtasks are done, and In progress as soon as
    one of them starts.
  - **Is set by you:** it stays wherever you put it.

**Fields.** The board's own fields: which ones it uses, their order, which show on cards, and which are added up
under each list. See
[your own fields](/everyday/fields).

**Rules.** What the board says about its cards, the same to everyone on it. Its [limits](/views/limits): how much
a list, a person or the whole board may hold, each with where it stands. And its rules that
[tell people when a card arrives](/views/telling-rules) in a list or leaves it, each with who it tells. The board's
owners make, change and remove them here; anyone a rule tells can switch it off for themselves.

![Board settings, Rules: the board's limits, then its rules that tell people](/images/rules-settings.webp)

**Background.** One of 12 colors, 12 designs, or your own: pick any hue and a light, medium or deep shade.

**People & apps.** Who can work on this board (a shortcut to Share), and webhooks, which tell other apps when
something changes here. Webhooks are for whoever sets up integrations: see
[Webhooks: tell another app when a board changes](/more/webhooks).

**Just for you.** Light, dark, or the same as your computer: only what you see changes.

**Archive or delete** (owners only)

- **Archive** puts the board away. It leaves your boards page, becomes read-only for everyone and keeps everything.
  It is listed under "Archived boards" at the bottom of the boards page, and can be restored.
- **Delete** removes the board, its cards, comments and files for everyone. This cannot be undone.

## Board stats

**⋯ → Board stats** shows how the board is doing, over the last 7, 30 or 90 days.

![Board stats](/images/stats.webp)

- **Time to done:** how long a card usually takes from being made to being done, with the quickest and slowest.
- **Made** and **Done:** how many cards, compared with the period before.
- **Open now, In progress, Overdue, Due in 7 days.**
- **Made and done** each day, as a chart.
- **Done each day** over the last 20 weeks, as a calendar of squares.
- **Where open cards sit**, list by list.
- **Open the longest** and **Untouched the longest:** the cards most likely to need a nudge. Click one to open it.

Stats count cards without subtasks, and include archived ones.

## Move a board

Owners can move a board between **Personal** and a workspace with **⋯ → Move to**. Moving it into a workspace does
not share it by itself; use **Share** for that.

A board keeps its [letters](#board-settings) when it moves, unless a board where it is going already has them:
then it is given new ones from its name, and numbers written with the old letters still find its cards.

## Export and import

**⋯ → Export board…** saves the board as a file on your computer. Choose the kind:

![Export board: a spreadsheet, or the whole board](/images/export-1-choice.webp){.medium}

### A spreadsheet (.csv)

One row for each card, to open in Excel, Numbers or Google Sheets: a report of what was done and by whom, hours
for an invoice, anything you want to add up yourself.

- **The columns:** the card's number, title, parent, list, assignee, priority, start, due and labels; each of the
  board's [own fields](/everyday/fields); the description; the time logged on it, in hours; and when it was made,
  last changed and done.
- **Only the cards your search and filter find.** When a search or a filter is on, the sheet has the cards they
  find. Untick it to save every card on the board.
- **With the cards in the archive,** if you tick it. They come after the others, with the list each was in and when
  it was archived.
- Dates are written as `2026-10-15`, and times by your own clock. Thai and accented letters open correctly in Excel.
- A card title that starts like a formula (`=`, `+`, `-`, `@`) gets an apostrophe in front, so it can't run as one
  in your spreadsheet.

The columns are named the way **⋯ → Import cards…** reads them. So you can save a sheet, change it, and bring it
back; see [Bring your work in](/start/import). Importing adds cards: it does not change the ones that are there,
and it skips rows whose title is already a card unless you ask for them. It reads up to 2,000 rows at a time.

### The whole board (.json)

Everything on the board in one file, archived cards included. Keep it as a backup, move the board to another
Kanbanto site, or use it to copy the board. It is a file for Kanbanto to read back, not one to open in a
spreadsheet.

- Tick **With comments and logged time** to take those along too.
- To bring one back, open the **⋯** menu on the boards page and choose **Import a board…**. It arrives as a new
  board.

A few things to know about a board that comes back:

- Its people are not carried over: cards are unassigned, except yours.
- **Comments** come in your name, each saying who wrote it, with the dates they were written. Your own come back
  as they were.
- **Logged time** that was yours is yours again. Other people's hours stay on their cards and count in the cards'
  totals, with the person's name in the note; they are nobody's, so they don't show up in anyone's week.
- Attached files, reactions and saved presets stay behind.

The same **Import a board…** takes a board exported from **Trello**: see [Bring your work in](/start/import).

Anyone who can open a board can export it. Visitors with the board's public link get it without comments and
logged time.

## Favourites

Star a board on the boards page: point at its tile and click the star. Or, with the board open, click the board's
name at the top and choose **Add to favourites**. Favourites come first in both places.

## Next

- [Share a board](/people/sharing)
