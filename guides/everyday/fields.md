# Your own fields

Every card has a title, a list, dates and labels. Fields let you add what *your* work needs on top of that: a
client, an amount, a stage, a link, a yes or no.

![A card with a board's own fields filled in](/images/fields-3-card.webp){.medium}

A field is made once, then switched on for the boards that need it. So "Client" means the same thing on every board
that uses it.

## Make a field

For your own boards: open **your initials → Account settings → Fields**, and click **New field**.

For a workspace's boards: open the workspace, click the **Fields** tab, then **New field**. Only the workspace's
admins can do this.

![Your fields in Account settings](/images/fields-library.webp)

Give it a name and pick its kind:

![Making a field: a name, a kind, and for a choice its options](/images/fields-1-new.webp){.medium}

| Kind | Holds | For example |
|---|---|---|
| **Text** | A few words, or a link, an email address or a phone number you can click | Client, Website |
| **Number** | An amount, with a unit if you like | Amount in $, Hours |
| **Date** | A day, with a time if it matters | Close date |
| **Choice** | One of the options you list, each with a colour | Stage: Lead, Proposal sent, Won |
| **Checkbox** | Yes or no | Contract signed |
| **Card link** | One or several other cards | Company, picked from your Companies board |

A field's kind can't be changed afterwards, so pick the one that fits. Its name, and a choice's options, can be
changed whenever you like.

## Put it on a board

1. Open the board, then **⋯ → Board settings → Fields**.
2. Click **Add a field** and pick it.

![A board's fields in Board settings](/images/fields-2-board.webp)

Here the board's owners also:

- put the fields in order, with the arrows,
- switch **On cards** on for up to three of them, so their values show on the board,
- switch **Total in lists** on for up to three numbers that add up, so each list says what its cards come to,
- take a field off the board again, under **⋯**.

A board can use up to 20 fields. Every card on it gets them, subtasks too.

## Fill it in

Open a card. The board's fields are its first section, under the title: a box for each. Click one and type, pick,
or switch it on.

Fields switched **On cards** show on the board once a card has a value. A number with **Total in lists** on is
added up under each list's name:

![Cards showing a stage and an amount, and each list's total](/images/fields-4-front.webp)

Anyone who can edit the board can fill fields in. Viewers see them.

## Work on many cards at once: the Outline

In the [Outline](/views/outline), every field of the board is a column.

![The Outline with a column for each field, and a row of totals](/images/fields-5-outline.webp)

- **Change a value** right in the table: click the cell and type, pick, or tick. No need to open the card.
- **Sort** by a field: click its heading. Click again for the other way round. Cards without a value come last.
- **Hide** columns you don't need: **Display**, then untick them, or switch **Fields** off to hide them all.

## Filter by a field

Click **Filter**, go down to **Fields**, and pick the field.

![Filtering by a stage and an amount](/images/fields-6-filter.webp){.medium}

| Kind | You can ask for |
|---|---|
| **Choice** | Any of the options you tick, or **None picked** |
| **Checkbox** | **Yes** or **No** |
| **Number** | **From** an amount, **to** an amount, or both. Or **No number** |
| **Date** | In the **past**, in the **next 7 days**, or **No date** |
| **Text** | **Filled in** or **Empty** |

Filters work in all three views, and a [preset](/everyday/search-and-filters#presets-save-a-combination) remembers
them, along with the Outline's columns.

To look through **every board** at once, open [Search cards](/everyday/search-and-filters#search-cards-every-board-at-once),
then **More → Field**. Each card then shows its value, and you can narrow the list to the ones you want.

## Totals

A number field can be one that **adds up** (an amount, hours). Switch that on when you make the field.

- **In the Outline**, the bottom row adds up everything shown. A filter or a search changes it with the rows.
- **A task with subtasks** shows what they come to together, marked **Σ**. Its card says the same: "$12,000 with
  subtasks".
- **On the Board**, with **Total in lists** on (Board settings → Fields), each list says what its cards come to.

Each number is counted once, on the card it's written on. So write an amount on a task *or* on its subtasks, not on
both: the task's total would count it twice.

## Link cards together

A **Card link** field points at other cards. A deal points at its company; a ticket at the customer who sent it. It
is what lets separate boards work as one: keep companies on one board and deals on another, and join them.

![A deal linked to a company, and the picker that finds cards by title](/images/fields-7-link.webp){.medium}

When you make the field, say:

| Setting | What it means |
|---|---|
| **Its cards come from** | One board (Company picks from Companies), any board of the workspace (or any of your own boards), or **the board that uses this field** (cards of the same board: "Related to", "Duplicate of"). |
| **A card links to** | One card, or several. |
| **On the other card, call the list** | The name the linked card uses for the cards that point at it, such as "Deals". |

On a card, click **Add a card** in the field and type part of a title. Click the linked card's chip to open it. A
card on the same board opens as usual. A card on another board opens on top, to look at, with **Open on board** to go
and change it.

The linked card shows who points at it, under **Linked from**, with what their numbers add up to:

![A company card listing the deals linked to it, with their total](/images/fields-8-linked-from.webp){.medium}

What to expect:

- **You see a linked card's title only if you can open its board.** Otherwise it reads "A card you can't open". You
  can only link cards you can open.
- **Links stay inside one workspace**, or between your own boards. They never reach another workspace.
- **The linked card is archived:** the link stays, greyed.
- **It moves to another board** of the same workspace: the link follows it. Out of the workspace: the link is
  removed, and the move tells you first.
- **It is deleted:** the link reads "A deleted card", and goes the next time someone changes that field. Undo the
  delete and the link is back.
- **Its whole board is deleted:** the links to its cards are removed.
- In the Outline a link is a column like any other: sort by it, change it in the cell, and **Filter** by the cards
  linked.

## Stop using a field

There are three steps, each stronger than the last. The first two lose nothing.

| What you do | Where | What happens |
|---|---|---|
| **Take it off this board** | Board settings → Fields → ⋯ | It is hidden on this board. Its values are kept, and are back if you add the field again. |
| **Archive** | The Fields page | It is hidden on every board. Its values are kept, and **Restore** brings it back where it was. |
| **Delete** (archived fields only) | The Fields page, under Archived fields | The field is gone, with its values on every card. It tells you how many cards first. This can't be undone. |

To empty a field without removing it: **Board settings → Fields → ⋯ → Clear on all cards**. Anyone who can edit the
board can do this, and **Undo** appears right afterwards.

A choice's options work the same way. Archive an option and the cards that have it keep it, but nobody can pick it
any more. Delete an archived option and it is cleared from those cards.

## Good to know

- **Moving a card to another board** takes a value along when that board uses the same field (or one with the same
  name and kind). The move tells you which values won't come along before you confirm.
- **Moving a board** to a workspace, or back to your own boards, brings its fields with it. Fields the other side
  doesn't have are added there if you manage its fields; otherwise the move lists what would be lost and asks first.
- **An exported board** carries its fields. Importing it adds them to your own fields. Links between its own cards
  come along; links to cards on other boards don't.
- A name can be used once among your fields (or a workspace's), and can't be something every card already has, like
  Due or Status.
- There can be 50 fields in one place, plus archived ones.
- **A list's total counts its cards.** When subtasks are grouped under their parent on the Board, the parent is a
  heading, not a card, so a number written on it isn't in a list's total. The Outline counts it. To count it on the
  Board too, choose **Display → Show → Only projects**: each card then counts with its subtasks.
- Your assistant can read and fill in fields, and find cards by them: "Set the stage of Website redesign to Won",
  "Which cards are at the proposal stage?", "Link the Online shop deal to Hooli", "Which deals are Acme's?"

## Next

- [Search and filters](/everyday/search-and-filters)
- [Board settings, stats and export](/views/board-settings)
