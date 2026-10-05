// The guides' pictures, taken from the real app: a sample workspace is made on a throwaway Kanbanto site, then each
// screen is opened in Chrome and saved under public/images. Run it again whenever the app changes.
//
//   GUIDES_SITE=http://localhost:5999 pnpm shots            (all of them)
//   GUIDES_SITE=http://localhost:5999 pnpm shots card menu  (only the ones whose name has one of these words)
//
// The site must be a throwaway one (see README.md): the script signs up two people on it and fills a board.
// Two pictures need cards that were finished weeks ago. Nothing in the app can pretend that, so they're only taken
// when GUIDES_SQL is a command that runs SQL on that site's database, for example:
//   GUIDES_SQL='docker exec my-throwaway-db psql -U kankan -d kankan -c'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

const SITE = process.env.GUIDES_SITE
if (!SITE) throw new Error('Set GUIDES_SITE to a throwaway Kanbanto site, like http://localhost:5999')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images')
mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const stamp = Date.now()

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' })
const page = await ctx.newPage()
const api = async (who, method, path, data) => {
  const r = await who.request.fetch(`${SITE}/api${path}`, { method, data })
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
  return r.json()
}

// ── The sample workspace: Ann's board for a website launch, with Ben on it ──────────────────────────────

const ann = ctx
const benCtx = await browser.newContext()
await api(ann, 'POST', '/auth/signup', { name: 'Ann Lee', email: `ann.lee+${stamp}@example.com`, password: 'correct horse' })
const ben = (await api(benCtx, 'POST', '/auth/signup', { name: 'Ben Ortiz', email: `ben.ortiz+${stamp}@example.com`, password: 'correct horse' }))
  .user
const me = (await api(ann, 'GET', '/auth/me')).user
// (Each new account starts with an example board: this guide has its own.)
for (const b of (await api(ann, 'GET', '/boards')).boards) await api(ann, 'DELETE', `/boards/${b.id}`)
const { id: board } = await api(ann, 'POST', '/boards', { name: 'Website launch', background: 'blue' })
await api(ann, 'POST', '/boards', { name: 'Team offsite', background: 'green' })
await api(ann, 'POST', '/boards', { name: 'Reading list' })
const { link } = await api(ann, 'PUT', `/boards/${board}/invites/link`, { role: 'editor' })
await api(benCtx, 'POST', '/join', { invite: link.token })
await ann.request.delete(`${SITE}/api/boards/${board}/invites/link`)
let n = 0
const run = (command) => api(ann, 'POST', `/boards/${board}/mutations`, { mutationId: `g${stamp}-${n++}`, command })
await run({ type: 'board.update', fields: { description: 'Everything for the new website, from the first draft to launch day.' } })
for (const [id, name, color] of [
  ['design', 'design', 'blue'],
  ['writing', 'writing', 'orange'],
  ['bug', 'bug', 'red'],
])
  await run({ type: 'label.create', id, name, color })
const add = (id, title, parentId, status, fields = {}) => run({ type: 'task.create', id, parentId, fields: { title, status, ...fields } })

const ANNOUNCEMENT = `## What we're announcing

The new website goes live on launch day, with pricing on its own page.

## Before it goes out

- [x] Agree the headline
- [ ] Two customer quotes
- [ ] A picture of the new homepage

## Where it's posted

1. The blog
2. The newsletter
3. Social accounts`

await add('homepage', 'Homepage', null, 'todo', { assigneeId: me.id, labels: ['design'], start: day(-6), due: day(8) })
await add('headline', 'Write the headline', 'homepage', 'done', { assigneeId: me.id, labels: ['writing'] })
await add('hero', 'Hero picture', 'homepage', 'doing', { assigneeId: ben.id, labels: ['design'], due: day(2) })
await add('pricing', 'Pricing section', 'homepage', 'todo', { assigneeId: ben.id, due: day(6) })
await add('announce', 'Launch announcement', null, 'todo', {
  assigneeId: me.id,
  labels: ['writing'],
  priority: 'high',
  due: `${day(5)}T03:00:00Z`,
  description: ANNOUNCEMENT,
  reminders: [{ id: 'r1', beforeDue: 1440 }],
})
await add('signup', 'Fix the sign-up form on phones', null, 'todo', { labels: ['bug'], priority: 'urgent', due: day(-1), assigneeId: ben.id })
await add('quotes', 'Collect customer quotes', null, 'todo', { assigneeId: ben.id, due: day(9) })
await add('newsletter', 'Newsletter sign-up box', null, 'doing', { assigneeId: me.id, labels: ['design'], due: day(3) })
await add('analytics', 'Set up visitor counts', null, 'doing', { assigneeId: ben.id })
await add('photographer', 'Book a photographer', null, 'backlog', {})
await add('domain', 'Choose a domain name', null, 'done', { assigneeId: me.id })
await add('email', 'Set up the team email', null, 'done', { assigneeId: ben.id })
// Finished a while ago (so the Done list has "older" cards to show and archive).
for (const [i, title] of ['Pick the colors', 'Draw the logo', 'Write the About page', 'Choose the fonts', 'Map the pages'].entries())
  await add(`old${i}`, title, null, 'done', { assigneeId: i % 2 ? ben.id : me.id })
// Finished weeks ago, as far as the database says (see GUIDES_SQL above).
const aged = !!process.env.GUIDES_SQL
if (aged) {
  const [cmd, ...args] = process.env.GUIDES_SQL.split(' ')
  // (And Ann runs the site, so she can turn on connecting apps for the pictures about assistants.)
  execFileSync(cmd, [...args, `update users set is_admin = true where id = '${me.id}';`], { stdio: 'ignore' })
  await api(ann, 'PATCH', '/admin/settings', { apiTokens: true, oauthApps: 'any' }).catch(() =>
    api(ann, 'PATCH', '/admin/settings', { apiTokens: true }),
  )
  const sql = `update tasks set created_at = now() - interval '60 days', updated_at = now() - interval '40 days', active_at = now() - interval '40 days', done_at = now() - interval '40 days' where board_id = '${board}' and id like 'old%'; update boards set seq = seq + 1 where id = '${board}';`
  execFileSync(cmd, [...args, sql], { stdio: 'ignore' })
}
await api(benCtx, 'POST', `/boards/${board}/tasks/announce/comments`, {
  body: 'First draft is in. @Ann Lee can you check the opening paragraph?',
  mentions: [me.id],
}).catch(() =>
  api(benCtx, 'POST', `/boards/${board}/tasks/announce/comments`, { body: 'First draft is in. @Ann Lee can you check the opening paragraph?' }),
)
await api(ann, 'POST', `/boards/${board}/tasks/announce/comments`, { body: 'Reads well. I’d move the pricing line up, then it’s ready.' })
await api(benCtx, 'POST', `/boards/${board}/tasks/hero/comments`, { body: 'Two options attached tomorrow.' })

