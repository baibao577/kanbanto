# Workspaces

A workspace is a home for a team's boards. People you add to the workspace can open the boards shared with it,
without being invited to each one. A board made in the workspace is shared with it from the start; a board's owner
can also keep one to fewer people (see "Boards in a workspace" below).

Your own boards live in **Personal**. A workspace sits beside it on the boards page.

![The boards page: Personal boards, then the Studio workspace's](/images/boards.webp)

## Make a workspace

1. On the boards page, click **New workspace**. It is at the bottom, under your boards.

   ![The boards page, with New workspace ringed](/images/ws-1-create.webp)

2. Give it a name, such as your team's or company's, and click **Create workspace**.

You become its admin, and its **People** page opens so you can invite your team.

## Find your way around a workspace

A workspace has three pages of its own, **People**, **Planning** and **Fields**, shown as tabs at the top (they are
in the picture further down). Fields is where the workspace's admins add fields for its boards: see
[Set up fields for the workspace](#set-up-fields-for-the-workspace). **← Boards** beside them takes you back to the
boards page, where the workspace's boards are.

To come back later: on the boards page, beside the workspace's name, click **2 people** (it shows the number) for the
People page, or **Planning** for the plan.

## Add people

On the **People** page:

![A workspace's People page](/images/workspace.webp)

- **By email:** type addresses and click **Invite**. People with an account are added right away; anyone else gets an
  invite that works only for their address.
- **Invite link:** turn on the switch and a link appears, with a button to copy it. Anyone with the link can join
  after signing in or creating an account.

People you invite join as **members**. You can make someone an admin afterwards, in the list at the top.

People can open the workspace's boards as soon as they join. The exception is a board whose owner has limited it;
see "Boards in a workspace" below.

## Roles

| Role | Can |
|---|---|
| **Member** | Open the workspace's boards, and read its plan. |
| **Admin** | Also invite and remove people, rename the workspace, change its plan, and set up its fields. |

An admin can also let a member change the plan without making them an admin: turn on the **Plans** switch beside
their name. ("Plan" here is the team's schedule, not a price. See [planning people](/time/planning).)

Being an admin does not open boards that are limited to certain people. A board belongs to its owners.

## Boards in a workspace

When you create a board you choose where it goes: **Personal** or a workspace.

- **A board made in a workspace** can be opened and edited by everyone in the workspace from the start.
- **A board moved into a workspace** later (from its **⋯ → Move to**) keeps its own sharing: only the people already
  added to it can open it, until an owner changes that.

An owner changes who can open a workspace board with **Share**, under **General access**:

![Share on a workspace board, with the General access choices](/images/share-4-workspace.webp){.medium}

| Choice | Who can open the board |
|---|---|
| **Everyone in the workspace** (shown with its name, "Everyone in Studio") | All its members, plus anyone added by name. Beside it you choose **Can edit** or **Can view**. |
| **Only people added** | Just the people listed under "People with access". |
| **Private** | Only the board's owners. |

A few things follow from this:

- **Everyone who can open a board is "on" it.** With "Everyone in Studio", every member can be assigned cards and
  @mentioned there, without being added by name.
- **Inviting someone to one board does not bring them into the workspace.** A freelancer you add to a single board
  by email sees that board only: not the other boards, not the People page, not the plan.
- **Members only see the boards they can open.** A board limited to other people does not appear on their boards
  page at all.
- On the boards page, each board says how it is shared: **Workspace** (everyone in the workspace), **Invited only**
  (the same as "Only people added") or **Private**.

## Set up fields for the workspace

[Fields](/everyday/fields) are the extra things a team fills in on its cards: a client, an amount, a stage. In a
workspace they are set up once, for all its boards, so "Client" means the same thing on every one of them.

It takes two steps, and each has its own people.

### 1. An admin adds the field to the workspace

1. On the boards page, beside the workspace's name, click **2 people** (it shows the number). Then click the
   **Fields** tab at the top.
2. Click **New field**.
3. Give it a name and pick its kind: text, a number, a date, a choice from a list, a checkbox, a link to another
   card, or a person. Then click **Add field**.

![A workspace's Fields page, with the Fields tab and New field ringed](/images/ws-2-fields.webp)

The field is now in the workspace, and on no board yet.

### 2. A board's owner switches it on for the board

1. Open a board of the workspace, then **⋯ → Board settings → Fields**.
2. Click **Add a field** and pick it from the workspace's fields.

![A workspace board's Fields settings, with the workspace's fields to pick from](/images/ws-3-board-fields.webp){.medium}

From then on every card on that board has the field, and anyone who can edit the board can fill it in.

### Who can do what

| Who | Can |
|---|---|
| **The workspace's admins** | Add fields, rename them, change a choice's options, and archive, merge or delete them. |
| **A board's owners** | Choose which of the workspace's fields their board uses, their order, and which show on the cards. |
| **Anyone who can edit a board** | Fill the fields in on its cards. |
| **Every member** | See the workspace's fields, on the Fields page. |

Good to know:

- **An admin who owns the board can do both from the board.** In Board settings → Fields, **Add a field → New
  field…** makes the field in the workspace and puts it on the board in one go.
- **A workspace's boards use the workspace's fields**, not your own. The ones under Account settings → Fields are for
  your Personal boards.
- **A board moved into the workspace** brings its fields along. The ones the workspace already has (same name and
  kind) are used. The rest are added if you are an admin; if you are not, the move lists what would be lost and asks
  first.
- **A starter board** (Create board → A sales pipeline, or A support desk) adds its fields to the workspace the first
  time, which only an admin can do. After that, any member can make one.
- **Not sure a field is still needed?** Archive it on the Fields page. It goes from every board and its values are
  kept, until you restore it.

Each kind of field, filtering, totals and the rest are in [Your own fields](/everyday/fields).

## Leave or delete

Both are at the bottom of the workspace's **People** page.

- **Leave workspace:** boards you own there stay, and an admin becomes their owner.
- **Delete workspace** (admins) is possible once it has no boards. Move or delete them first.

## Good to know

- You can be in several workspaces.
- Your AI assistant knows which board lives where, so "add it to the Studio board" finds the right one.

## Next

- [Notifications](/people/notifications)
