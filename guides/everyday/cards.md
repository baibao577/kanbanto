# Cards

A card is one piece of work. This page covers making cards, what is on one, and moving them around.

## Add a card

There are three ways:

- Click **Add a card** at the bottom of a list, type a title and press <kbd>Enter</kbd>. The box stays open for the
  next one.
- Press <kbd>N</kbd>, or click **New task** at the top. This makes a card and opens it, ready for its title.
- Inside an open card, click **Add a subtask** to make a card inside it (see [tasks inside tasks](/everyday/subtasks)).

![Typing a new card at the bottom of a list](/images/add-card.webp)

A date typed in the title is understood: "Send invoices next monday 1pm" becomes "Send invoices", due then. Before
you press <kbd>Enter</kbd>, Kanbanto shows the date it understood under the box, with **Remind** to add a reminder
at that time. The small **✕** on the line below the date means "that was not a date, keep it in the title". (The
other ✕, beside **Add card**, closes the box.)

## What is on a card

Click a card to open it.

![An open card](/images/card.webp)

**At the top**

- **Where it is.** The board's name, then the cards this one sits inside, if any. Click one to open it.
- **Its name,** at the end of that line, like **WEB-12**: the board's letters and the card's own number. Click it to
  copy a link to the card. See [A card's name](#a-card-s-name).
- **Set parent** (or **Change parent**). Puts the card inside another card, or takes it out again. A card with no
  parent is called a **project**.
- **Follow.** Be told about its comments and changes. See [notifications](/people/notifications).
- **⋯** has the rest: Focus on its subtasks, Move to another board, Save as template, Complete and archive, Archive
  and Delete task.
- **Title.** Click it to rename.

**The row of boxes under the title** is the same six on every card. Each says what the card has, in grey when it has
nothing, and is the button that changes it:

- **Status.** The list it is in. Changing it here is the same as dragging the card.
- **Assignee.** The person responsible, picked from the people on the board: everyone it is shared with, which on a
  workspace board includes the workspace's members. One per card.
- **Priority.** Urgent, High, Medium, Low, or none.
- **Dates.** Opens **Start**, **Due** and **Reminders** (see
  [due dates and reminders](/everyday/dates-and-reminders)) and **Timeline color**, the color of its bar in the
  Timeline view. The box says how long is left, and shows a small alarm clock when a reminder is set.
- **Labels.** Colored tags you make up, such as "design" or "bug". The first three show, then how many more.
- **Time logged.** Time logged on this card. Click it to log more.

**On the left**, the card itself:

- **Fields.** The board's [own fields](/everyday/fields), when it has any: a box for each, such as a client or an
  amount.
- **Description.** The full story, with headings, lists and checklists. See
  [writing a description](/everyday/descriptions).
- **Subtasks.** Smaller cards inside this one.
- **Files.** Anything attached to the card.
- **Waiting on.** Other cards that have to finish first. Until they are done, the card shows an amber **Waiting**
  sign on the board.

**On the right**, two tabs: [**Comments**](/everyday/comments-and-files) and [**History**](#a-card-s-history).

On a narrow screen there is one column, with the two tabs last and a **Comment** button at the top to jump to them.
The row of boxes wraps onto more rows.

## A card's history

Open a card and click **History**, beside **Comments**. It lists what happened to the card, newest first: who moved
it and from which list, who renamed it, assigned it, dated it or labelled it, who attached or removed a file, who
logged time on it, and when.

![A card's history](/images/history.webp){.medium}

- Several changes by one person within a few minutes are shown together, as one visit.
- A change made through an assistant or another app says so: "through Claude", "through API", "through Telegram".
- It follows the card as it changes, so a teammate's change appears while you look.
- **Show earlier** at the bottom brings older changes.

Good to know:

- History goes back **180 days**.
- What a card was before a change is only said when it moves to another list ("from To Do to Doing").
- A card moved here from another board starts with "moved it here from another board".
- Time logged for another day says which: "logged 30m for Mon 28 Sep". The entries themselves, with their notes, are
  in the card's **Time** section.
- Comments are under their own tab.
- Everyone on the board can read a card's history. Visitors with the board's public link see its comments only.

## A card's name

Every card has a short name, like **WEB-12**: a few letters for its board, and a number. The first card on a board
is 1, the next is 2, and so on; subtasks are numbered too. A card keeps its number however often it is renamed or
moved between lists, and a number is never given to another card, even after its card is deleted.

Use it to say which card you mean: in a call, in a message, or to an [assistant](/ai/connect) ("move WEB-12 to
Done").

- **See it** at the top of the open card. On the board, turn on **Display → Card numbers** to show it on every
  card; in the Outline, switch on the **Number** column.

  ![The top of an open card, with its name ringed](/images/number-1-card.webp)

  ![The board with every card's name above its title, and the Card numbers switch ringed](/images/number-2-board.webp)

- **Find a card by it:** type `web-12`, or just `12`, in the board's [search](/everyday/search-and-filters), or
  `WEB-12` in Search cards.
- **Copy a link to the card:** click the name at the top of the open card.

- **Mention it in a description or a comment:** type the name (`WEB-12`), or type `/`, choose **Card** and pick
  the card from the list. Either way the name becomes a link once the text is saved. See
  [descriptions](/everyday/descriptions#mention-a-card).

A card you have just added shows its name a moment later, once it is saved. A card moved to
[another board](#the-rest-of-the-card-s-menu) is numbered again there, with that board's letters. Its old name
and old links still open it, for everyone who can open the board it went to, and say where it is now.

The letters come from the board's name. Its owners can change them in
[Board settings](/views/board-settings#board-settings).

## What a card shows on the board

Without opening it, a card shows its [cover](/everyday/comments-and-files#use-a-picture-as-the-card-s-cover) if
it has one, its labels, its title, and a line of small signs:

| Sign | Means |
|---|---|
| Small bars, or a red "Urgent" | Its priority |
| A calendar and a date | When it is due. Red when it is overdue. |
| An alarm clock | It has a reminder |
| A speech bubble and a number | How many comments |
| A paperclip and a number | How many files |
| A stopwatch and a time | Time logged on it |
| "1/3" | How many of its subtasks are done |
| Initials or a picture in a circle | Who it is assigned to |

::: tip Start the next one from a template
A card you make again and again (a new client, a release, a weekly check) can be saved as a template, with its
steps: **⋯ → Save as template…**. See [templates](/everyday/templates).
:::

## Move a card

- **Drag it** to another list, or up and down within its list.
- **From its menu.** Point at a card and click the **⋯** that appears at its corner: **Move to** another list,
  **Move to top** or **Move to bottom**, or **Move to another board…**.

![A card's menu](/images/card-menu.webp)

Moving a card to another board takes its subtasks, comments and files with it. Before it moves you are shown what
will fit: lists and labels are matched by name, and people who are not on the other board are named.

No board for it yet? [Your Inbox](/everyday/inbox) is first in that list, and a card waiting there can be dragged
straight onto a list of the board you have open.

## The rest of the card's menu

- **Open.** The same as clicking the card.
- **Select.** Ticks the card, to change several at once. See
  [change several cards at once](/everyday/several-cards).
- **Focus on its subtasks.** Only on a card that has subtasks: shows just those on the board. See
  [tasks inside tasks](/everyday/subtasks).
- **Log time…** Records time you spent on it.
- **Complete and archive.** Finishes the card and its subtasks, then puts it away.
- **Archive.** Puts it away as it is. See [done cards and the archive](/everyday/done-and-archive).

## Good to know

- **Undo** anything with <kbd>⌘Z</kbd> (<kbd>Ctrl+Z</kbd> on Windows).
- **Who can change cards:** people who can edit the board. People who can only view it can read and comment.
- **Labels belong to the board.** Make and rename them from any card's Labels, or in Board settings.
- **Deleting removes a card**, with its subtasks. **Delete task** is under the **⋯** at the top of an open card. An **Undo**
  button appears for a few seconds; after that it is gone. If you might want it again, archive it instead.
- **Everyone sees changes at once.** If a teammate has the board open, your change appears on their screen.

## Next

- [Writing a description](/everyday/descriptions)