// A team workspace with a board in it, a plan of who works on what, and a few hours logged this week.
const { id: studio } = await api(ann, 'POST', '/workspaces', { name: 'Studio' })
const { link: door } = await api(ann, 'PUT', `/workspaces/${studio}/invites/link`, {}).catch(() => ({ link: null }))
if (door) await api(benCtx, 'POST', '/join', { invite: door.token }).catch(() => {})
const { id: clientBoard } = await api(ann, 'POST', '/boards', { name: 'Brand refresh', background: 'pink', workspaceId: studio })
for (const [i, [title, from, to]] of [
  ['Collect what we have', 1, 5],
  ['New logo options', 6, 16],
  ['Colors and type', 13, 24],
].entries())
  await api(ann, 'POST', `/boards/${clientBoard}/mutations`, {
    mutationId: `c${stamp}-${i}`,
    command: {
      type: 'task.create',
      id: `brand${i}`,
      parentId: null,
      fields: { title, status: i ? 'todo' : 'doing', start: day(from), due: day(to) },
    },
  })
const plan = await api(ann, 'GET', `/workspaces/${studio}/planning`)
const people = plan.plan?.people ?? plan.people ?? []
const personOf = (name) => people.find((x) => x.name === name)?.id
let pn = 0
const planRun = (command) =>
  api(ann, 'POST', `/workspaces/${studio}/planning/mutations`, { mutationId: `p${stamp}-${pn++}`, command }).catch((e) =>
    console.log('plan:', e.message),
  )
const [cara, web, app, brand] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
await planRun({ type: 'person.add', id: cara, name: 'Cara Diaz' })
for (const [id, name, plannedMd, color] of [
  [web, 'Website launch', 20, 'blue'],
  [app, 'Mobile app', 45, 'green'],
  [brand, 'Brand refresh', 12, 'orange'],
])
  await planRun({ type: 'project.add', id, name, plannedMd, color })
// (Brand refresh has its tasks on the workspace's board of that name.)
await planRun({ type: 'project.update', id: brand, fields: { boardId: clientBoard } })
// (Bars run over whole weeks, Monday to Friday, from this week's Monday; at a weekend, from the coming one.)
const dow = new Date().getUTCDay()
const monday = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow
const weeks = (from, n) => [day(monday + from * 7), day(monday + (from + n) * 7 - 3)]
for (const [projectId, who, from, n, pct] of [
  [web, personOf('Ann Lee'), 0, 4, 50],
  [web, personOf('Ben Ortiz'), 0, 2, 100],
  [app, personOf('Ann Lee'), 0, 6, 50],
  [app, cara, 1, 5, 100],
  [brand, personOf('Ben Ortiz'), 2, 4, 75],
]) {
  if (!who) continue
  const [start, end] = weeks(from, n)
  await planRun({ type: 'line.add', projectId, personId: who })
  await planRun({ type: 'block.add', projectId, personId: who, start, end, pct })
}
const planned = new Set((await api(ann, 'GET', `/workspaces/${studio}/planning`)).plan.blocks.map((b) => b.id))
for (const [task, minutes, back, note] of [
  ['hero', 90, 0, 'First two options'],
  ['newsletter', 150, 0, ''],
  ['announce', 60, 1, 'Draft'],
  ['newsletter', 120, 1, ''],
  ['headline', 45, 2, ''],
])
  await api(ann, 'POST', `/boards/${board}/tasks/${task}/time`, { minutes, day: day(-back), note }).catch((e) => console.log('time:', e.message))
if (aged) await api(ann, 'PATCH', '/admin/settings', { calendarLinks: true }).catch(() => {})

// ── Taking the pictures ───────────────────────────────────────────────────────────────────────────

const made = []
const failed = []
/**
 * One picture: `name`.webp, of the page or of one part of it (at twice the size, so it's sharp; as WebP, which keeps
 * the whole set to a few megabytes: less than half of what JPEG takes). Only the ones asked for are taken.
 */
async function shot(name, take) {
  if (only.length && !only.some((w) => name.includes(w))) return
  try {
    const target = (await take()) ?? page
    await page.waitForTimeout(350)
    await tidy()
    // (A part of the screen is given as a locator, or as { clip } for a region of the page.)
    // (GUIDES_TEXT=1 also prints the words on the screen, to write the page from what the app really says.)
    if (process.env.GUIDES_TEXT) {
      const top = page.locator('[role=dialog], [role=alertdialog], [role=menu]').last()
      const words = (await top.count()) ? await top.innerText() : await page.locator('body').innerText()
      console.log(`\n── ${name} ──\n${words.replace(/\n{2,}/g, '\n').slice(0, 1800)}`)
    }
    const png = target.clip ? await page.screenshot({ clip: target.clip }) : await target.screenshot()
    await sharp(png)
      .webp({ quality: 82, smartSubsample: true, effort: 6 })
      .toFile(join(OUT, `${name}.webp`))
    made.push(name)
    await unring()
  } catch (e) {
    await unring()
    failed.push(`${name}: ${String(e.message).split('\n')[0]}`)
  }
}
const openBoard = async (view = 'board') => {
  await page.goto(`${SITE}/#/b/${board}/${view}`)
  await page.reload()
  await page.getByText('Launch announcement', { exact: true }).first().waitFor()
  await page.waitForTimeout(500)
}
const openCard = async (id) => {
  await page.goto(`${SITE}/#/b/${board}/board?task=${id}`)
  await page.reload()
  await page.getByRole('dialog').first().waitFor()
  await page.waitForTimeout(600)
  return page.getByRole('dialog').first()
}
/**
 * The sample's made-up details, as they'd read on a real site: email addresses without the number that keeps each run
 * apart, and the site's own address instead of this throwaway one.
 */
const tidy = () =>
  page
    .evaluate((site) => {
      const fix = (t) => t.replace(/\+\d{10,}@/g, '@').replaceAll(site, 'https://kanbanto.example.com')
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (fix(n.nodeValue) !== n.nodeValue) n.nodeValue = fix(n.nodeValue)
      for (const el of document.querySelectorAll('input')) if (fix(el.value) !== el.value) el.value = fix(el.value)
    }, SITE)
    .catch(() => {})

/** The region around some parts of the screen, with room to spare (kept inside the window). */
async function around(parts, pad = 24) {
  const boxes = []
  for (const part of parts) {
    const b = await part.first().boundingBox()
    if (b) boxes.push(b)
  }
  const view = page.viewportSize()
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad)
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad)
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad)
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad)
  return { clip: { x, y, width: right - x, height: bottom - y } }
}

/**
 * A ring around what to click or look at, for step-by-step pictures. It's drawn over the page, and taken off again
 * once the picture is taken.
 */
