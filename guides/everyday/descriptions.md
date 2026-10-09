# Writing a description

The description is where a card's detail goes: what it is for, the steps, the links. It can be a single line or a
whole page.

## Start writing

Open a card and click the description, or the **Add more detail…** box if it is empty. If you click a word in an
existing description, the cursor lands on that word.

![An empty description, with the box to click ringed](/images/desc-1-click.webp)

## Formatting

Use the toolbar, or type the characters shown here followed by a space. (On Windows, use <kbd>Ctrl</kbd> where this
says <kbd>⌘</kbd>.)

| To get | Toolbar | Or type |
|---|---|---|
| Bold, italic | **B**, *I* | <kbd>⌘B</kbd>, <kbd>⌘I</kbd> |
| A heading | H₂ | `##` |
| A list | Bullets | `-` |
| A numbered list | Numbers | `1.` |
| A checklist | Checkbox | `[ ]` |
| A quote | Quote marks | `>` |
| A link | Select the words, click the link button, paste the web address | |
| Text shown exactly as typed (for commands or code) | `</>` | `` ` `` |

**Type `/`** on a new line, or after a space, for a menu of everything else. It has two parts: **Mention**, with
**Card** (see [Mention a card](#mention-a-card)), and **Put in**: three sizes of heading, lists, a quote, a code
block, a **note** (see [Callouts](#callouts)), a **table** (see [Tables](#tables)) and a **divider**. Keep typing
to narrow it ("/tab"), and press <kbd>Enter</kbd> to choose.

![Writing a description, with the menu that "/" opens](/images/description-writing.webp)

**Paste** text written elsewhere and it keeps its shape. Text copied from an AI assistant, with its `##` headings
and `- [ ]` checklists, comes in formatted rather than as symbols.

**Type `#` and the start of a file's name** to point to one of the card's files, and pick it from the list. (A `#`
followed by a space makes a big heading instead, which is why the menu shows "#" beside "Big heading".) Drop or paste
a file into the text and it is attached to the card and mentioned where your cursor is.

## Callouts

A callout is a box that says what kind of thing is in it: a **Note**, a **Tip**, something **Important**, a
**Warning**, or a **Caution**. Use one for the line a reader must not miss.

![A description with a warning, a tip and a note, each in a box of its own colour](/images/desc-6-callouts.webp)

1. Type `/note` on a new line and press <kbd>Enter</kbd>. (Typing `/warning`, `/tip`, `/important` or `/caution`
   starts with that kind.)
2. Write in the box. Anything can go in it: several paragraphs, a list, a checklist.
3. To change its kind, click its icon and choose. **Plain text** in the same menu takes the box away and keeps the
   words.

Press <kbd>Enter</kbd> twice at the end to carry on under the box.

In the saved text a callout is a quote whose first line is its kind, like `> [!WARNING]`. That is how GitHub writes
them too, so an AI assistant that writes one, or a text pasted from there, shows as a box here.

## Tables

Type `/table` for a table of three columns. <kbd>Tab</kbd> goes to the next cell, and from the last one adds a row.
<kbd>Shift+Enter</kbd> starts a second line in a cell.

While the cursor is in a table, a small bar sits on it:

![A table being written, with its bar: add a row or a column, line a column up, delete](/images/desc-7-table.webp)

| Button | What it does |
|---|---|
| The first four | Add a row above or below, or a column to the left or the right, of where the cursor is. |
| The three in the middle | Line the column up left, centre or right. Numbers read best lined up right. |
| The bin | Delete this row, this column, or the whole table. |

- **Columns size themselves** to what is in them, and long text wraps. There is no dragging a column wider.
- **On the full page**, a table too wide for the column of text takes the width of the page. In a card it stays in
  the card and scrolls sideways when it must.
- **Paste cells from a spreadsheet** and they come in as a table, with their first row as its heading.
- A table always has a heading row. Delete it, and the next row becomes the heading.

