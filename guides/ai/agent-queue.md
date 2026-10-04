# Let an agent work through a list

Some assistants can do the work itself, not only talk about it: write a draft, research a question, tidy a
spreadsheet. These are often called **agents**. Kanbanto gives an agent the same thing it gives you: a list of what
to do, in order, and a place to say what was done.

You stay in charge. You decide what goes in the list, and you decide when something is finished.

## What you need

- An assistant that is [connected to Kanbanto](/ai/connect) with **Read and make changes**.
- An assistant that can keep going through several steps on its own. Claude can, in an ordinary chat: it works for
  as long as that conversation runs. Nothing works in the background while you are away unless you use a tool made
  for that.

## Set up a queue

A queue is just a list. A common shape:

| List | Who moves cards here | Counts as |
|---|---|---|
| **For the agent** | You | Not started |
| **Doing** | The agent, when it starts one | In progress |
| **Your review** | The agent, when it thinks it is finished | In progress |
| **Done** | You, after checking | Done |

Add lists with **Add another list**, and set what each counts as from the list's **⋯** menu. "Your review" counting
as *in progress* keeps a card from looking finished before you have looked.

## Write cards an agent can act on

An agent only knows what the card says. A good card has:

- a **title** that is one clear piece of work,
- a **description** with what "finished" means, and anything it must not touch,
- links to anything it needs. An assistant cannot open files attached to a card, so paste the text it needs into the
  description, or give it the file in the chat.

Put the cards in the order you want them done. The order of a list is your priority.

## Tell the agent the rules, once

Paste a short instruction as your message in a chat with the assistant, for example:

> Work through the cards in "For the agent" on my Website launch board, from the top. For each one: move it to Doing,
> do the work, comment on the card with what you did and how you checked it, then move it to Your review. If you are
> blocked or unsure, say so in a comment and leave the card where it is. Never move a card to Done.

If your assistant has a place to keep instructions between chats, put it there and you can then just say "work
through my queue".

**Where the work itself ends up.** The assistant writes on cards: a comment, or the card's description. A draft, a
summary or a list of findings goes there. Anything it makes as a file (a document, a spreadsheet) stays in the chat
with the assistant; it tells you so in its comment, and you download it from the chat.

To stop it, use the stop button in the chat. Cards it already moved stay where they are; the one it was working on
is in **Doing**, with nothing lost.

## What you do

- Read the comment on each card in **Your review**.
- If it is right, drag the card to **Done**.
- If it is not, comment with what is missing and drag it back to **For the agent**.

Because everything is written on the cards, the next conversation with your agent starts where the last one ended.
It does not need to remember: the board does.

## Good to know

- **Break big cards down.** Ask the agent to split a large card into subtasks first, and review that plan before it
  starts.
- **Use "Waiting on".** If one card depends on another, open the card and pick the other one under **Waiting on**.
  Agents see that it is blocked.
- **Watch it live.** Cards move on your screen as the agent works.
- **It cannot delete or share.** A mistaken agent can move, edit or archive cards. Moved and archived cards are easy
  to put back. A description it rewrote is not: there is no history of earlier versions. Tell it to write its results
  as comments, as in the instruction above, and to leave descriptions alone unless you ask.
- **Read-only is an option.** If you only want answers, connect the assistant with **Only read**.

## Next

- [Log time](/time/log-time)