async function ring(...parts) {
  await page.waitForTimeout(600)
  // (Tidied first: shorter sample text can move what the ring goes around.)
  await tidy()
  const boxes = []
  for (const part of parts) boxes.push(await part.first().boundingBox())
  await page.evaluate((list) => {
    for (const r of list) {
      if (!r) continue
      const el = document.createElement('div')
      el.className = 'guide-ring'
      el.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${r.x - 6}px;top:${r.y - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:3px solid #e11d48;border-radius:12px;box-shadow:0 0 0 5px rgb(225 29 72 / 0.22)`
      document.body.append(el)
    }
  }, boxes)
}
const unring = () => page.evaluate(() => document.querySelectorAll('.guide-ring').forEach((el) => el.remove())).catch(() => {})

/** Numbered markers on the corner of parts of the screen (for "finding your way around"). */
async function mark(spots) {
  const boxes = []
  // (A spot is a part of the page: its corner gets the number. { above } puts it over the middle instead, for
  // buttons standing side by side, where a corner sits between two of them.)
  for (const spot of spots) {
    const r = await (spot.above ?? spot).first().boundingBox()
    boxes.push(r && (spot.above ? { x: r.x + r.width / 2 - 2, y: r.y - 6 } : r))
  }
  await page.evaluate((list) => {
    for (const [i, r] of list.entries()) {
      if (!r) continue
      const dot = document.createElement('div')
      dot.textContent = String(i + 1)
      dot.style.cssText = `position:fixed;z-index:2147483647;left:${Math.max(2, r.x - 9)}px;top:${Math.max(2, r.y - 9)}px;width:22px;height:22px;border-radius:50%;background:#e11d48;color:#fff;font:600 12px/22px system-ui;text-align:center;box-shadow:0 0 0 2px #fff`
      document.body.append(dot)
    }
  }, boxes)
}

await shot('boards', async () => {
  await page.goto(`${SITE}/#/`)
  await page.reload()
  await page.getByText('Website launch').first().waitFor()
})
await shot('board', () => openBoard())
await shot('around', async () => {
  await openBoard()
  await mark([
    page.getByLabel('All boards'),
    page.getByRole('tablist', { name: 'Views' }),
    page.getByLabel('Search tasks'),
    page.getByRole('button', { name: 'New task' }),
    page.getByRole('button', { name: 'Share' }),
    page.getByRole('button', { name: 'More' }),
    { above: page.getByRole('button', { name: 'Filter' }) },
    { above: page.getByRole('button', { name: 'Display' }) },
  ])
})
await shot('add-card', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Add a card' }).first().click()
  await page.keyboard.type('Order launch cake friday 2pm')
  await page.waitForTimeout(500)
  return around(
    [page.getByText('To Do', { exact: true }), page.getByRole('button', { name: 'Add card' }), page.getByText('Set up visitor counts')],
    28,
  )
})
await shot('card', () => openCard('announce'))
await shot('card-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Launch announcement options' }).first().click({ force: true })
  await page.getByRole('menu').waitFor()
  return around([page.getByRole('menu'), page.getByText('To Do', { exact: true }), page.getByText('Collect customer quotes')], 28)
})
await shot('description-writing', async () => {
  const card = await openCard('quotes')
  await card.getByRole('button', { name: /Add more detail/ }).click()
  await page.getByRole('textbox', { name: 'Description' }).waitFor()
  await page.waitForTimeout(400)
  await page.keyboard.type('## Who to ask')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- The bakery on Mill Street')
  await page.keyboard.press('Enter')
  await page.keyboard.type('The cycling club')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await page.getByRole('listbox', { name: 'Put in' }).waitFor()
  return around(
    [
      card.getByText('Description', { exact: true }),
      page.getByRole('listbox', { name: 'Put in' }),
      card.getByRole('button', { name: 'Write full page' }),
    ],
    28,
  )
})
await shot('description-full-page', async () => {
  const card = await openCard('announce')
  await card.getByRole('button', { name: 'Expand' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('dialog').last().getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('textbox', { name: 'Description' }).waitFor()
  await page.waitForTimeout(500)
})
await shot('outline', () => openBoard('outline'))
await shot('timeline', () => openBoard('timeline'))
await shot('due-date', async () => {
  const card = await openCard('newsletter')
  await card.getByText('Due', { exact: true }).locator('..').getByRole('button').first().click()
  await page.waitForTimeout(600)
  return around([page.getByPlaceholder(/Type a date/), page.getByText('Add time'), card.getByText('Reminders', { exact: true })], 36)
})
await shot('reminders', async () => {
  const card = await openCard('announce')
  await card.getByRole('button', { name: 'Add a reminder' }).click()
  await page.waitForTimeout(600)
  const { clip } = await around(
    [page.getByPlaceholder(/tmr 10:00/), page.getByText('2 days before'), card.getByRole('button', { name: 'Add a reminder' })],
    36,
  )
  // (From the list's own edge: the names of the card's other fields, to its left, would only be cut in half.)
  return { clip: { ...clip, x: clip.x + 26, width: clip.width - 26 } }
})
await shot('comments', async () => {
  const card = await openCard('announce')
  await card.getByRole('button', { name: /Write a comment/ }).click()
  await page.getByRole('textbox', { name: 'Write a comment' }).waitFor()
  await page.waitForTimeout(300)
  await page.keyboard.type('Thanks @Be')
  await page.waitForTimeout(500)
  return around(
    [
      card.getByText('Comments', { exact: true }),
      page.getByRole('textbox', { name: 'Write a comment' }),
      card.getByText('Ben Ortiz').first(),
      page.getByRole('listbox'),
    ],
    28,
  )
})
await shot('files', async () => {
  const card = await openCard('hero')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await card
    .locator('input[type=file]')
    .first()
    .setInputFiles([
      { name: 'hero-option-a.png', mimeType: 'image/png', buffer: png },
      { name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') },
    ])
  await card.getByText('brief.pdf').first().waitFor()
  await page.waitForTimeout(500)
  return around(
    [
      card.getByText('Files', { exact: true }),
      card.getByText('brief.pdf'),
      card.getByRole('button', { name: 'Attach' }).first(),
      card.getByText('Subtasks', { exact: true }),
    ],
    28,
  )
})
await shot('search', async () => {
  await openBoard()
  await page.getByLabel('Search tasks').fill('launch')
  await page.waitForTimeout(600)
  await ring(page.getByLabel('Search tasks'))
  return { clip: { x: 0, y: 0, width: 1360, height: 430 } }
})
await shot('filter', async () => {
  await openBoard()
  // (A taller window for this one: the whole list of filters, down to the labels.)
  await page.setViewportSize({ width: 1360, height: 1160 })
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.waitForTimeout(500)
  return { clip: { x: 760, y: 50, width: 600, height: 1090 } }
})
await page.setViewportSize({ width: 1360, height: 860 })
await shot('display', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Display' }).click()
  await page.waitForTimeout(500)
  return { clip: { x: 760, y: 50, width: 600, height: 800 } }
})
if (aged)
  await shot('done-list', async () => {
    await openBoard()
    await page.getByRole('button', { name: 'Archive…' }).first().waitFor({ timeout: 5000 })
    await ring(page.getByRole('button', { name: 'Archive…' }))
    return around(
      [
        page.getByText('Done', { exact: true }),
        page.getByRole('button', { name: 'Archive…' }),
        page.getByRole('button', { name: 'Add a card' }).nth(2),
        page.getByRole('button', { name: 'Done list options' }),
      ],
      30,
    )
  })
if (aged)
  await shot('archive-older', async () => {
    await openBoard()
    await page.getByRole('button', { name: 'Archive…' }).first().click()
    await page.getByRole('alertdialog').waitFor()
    await page.waitForTimeout(500)
    await ring(page.getByRole('alertdialog').getByRole('button', { name: /^Archive/ }))
    return around([page.getByRole('alertdialog')], 40)
  })
await shot('archived-cards', async () => {
  await run({ type: 'task.archive', id: 'old0', complete: true })
  await run({ type: 'task.archive', id: 'old1', complete: true })
  await page.goto(`${SITE}/#/cards?state=archived&board=${board}`)
  await page.reload()
  await page.getByText('Pick the colors').first().waitFor()
})
if (aged)
  await shot('assistant-address', async () => {
    await page.goto(`${SITE}/#/account/api`)
    await page.reload()
    const card = page.getByText('Connected apps', { exact: true }).locator('xpath=ancestor::*[contains(@class,"rounded")][1]')
    await card.waitFor()
    // (The address shown is this throwaway site's: in the picture it reads like any Kanbanto site's.)
    await page.evaluate((site) => {
      for (const el of document.querySelectorAll('code'))
        if (el.textContent.includes(site)) el.textContent = el.textContent.replace(site, 'https://kanbanto.example.com')
    }, SITE)
    await card.scrollIntoViewIfNeeded()
    await ring(card.getByRole('button', { name: 'Copy the address' }))
    return card
  })

// The views, the board's own settings, and working with people.
await shot('board-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu').waitFor()
  return around([page.getByRole('menu')], 60)
})
await shot('board-settings', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(500)
  return page.getByRole('dialog')
})
await shot('stats', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Board stats' }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(700)
  return page.getByRole('dialog')
})
await shot('list-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Doing list options' }).click()
  await page.getByRole('menu').waitFor()
  return around([page.getByRole('menu'), page.getByText('Doing', { exact: true })], 30)
})
await shot('presets', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Presets' }).click()
  await page.waitForTimeout(500)
  return { clip: { x: 700, y: 50, width: 660, height: 420 } }
})
await shot('share', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Share' }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(600)
  return page.getByRole('dialog')
})
await shot('workspace', async () => {
  await page.goto(`${SITE}/#/w/${studio}`)
  await page.reload()
  await page.getByText('Studio').first().waitFor()
  await page.waitForTimeout(700)
})
await shot('planning', async () => {
  await page.goto(`${SITE}/#/w/${studio}/planning`)
  await page.reload()
  await page.getByText('Mobile app').first().waitFor()
  await page.waitForTimeout(900)
})
await shot('log-1-pick', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Log time' }).click()
  await page.waitForTimeout(700)
  await page.keyboard.type('hero')
  await page.waitForTimeout(700)
  return around([page.getByText('Pick a card, then type the time you spent on it.'), page.getByText('Open my week'), page.getByText(/Today: /)], 70)
})
await shot('log-time', async () => {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('1:30')
  await page.waitForTimeout(600)
  return around(
    [
      page.getByText('Pick a card, then type the time you spent on it.'),
      page.getByText('Open my week'),
      page.getByText(/Today: /),
      page.getByText('15m', { exact: true }),
    ],
    70,
  )
})
await shot('card-time', async () => {
  const card = await openCard('newsletter')
  const title = card.getByText('Time', { exact: true }).first()
  await title.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
  // (A little more on the left: the section's icon and the person's initials stand out from the text.)
  const { clip } = await around([title, card.getByText('4h 30m').first(), card.getByText('Yesterday').first()], 28)
  return { clip: { ...clip, x: clip.x - 44, width: clip.width + 44 } }
})
await shot('my-week', async () => {
  await page.goto(`${SITE}/#/time`)
  await page.reload()
  await page.getByText('Newsletter sign-up box').first().waitFor()
  await page.waitForTimeout(700)
})
await shot('bell', async () => {
  // Ben changes a card Ann made (so she follows it): the bell has a mention, a comment and changes to show.
  for (const fields of [{ due: day(5) }, { description: 'Count visits per page, and where people come from.' }])
    await api(benCtx, 'POST', `/boards/${board}/mutations`, {
      mutationId: `g${stamp}-ben-${n++}`,
      command: { type: 'task.update', id: 'analytics', fields },
    })
  await openBoard()
  await page
    .getByRole('button', { name: /Notifications/ })
    .first()
    .click()
  await page.waitForTimeout(600)
  const list = page.getByText('Mark all as read').locator('xpath=ancestor::*[@data-slot="popover-content"][1]')
  return around([page.getByRole('button', { name: /Notifications/ }), list], 20)
})
await shot('follow', async () => {
  const card = await openCard('newsletter')
  const unfollow = card.getByRole('button', { name: 'Unfollow', exact: true })
  await unfollow.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
  await ring(unfollow)
  return around([unfollow, card.getByRole('button', { name: 'Delete task' })], 28)
})
await shot('notifications', async () => {
  await page.goto(`${SITE}/#/account/notifications`)
  await page.reload()
  await page.waitForTimeout(1000)
})
// (The page as it is on a site whose admin has set up Google Calendar: this throwaway one hasn't.)
await page.route('**/api/account/calendar', async (route) => {
  const r = await route.fetch()
  await route.fulfill({ response: r, json: { ...(await r.json()), googleEnabled: true } })
})
await shot('calendar', async () => {
  await page.goto(`${SITE}/#/account/calendar`)
  await page.reload()
  await page.getByText('Calendar link', { exact: true }).waitFor()
  await page.waitForTimeout(700)
  return around(
    [
      page.getByText('Google Calendar', { exact: true }).first(),
      page.getByText('Boards in your calendar'),
      page.getByText('Website launch').last(),
      page.getByRole('button', { name: 'Make a link' }),
    ],
    60,
  )
})
await page.unroute('**/api/account/calendar')
await shot('account-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menu').waitFor()
  return around([page.getByRole('menu')], 60)
})