## Code

Type `/code`, or three backticks and <kbd>Enter</kbd>, for a block that keeps text exactly as typed: a command, a
snippet, a piece of a file.

Say what language it is in and its words are coloured by kind. Type the language right after the backticks
(` ```ts ` and a space), or pick it from the small list at the block's top right while you write.

![A code block read, with its language named and a button to copy it](/images/desc-9-code.webp)

When the description is read, the block says its language, and a **copy** button appears as you point at it. It
copies the code exactly as written.

A block that doesn't say its language is shown plain. Nothing is guessed.

## Diagrams

A diagram can be written as text and is drawn for you. Make a code block, pick **Diagram (Mermaid)** from its list
of languages (or type ` ```mermaid `), and write the diagram:

```
flowchart LR
  A[Enquiry] --> B{Site visit?}
  B -- yes --> C[Quote sent]
  B -- no --> D[Estimate by phone]
  C --> E[Booked]
  D --> E
```

![The same text drawn as a flowchart](/images/desc-10-diagram.webp)

- While you write, the drawing is under the text and follows it as you type. A line that can't be read yet leaves
  the last drawing in place and says where it stopped.
- When the description is read, only the drawing shows. Point at it for a button that shows its text.
- It is Mermaid's way of writing diagrams: flowcharts, sequences, timelines, and more. An AI assistant writes it
  well: ask for "a flowchart of how a quote becomes a job, as Mermaid", and paste what it gives you.
- The text is what is saved, so the diagram can be edited by anyone who can edit the card, and GitHub draws the
  same picture from it.
- The part of Kanbanto that draws is fetched the first time you open a description with a diagram, so that first
  one takes a moment.

## Pictures in the text

Drop a picture into a description, or paste a screenshot, and it is **shown in the text**, on a line of its own.

![A description with a picture in it](/images/desc-4-picture.webp)

- What the text holds is the picture's name with a paperclip in front (📎steps.png). On a line by itself, that is
  the picture. Move the line and the picture moves.
- A picture named in the middle of a sentence stays a small link.
- To show a picture the card already has, type `#` and the start of its name on an empty line.
- Click a picture to open it at its full size.
- A file that isn't a picture is always a small link. Comments don't draw pictures in their text: a comment's
  files are listed under it.


## Mention a card

Write a card's [name](/everyday/cards#a-card-s-name) in a description or a comment and it becomes a link to that
card. There are two ways, and they give the same result:

- **Type it:** `WEB-12`. Capital letters, a hyphen, the number.
- **Pick it:** type `/`, choose **Card**, then find the card by its title or its number. The cards of this board
  show at once; cards on your other boards follow when you have typed two letters or more. Press
  <kbd>Enter</kbd>, or click one, and its name goes in where the `/` was. <kbd>Esc</kbd> closes the list and
  leaves you in the text.

  ![The menu that "/" opens, with Card ringed](/images/mention-1-menu.webp){.medium}

  ![The list of cards, found by typing part of a title](/images/mention-2-cards.webp){.medium}

Once saved, the name is a small link. Click it to open the card: a card on the same board opens in place, and a
card on another board takes you to that board. Hover over a card on the same board to read its title.

