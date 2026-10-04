# Kanbanto guides

How to use Kanbanto, for the people using it: one page per thing you'd want to do, with pictures of the real app.
(The technical side, hosting it and the API, is in [`../docs`](../docs).)

The pages are Markdown, built into a small website with [VitePress](https://vitepress.dev). This folder is its own
little project, apart from the app: the app's build doesn't know about it.

```bash
cd guides
pnpm install --ignore-workspace
pnpm dev        # http://localhost:5997/guides/  (changes show as you save)
pnpm build      # the website, in .vitepress/dist: serve it under /guides
pnpm preview    # the built website, at http://localhost:5997/guides/
```

## Writing a page

- One page, one thing someone wants to do. Steps first, then "Good to know", then "Next".
- Plain words. Say what's on the screen, with the words the app uses, in **bold**.
- Add the page to the sidebar in `.vitepress/config.ts`.

## The pictures

Every picture in `public/images` is taken from the app by `shots/shots.mjs`, from a sample workspace it makes itself,
so they all match and can be redone when the app changes.

It needs a Kanbanto site that is **only for this** (it signs up two people and fills a board), and Google Chrome:

```bash
GUIDES_SITE=http://localhost:5999 pnpm shots            # all of them
GUIDES_SITE=http://localhost:5999 pnpm shots card menu  # only the ones named like this
```

A few pictures need cards finished weeks ago, and a site admin. Give the script a command that runs SQL on that
throwaway site's database and it takes those too:

```bash
GUIDES_SQL='docker exec my-throwaway-db psql -U kankan -d kankan -c' GUIDES_SITE=… pnpm shots
```

To add a picture: add a `shot('name', …)` to the script, run it, and use `![what it shows](/images/name.webp)`.