// Step by step, where a step is easy to miss: a ring shows what to click.
await shot('desc-1-click', async () => {
  const card = await openCard('analytics')
  await ring(card.getByRole('button', { name: /Add more detail/ }))
  return around(
    [
      card.getByText('Description', { exact: true }),
      card.getByRole('button', { name: /Add more detail/ }),
      card.getByRole('button', { name: 'Expand' }),
    ],
    30,
  )
})
await shot('desc-2-sign', async () => {
  const card = await openCard('analytics')
  await card.getByRole('button', { name: /Add more detail/ }).click()
  await page.getByRole('textbox', { name: 'Description' }).waitFor()
  await page.waitForTimeout(400)
  await page.keyboard.type('Count visits to the homepage and the pricing page.')
  await page.waitForTimeout(600)
  await ring(card.getByRole('status'))
  return around(
    [
      card.getByText('Description', { exact: true }),
      page.getByRole('textbox', { name: 'Description' }),
      card.getByRole('button', { name: 'Write full page' }),
    ],
    30,
  )
})
await shot('desc-3-draft', async () => {
  // (Left without saving: the page reloads, and the card offers the writing back.)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.getByRole('button', { name: 'Continue writing' }).waitFor()
  await page.waitForTimeout(400)
  await ring(card.getByRole('button', { name: 'Continue writing' }))
  return around(
    [
      card.getByText('Description', { exact: true }),
      card.getByRole('button', { name: 'Continue writing' }),
      card.getByRole('button', { name: 'Expand' }),
      card.getByRole('button', { name: /Add more detail/ }),
    ],
    30,
  )
})
await shot('sub-1-add', async () => {
  const card = await openCard('homepage')
  await ring(card.getByText('Add a subtask'))
  return around([card.getByText('Subtasks', { exact: true }), card.getByText('Pricing section'), card.getByText('Add a subtask')], 34)
})
await shot('sub-2-focus', async () => {
  await page.goto(`${SITE}/#/b/${board}/board?focus=homepage`)
  await page.reload()
  await page.getByText('Hero picture', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  return { clip: { x: 0, y: 0, width: 1000, height: 470 } }
})
await shot('date-1-due', async () => {
  const card = await openCard('analytics')
  const due = card.getByText('Due', { exact: true }).locator('..').getByRole('button').first()
  await ring(due)
  return around(
    [
      card.getByText('Start', { exact: true }),
      due,
      card.getByText('Reminders', { exact: true }),
      card.getByRole('button', { name: 'Add a reminder' }),
    ],
    40,
  )
})
await shot('date-2-typed', async () => {
  const card = await openCard('analytics')
  await card.getByText('Due', { exact: true }).locator('..').getByRole('button').first().click()
  await page.getByPlaceholder(/Type a date/).fill('fri 2pm')
  await page.waitForTimeout(700)
  return around([page.getByPlaceholder(/Type a date/), page.getByText('Add time').or(page.getByText(/time/i).last())], 40)
})
await shot('comment-1-box', async () => {
  const card = await openCard('announce')
  await ring(card.getByRole('button', { name: /Write a comment/ }))
  const box = await card.getByRole('button', { name: /Write a comment/ }).boundingBox()
  return { clip: { x: box.x - 56, y: box.y - 24, width: box.width + 68, height: box.height + 72 } }
})
await shot('file-1-attach', async () => {
  const card = await openCard('announce')
  await ring(card.getByRole('button', { name: 'Attach' }).first())
  return around(
    [card.getByText('Files', { exact: true }), card.getByRole('button', { name: 'Attach' }).first(), card.getByText('Drop files here')],
    30,
  )
})
if (aged)
  await shot('archive-3-undo', async () => {
    // (The two archived for an earlier picture come back first: the count is the one the dialog showed.)
    for (const id of ['old0', 'old1']) await run({ type: 'task.restore', id }).catch(() => {})
    await openBoard()
    await page.getByRole('button', { name: 'Archive…' }).first().click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Archive \d/ })
      .click()
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /archived/ })
    await toast.waitFor()
    await ring(toast.getByRole('button', { name: 'Undo' }))
    return around([toast], 40)
  })