![A description with two cards' names as links](/images/mention-3-link.webp)

A few things to know:

- Only names with the letters of a board you can open become links. `UTF-8` or `COVID-19` stay as they are, unless
  a board of yours has those letters.
- A name inside `code`, or inside a link, is left alone.
- Someone who cannot open the other board sees the name as plain text.
- If the card is later moved to another board, the name still opens it there, and a message says where it went.
- If a board's letters are changed, names written with the old letters still open the right cards.

## Saving

A description saves as you write: a few seconds after you stop typing, and every so often while you keep going.
The small sign at the right of the toolbar says **Saving…**, then **Saved**.

![The toolbar, with the sign that says whether it is saved ringed](/images/desc-2-sign.webp)

You finish writing when you

- click anywhere outside the description,
- press <kbd>Esc</kbd>, or
- press <kbd>⌘Enter</kbd> (<kbd>Ctrl+Enter</kbd>).

<kbd>⌘S</kbd> saves at once and lets you keep writing.

If the page reloads, or the tab is closed, before your last words were saved, they are kept in your browser. The
card shows "You were writing here…" with **Continue writing** and **Discard**.

![A card offering unsaved writing back](/images/desc-3-draft.webp)

With no connection the sign says **Offline**. Keep writing: it is saved when you are back.

## Write with others

If someone else opens the same description to write, you are both in the same text. You see their cursor, with
their name, and their words as they type them. See [write together](/knowledge/together) for all of it.

While someone is writing, the card says so to everyone who has it open.

![A card saying who is writing its description at this moment](/images/desc-5-writing.webp)

## Earlier versions

Open the description full page (**Expand**) and click **Versions** to read the text as it was before, and to
bring a version back. See [versions](/knowledge/together#versions).

## Long descriptions

In the card, the writing area grows to about half the window and then scrolls, with the toolbar staying in view.

A long description is shown folded, with **Show more**.

Checklist items can be ticked straight from the card, without editing.

## Full page, for real writing

Click **Expand** above the description, or the arrows at the right of the toolbar while you are writing. The
description opens full page.

![A description being written full page, with its contents on the left](/images/description-full-page.webp)

- From an empty description, or from the middle of writing, it opens ready to type, with your text and cursor where
  they were.
- From a finished description it opens to read. Click **Edit** to write; the cursor starts at what you were reading.
- **Contents** on the left lists your headings and follows them as you add more. Click one to jump there.
- The top right shows the word count, who else is writing, and whether it is saved.
- <kbd>Esc</kbd> or **Done** finishes writing. <kbd>Esc</kbd> again closes the page.
- **Copy link** copies a link that opens the card with its description full page. The address in your browser says
  the same while the page is open. Send it when you want someone to read, not to land on the card.

### Fold a section away

Every heading has a small arrow in the margin beside it, while you read and while you write. Click it and
everything under that heading is put away, down to the next heading of the same size; the heading then says how
many words it holds. Click the arrow again to bring it back.

![A long description read full page, with one of its sections folded away](/images/desc-8-fold.webp)

- Folding is for you alone. Nothing changes in the text, and nobody else sees your folds, not even someone
  writing it with you. They are remembered for that card in the browser you are using, in the card as well as full
  page, read or written.
- A bigger heading folds the smaller headings under it too.
- What is folded is still found: a click in **Contents**, a comment on words in it, or, while you read, your
  browser's own search (<kbd>⌘F</kbd>) opens the section it is in.
- While you write, you never type into something you can't see: press <kbd>Enter</kbd> at the end of a folded
  heading, and its section opens with your new line in it.

### A link to a section

Point at a heading, full page, and a link button appears after it. It copies a link that opens the page at that
section. Use it to say "see Refunds, under Exceptions" with a link that lands there.

The link goes by what the heading says. Rename the heading, and an old link opens the page at its top.

A board whose cards are mostly long descriptions can be a handbook. See
[a knowledge base on a board](/knowledge/overview).

## Good to know

- Unsaved words that are offered back live in the browser you wrote them in. They do not follow you to another
  computer.
- People who have the description open to write see your words as you type. People who are only reading see them
  each time it is saved.
- Words typed into a card that someone archived or deleted a moment before are offered back the same way.
- After Kanbanto is updated, a page that was already open may say **Load the page again** when you start writing.
  It does so when the update changed what a description can hold: everyone writing a text has to be on the same
  version. Nothing is lost; reading still works.
- The `##` and `- [ ]` marks are called Markdown: a plain way of writing formatting that AI assistants read and
  write well. You never have to type them; the toolbar and the "/" menu do the same.

## Next

- [Tasks inside tasks](/everyday/subtasks)