await shot('archive-4-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  const item = page.getByRole('menuitem', { name: /Archived cards/ })
  await item.waitFor()
  await ring(item)
  return around([page.getByRole('menu')], 60)
})
await shot('archive-5-restore', async () => {
  await page.goto(`${SITE}/#/cards?state=archived&board=${board}`)
  await page.reload()
  const restore = page.getByRole('button', { name: /^Restore / }).first()
  await restore.waitFor()
  await page.waitForTimeout(500)
  await ring(restore)
  return { clip: { x: 0, y: 0, width: 1360, height: 560 } }
})
await shot('connect-1-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menu').waitFor()
  await ring(page.getByRole('menuitem', { name: 'Account settings' }))
  return around([page.getByRole('menu')], 60)
})
await shot('connect-2-allow', async () => {
  // An app asking to connect, the way Claude does (the app's server may be at another address in development).
  const server = process.env.GUIDES_SERVER ?? SITE
  const made = await ctx.request.post(`${server}/oauth/register`, {
    data: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' },
  })
  const { client_id } = await made.json()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope: 'kanbanto:write',
    state: 'guide',
  })
  await page.goto(`${SITE}/#/authorize?${query}`)
  await page.reload()
  await page.getByRole('button', { name: 'Allow' }).waitFor({ timeout: 8000 })
  await page.waitForTimeout(500)
  await ring(page.getByRole('button', { name: 'Allow' }))
  return around(
    [page.getByRole('button', { name: 'Allow' }), page.getByText('It may'), page.getByText('Only read').first(), page.getByRole('heading').first()],
    60,
  )
})
await shot('share-1-button', async () => {
  await openBoard()
  await ring(page.getByRole('button', { name: 'Share' }))
  return { clip: { x: 560, y: 0, width: 800, height: 300 } }
})
await shot('share-2-invite', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByPlaceholder('Add people by email').fill('cara@example.com')
  await page.waitForTimeout(400)
  await ring(dialog.getByPlaceholder('Add people by email'), dialog.getByRole('button', { name: 'Invite', exact: true }))
  return dialog
})
await shot('share-3-link', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByText('Invite with a link or code').click()
  await dialog.getByRole('switch', { name: 'Invite link' }).click()
  await page.waitForTimeout(900)
  return dialog
})
await shot('share-4-workspace', async () => {
  await page.goto(`${SITE}/#/b/${clientBoard}`)
  await page.reload()
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByText('General access').scrollIntoViewIfNeeded()
  await dialog.getByLabel('Who can open this board').click()
  await page.waitForTimeout(700)
  // (With the choices open, the dialog is hidden from assistive tech: found by its markup instead.)
  return around([page.locator('[role=dialog]'), page.locator('[role=listbox]')], 30)
})
await shot('share-5-public', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByRole('switch', { name: 'Anyone with the link can view' }).click()
  const copy = dialog.getByRole('button', { name: 'Copy link' })
  await copy.waitFor()
  await ring(copy)
  return around([dialog.getByText('General access'), copy, dialog.getByText(/Even without an account/)], 36)
})
// (Closed again: the other pictures show a board that isn't public.)
await ann.request.patch(`${SITE}/api/boards/${board}/sharing`, { data: { publicLink: false } })
await shot('ws-1-create', async () => {
  await page.goto(`${SITE}/#/`)
  await page.reload()
  await page.getByText('Website launch').first().waitFor()
  const make = page.getByRole('button', { name: /New workspace/ }).first()
  await make.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await ring(make)
  return around([make, page.getByText('Studio').first()], 80)
})
await shot('time-1-button', async () => {
  await openBoard()
  await ring(page.getByRole('button', { name: 'Log time' }))
  return { clip: { x: 560, y: 0, width: 800, height: 300 } }
})
await shot('calendar-1-link', async () => {
  await page.goto(`${SITE}/#/account/calendar`)
  await page.reload()
  const make = page.getByRole('button', { name: 'Make a link' })
  await make.waitFor()
  await page.waitForTimeout(500)
  await ring(make)
  return around([page.getByText('Calendar link', { exact: true }), make], 60)
})

// Planning, as a walk-through.
const openPlan = async (by = '') => {
  await page.goto(`${SITE}/#/w/${studio}/planning${by}`)
  await page.reload()
  await page.getByText('Mobile app').first().waitFor()
  await page.waitForTimeout(900)
}
await shot('plan-1-tab', async () => {
  await page.goto(`${SITE}/#/w/${studio}`)
  await page.reload()
  await page.getByText('Planning', { exact: true }).first().waitFor()
  await page.waitForTimeout(500)
  await ring(page.getByText('Planning', { exact: true }))
  return { clip: { x: 0, y: 0, width: 900, height: 260 } }
})
await shot('plan-2-project', async () => {
  await openPlan()
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(500)
  return page.getByRole('dialog')
})
await shot('plan-3-person', async () => {
  await openPlan()
  await page.getByText('Add a person').first().click()
  await page.waitForTimeout(700)
  return { clip: { x: 0, y: 150, width: 900, height: 520 } }
})
await shot('plan-4-new', async () => {
  await openPlan()
  // Cara Diaz's line under Mobile app, in an empty week well before her bar.
  const row = await page.getByText('Cara Diaz').first().boundingBox()
  await page.mouse.click(520, row.y + row.height / 2)
  await page.waitForTimeout(900)
  await ring(page.locator(':focus'))
  return { clip: { x: 0, y: 120, width: 1360, height: 560 } }
})
// (The bar made for that picture is taken out again: the later pictures show the plan as it was.)
for (const b of (await api(ann, 'GET', `/workspaces/${studio}/planning`)).plan.blocks)
  if (!planned.has(b.id)) await planRun({ type: 'block.remove', id: b.id })
await shot('plan-4-block', async () => {
  await openPlan()
  await page
    .getByText(/100% · /)
    .first()
    .click()
  await page.waitForTimeout(800)
  return { clip: { x: 0, y: 120, width: 1360, height: 620 } }
})
await shot('plan-5-person', async () => {
  await openPlan()
  await page.getByText('By person', { exact: true }).click()
  await page.waitForTimeout(900)
  return { clip: { x: 0, y: 0, width: 1360, height: 560 } }
})
await shot('plan-6-details', async () => {
  await openPlan()
  await page.getByText('Website launch', { exact: true }).first().hover()
  await page.getByText('Website launch', { exact: true }).first().click()
  await page.waitForTimeout(800)
})
await shot('plan-7-board', async () => {
  await page.goto(`${SITE}/#/b/${clientBoard}/timeline`)
  await page.reload()
  await page.waitForTimeout(1500)
  return { clip: { x: 0, y: 0, width: 1360, height: 420 } }
})

// Step by step: "Your first board" (done last: it adds a board of its own).
await shot('first-1-create', async () => {
  await page.goto(`${SITE}/#/`)
  await page.reload()
  await page.getByRole('button', { name: 'Create board' }).first().waitFor()
  await page.waitForTimeout(500)
  await ring(page.getByRole('button', { name: 'Create board' }))
  return { clip: { x: 0, y: 0, width: 1360, height: 520 } }
})
await shot('first-2-name', async () => {
  // (The dialog is taller than the usual window: a taller one for this picture and the next.)
  await page.setViewportSize({ width: 1360, height: 1180 })
  await page.getByRole('button', { name: 'Create board' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByLabel('Name').fill('My first board')
  await page.waitForTimeout(400)
  await ring(dialog.getByLabel('Name'), dialog.getByRole('button', { name: /^Create/ }))
  return around([dialog], 30)
})
await shot('first-3-add', async () => {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Create/ })
    .click()
  await page.getByRole('button', { name: 'Add a card' }).first().waitFor()
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.waitForTimeout(700)
  await ring(page.getByRole('button', { name: 'Add a card' }))
  return { clip: { x: 0, y: 0, width: 1120, height: 420 } }
})
await shot('first-4-type', async () => {
  await page.getByRole('button', { name: 'Add a card' }).first().click()
  await page.keyboard.type('Write the welcome email')
  await page.waitForTimeout(400)
  await ring(page.getByRole('button', { name: 'Add card' }))
  return { clip: { x: 0, y: 0, width: 1120, height: 420 } }
})
await shot('first-5-cards', async () => {
  await page.keyboard.press('Enter')
  await page.keyboard.type('Book the meeting room')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Order name badges')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  return { clip: { x: 0, y: 0, width: 1120, height: 470 } }
})
await shot('first-6-drag', async () => {
  // A card on its way from To Do to Doing, held mid-air.
  const from = await page.getByText('Write the welcome email', { exact: true }).first().boundingBox()
  const to = await page.getByText('Doing', { exact: true }).first().boundingBox()
  await page.mouse.move(from.x + 60, from.y + 12)
  await page.mouse.down()
  await page.mouse.move(from.x + 90, from.y + 30, { steps: 5 })
  await page.mouse.move(to.x + 70, to.y + 90, { steps: 12 })
  await page.waitForTimeout(400)
  return { clip: { x: 0, y: 0, width: 1120, height: 470 } }
})
await shot('first-7-moved', async () => {
  await page.mouse.up()
  await page.waitForTimeout(600)
  await ring(page.getByText('Write the welcome email', { exact: true }))
  return { clip: { x: 0, y: 0, width: 1120, height: 470 } }
})
await shot('first-8-open', async () => {
  await page.getByText('Write the welcome email', { exact: true }).first().click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(600)
})

// ── Your own fields: on a board of their own, made last, so no other picture changes ────────────────────

let deals = null
/** A small board of client work with four fields of Ann's, made the first time a picture needs it. */
async function clientWork() {
  if (deals) return deals
  const field = async (body) => (await api(ann, 'POST', '/fields', body)).id
  const stage = await field({
    name: 'Stage',
    type: 'choice',
    options: [
      { name: 'Lead', color: 'gray' },
      { name: 'Proposal sent', color: 'blue' },
      { name: 'Won', color: 'green' },
    ],
  })
  const client = await field({ name: 'Client', type: 'text' })
  const amount = await field({ name: 'Amount', type: 'number', unit: '$', decimals: 0, sum: true })
  const website = await field({ name: 'Website', type: 'text', format: 'link' })
  const signed = await field({ name: 'Contract signed', type: 'checkbox' })
  const [lead, sent, won] = (await api(ann, 'GET', '/fields')).fields.find((f) => f.id === stage).options.map((o) => o.id)
  const { id } = await api(ann, 'POST', '/boards', { name: 'Client work', background: 'teal' })
  await api(ann, 'PUT', `/boards/${id}/fields`, {
    fields: [{ id: stage, front: true }, { id: client }, { id: amount, front: true, total: true }, { id: website }, { id: signed }],
  })
  const card = (cardId, title, status, custom) =>
    api(ann, 'POST', `/boards/${id}/mutations`, {
      mutationId: `g${stamp}-f-${n++}`,
      command: { type: 'task.create', id: cardId, parentId: null, fields: { title, status, assigneeId: me.id, custom } },
    })
  await card('redesign', 'Website redesign', 'todo', { [stage]: sent, [client]: 'Northwind', [amount]: 12000, [website]: 'northwind.example.com' })
  await card('report', 'Annual report', 'todo', { [stage]: lead, [client]: 'Globex' })
  await card('brand', 'Brand refresh', 'doing', { [stage]: won, [client]: 'Acme', [amount]: 4500, [website]: 'acme.example.com', [signed]: true })
  await card('shop', 'Online shop', 'doing', { [stage]: won, [client]: 'Hooli', [amount]: 18000, [signed]: true })
  return (deals = { id })
}
await shot('fields-1-new', async () => {
  await clientWork()
  await page.goto(`${SITE}/#/account/fields`)
  await page.reload()
  await page.getByRole('button', { name: 'New field' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Source')
  await page.getByRole('radio', { name: /Choice/ }).click()
  for (const name of ['Referral', 'Website', 'Event']) {
    await page.getByRole('button', { name: 'Add an option' }).click()
    await page.getByLabel('Option name').last().fill(name)
  }
  await page.getByLabel('Name', { exact: true }).focus()
  await page.waitForTimeout(400)
  return page.getByRole('dialog')
})
await shot('fields-library', async () => {
  await clientWork()
  await page.goto(`${SITE}/#/account/fields`)
  await page.reload()
  await page.getByText('Contract signed', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  return { clip: { x: 0, y: 0, width: 1360, height: 600 } }
})
await shot('fields-2-board', async () => {
  const { id } = await clientWork()
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Website redesign', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('button', { name: 'Fields', exact: true }).click()
  await page.getByRole('switch', { name: 'Show Stage on cards' }).waitFor()
  await page.waitForTimeout(500)
  return page.getByRole('dialog')
})
await shot('fields-3-card', async () => {
  const { id } = await clientWork()
  await page.goto(`${SITE}/#/b/${id}/board?task=brand`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.getByLabel('Client').waitFor()
  await page.waitForTimeout(500)
  // The card's first section: a box for each of the board's fields.
  const { clip } = await around([card.locator('section').filter({ has: page.getByRole('heading', { name: 'Fields', exact: true }) })], 20)
  // (Up to the section's last box: the line under it belongs to the next one.)
  return { clip: { ...clip, height: clip.height - 18 } }
})
await shot('fields-4-front', async () => {
  const { id } = await clientWork()
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Website redesign', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  return around(
    [page.getByText('To Do', { exact: true }), page.getByText('Online shop', { exact: true }), page.getByText('Annual report', { exact: true })],
    36,
  )
})
await shot('fields-5-outline', async () => {
  const { id } = await clientWork()
  await page.goto(`${SITE}/#/b/${id}/outline`)
  await page.reload()
  await page.getByRole('table', { name: 'Tasks' }).waitFor()
  // (Fewer of the usual columns, so the board's own fit in the picture.)
  await page.getByRole('button', { name: 'Display' }).click()
  for (const name of ['Progress', 'Priority', 'Start', 'Due', 'Labels']) {
    const box = page.getByRole('dialog').getByLabel(name, { exact: true })
    if (await box.isChecked()) await box.click()
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const { clip } = await around([page.getByRole('table', { name: 'Tasks' })], 24)
  // (Down to the table's own edge: what's under it isn't the point.)
  return { clip: { ...clip, height: clip.height - 14 } }
})
await shot('fields-6-filter', async () => {
  const { id } = await clientWork()
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Website redesign', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  const menu = page.getByRole('dialog')
  await menu.getByRole('button', { name: 'Filter by Stage' }).click()
  await menu.getByText('Won', { exact: true }).click()
  await menu.getByRole('button', { name: 'Filter by Amount' }).click()
  await menu.getByLabel('Amount, at least').fill('5000')
  // (The menu scrolls: the fields are at its end.)
  await menu.getByRole('button', { name: 'Clear filters' }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  const whole = await menu.boundingBox()
  const top = await menu.getByText('Fields', { exact: true }).boundingBox()
  return { clip: { x: whole.x - 24, y: top.y - 24, width: whole.width + 48, height: whole.y + whole.height - top.y + 48 } }
})

// ── Links between cards: a Companies board, and a field on the client work board that points at its cards ────────
let linkedUp = null
/** Adds the Companies board and a "Company" card link to the client work board (made last: the pictures above don't have it). */
async function companies() {
  if (linkedUp) return linkedUp
  const { id } = await clientWork()
  const { id: firms } = await api(ann, 'POST', '/boards', { name: 'Companies', background: 'blue' })
  const add = (boardId, cardId, title) =>
    api(ann, 'POST', `/boards/${boardId}/mutations`, {
      mutationId: `g${stamp}-l-${n++}`,
      command: { type: 'task.create', id: cardId, parentId: null, fields: { title, status: 'todo' } },
    })
  for (const [cardId, title] of [
    ['northwind', 'Northwind'],
    ['acme', 'Acme'],
    ['hooli', 'Hooli'],
    ['globex', 'Globex'],
  ])
    await add(firms, cardId, title)
  const company = (await api(ann, 'POST', '/fields', { name: 'Company', type: 'link', linkTo: 'board', board: firms, back: 'Deals' })).id
  const now = (await api(ann, 'GET', `/boards/${id}/fields`)).fields
  await api(ann, 'PUT', `/boards/${id}/fields`, {
    fields: [{ id: company }, ...now.map((f) => ({ id: f.id, ...(f.front && { front: true }), ...(f.total && { total: true }) }))],
  })
  const link = (cardId, to) =>
    api(ann, 'POST', `/boards/${id}/mutations`, {
      mutationId: `g${stamp}-l-${n++}`,
      command: { type: 'task.update', id: cardId, fields: { custom: { [company]: [`${firms}:${to}`] } } },
    })
  await link('brand', 'acme')
  await link('report', 'acme')
  await link('redesign', 'northwind')
  return (linkedUp = { id, firms })
}
await shot('fields-7-link', async () => {
  const { id } = await companies()
  await page.goto(`${SITE}/#/b/${id}/board?task=shop`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.getByRole('button', { name: 'Add a card to Company' }).click()
  await page.getByLabel('Find a card for Company').fill('o')
  await page.getByRole('option', { name: /Hooli/ }).waitFor()
  await page.waitForTimeout(500)
  const { clip } = await around(
    [
      card.locator('section').filter({ has: page.getByRole('heading', { name: 'Fields', exact: true }) }),
      page.getByRole('listbox', { name: 'Cards' }),
    ],
    20,
  )
  return { clip }
})
await shot('fields-8-linked-from', async () => {
  const { firms } = await companies()
  await page.goto(`${SITE}/#/b/${firms}/board?task=acme`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  const section = card.locator('section').filter({ has: page.getByRole('heading', { name: 'Linked from', exact: true }) })
  await section.getByText('Brand refresh').waitFor()
  await page.waitForTimeout(500)
  const { clip } = await around([section], 20)
  // (From the section's own heading: the line above it belongs to the one before.)
  return { clip: { ...clip, y: clip.y + 14, height: clip.height - 14 } }
})

// ── People on a card, merging two fields, and a starter board (made last, like the rest of the fields' pictures) ──
await shot('fields-9-person', async () => {
  const { id } = await clientWork()
  await api(ann, 'POST', `/boards/${id}/invitations`, { email: `ben.ortiz+${stamp}@example.com`, role: 'editor' })
  const reviewer = (await api(ann, 'POST', '/fields', { name: 'Reviewer', type: 'person' })).id
  const team = (await api(ann, 'POST', '/fields', { name: 'Account team', type: 'person', many: true })).id
  const now = (await api(ann, 'GET', `/boards/${id}/fields`)).fields
  await api(ann, 'PUT', `/boards/${id}/fields`, {
    fields: [{ id: reviewer }, { id: team }, ...now.map((f) => ({ id: f.id, ...(f.front && { front: true }), ...(f.total && { total: true }) }))],
  })
  await api(ann, 'POST', `/boards/${id}/mutations`, {
    mutationId: `g${stamp}-p-${n++}`,
    command: { type: 'task.update', id: 'shop', fields: { custom: { [team]: [me.id, ben.id] } } },
  })
  await page.goto(`${SITE}/#/b/${id}/board?task=shop`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.getByRole('button', { name: 'Add someone to Reviewer' }).click()
  await page.getByRole('listbox', { name: 'People' }).getByRole('option').first().waitFor()
  await page.waitForTimeout(500)
  const { clip } = await around(
    [
      card.locator('section').filter({ has: page.getByRole('heading', { name: 'Fields', exact: true }) }),
      page.getByRole('listbox', { name: 'People' }),
    ],
    20,
  )
  return { clip }
})
await shot('fields-10-merge', async () => {
  const { id } = await clientWork()
  // A second field for the same thing, with a value or two, as happens.
  const twin = (await api(ann, 'POST', '/fields', { name: 'Client name', type: 'text' })).id
  const now = (await api(ann, 'GET', `/boards/${id}/fields`)).fields
  await api(ann, 'PUT', `/boards/${id}/fields`, {
    fields: [...now.map((f) => ({ id: f.id, ...(f.front && { front: true }), ...(f.total && { total: true }) })), { id: twin }],
  })
  for (const [cardId, value] of [
    ['report', 'Globex Ltd'],
    ['shop', 'Hooli'],
  ])
    await api(ann, 'POST', `/boards/${id}/mutations`, {
      mutationId: `g${stamp}-m-${n++}`,
      command: { type: 'task.update', id: cardId, fields: { custom: { [twin]: value } } },
    })
  await page.goto(`${SITE}/#/account/fields`)
  await page.reload()
  await page.getByRole('listitem').filter({ hasText: 'Client name' }).getByRole('button', { name: 'Merge' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Keep').click()
  await page.getByRole('option', { name: /^Client/ }).click()
  await dialog.getByText('This can’t be undone.').waitFor()
  await page.waitForTimeout(400)
  return dialog
})
await shot('fields-11-starter', async () => {
  const { id } = await api(ann, 'POST', '/boards', { name: 'Sales pipeline', template: 'sales', background: 'violet' })
  // (Five lists: a little wider than the usual window, so the last one is whole.)
  await page.setViewportSize({ width: 1500, height: 860 })
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Leads', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  return { clip: { x: 0, y: 0, width: 1500, height: 480 } }
})
await page.setViewportSize({ width: 1360, height: 860 })

// ── Fields in a workspace: Studio's own, and one of its boards choosing from them (last: its board gains fields) ──
let studioFields = false
/** A handful of fields for the Studio workspace, two of them on its board. */
async function fieldsInStudio() {
  if (studioFields) return
  const field = async (body) => (await api(ann, 'POST', `/workspaces/${studio}/fields`, body)).id
  const client = await field({ name: 'Client', type: 'text' })
  const budget = await field({ name: 'Budget', type: 'number', unit: '$', decimals: 0, sum: true })
  await field({
    name: 'Stage',
    type: 'choice',
    options: [
      { name: 'Brief', color: 'gray' },
      { name: 'In design', color: 'blue' },
      { name: 'Approved', color: 'green' },
    ],
  })
  await field({ name: 'Approved by', type: 'person' })
  await field({ name: 'Contract signed', type: 'checkbox' })
  await api(ann, 'PUT', `/boards/${clientBoard}/fields`, { fields: [{ id: client, front: true }, { id: budget }] })
  studioFields = true
}
await shot('ws-2-fields', async () => {
  await fieldsInStudio()
  await page.goto(`${SITE}/#/w/${studio}/fields`)
  await page.reload()
  await page.getByText('Contract signed', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  await ring(page.getByRole('tab', { name: 'Fields' }), page.getByRole('button', { name: 'New field' }))
  return { clip: { x: 0, y: 0, width: 1360, height: 610 } }
})
await shot('ws-3-board-fields', async () => {
  await fieldsInStudio()
  await page.goto(`${SITE}/#/b/${clientBoard}/board`)
  await page.reload()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('button', { name: 'Fields', exact: true }).click()
  await page.getByRole('switch', { name: 'Show Client on cards' }).waitFor()
  await page.getByRole('button', { name: 'Add a field' }).click()
  await page.getByText('New field…').waitFor()
  await page.waitForTimeout(500)
  // (The settings window and, over it, the list of fields to pick from.)
  return around([page.getByRole('dialog').first(), page.getByRole('dialog').last()], 20)
})

await browser.close()
console.log(`made ${made.length}: ${made.join(', ')}`)
if (failed.length) console.log(`\nnot made (${failed.length}):\n  ${failed.join('\n  ')}`)
