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
// (Keys are named as on a Mac, wherever the pictures are taken: ⌘K in the account menu.)
await ctx.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
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
/**
 * A card's dates: the Dates tile under its title opens Start, Due, Reminders and Timeline color (the box isn't inside
 * the card's own element, so it's found on the page).
 */
const openDates = async (card) => {
  await card.getByRole('button', { name: /^Dates/ }).click()
  const box = page.locator('[data-slot=popover-content]').filter({ hasText: 'Reminders' })
  await box.waitFor()
  await page.waitForTimeout(300)
  return box
}
/** The button a date is shown on, in the Dates box ("Due", "Start"). */
const dateButton = (box, label) => box.getByText(label, { exact: true }).locator('..').getByRole('button').first()
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
    { above: page.getByLabel('Search tasks') },
    { above: page.getByRole('button', { name: 'Share' }) },
    { above: page.getByRole('button', { name: 'More' }) },
    page.getByRole('button', { name: 'New task' }),
    { above: page.locator('button[aria-pressed][aria-label^="Inbox"]') },
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
  const box = await openDates(card)
  await dateButton(box, 'Due').click()
  await page.waitForTimeout(600)
  return around([card.getByRole('button', { name: /^Dates/ }), page.getByPlaceholder(/Type a date/), page.getByText('Add time'), box], 36)
})
await shot('reminders', async () => {
  const card = await openCard('announce')
  const box = await openDates(card)
  await box.getByRole('button', { name: 'Add a reminder' }).click()
  await page.waitForTimeout(600)
  return around([card.getByRole('button', { name: /^Dates/ }), box, page.getByPlaceholder(/tmr 10:00/), page.getByText('2 days before')], 36)
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
      card.getByRole('tab', { name: /Comments/ }),
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
      card.getByText('Waiting on', { exact: true }),
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
  await page.setViewportSize({ width: 1360, height: 1340 })
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.waitForTimeout(500)
  return { clip: { x: 760, y: 50, width: 600, height: 1270 } }
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
  // (The section further down the card, not the Time logged box at its top, which says the same total.)
  const section = card.locator('section').filter({ has: page.getByRole('heading', { name: 'Time', exact: true }) })
  await section.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
  return around([section], 20)
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
  // (Ann made the card, so she follows it: the button at the top of the card says so.)
  const card = await openCard('newsletter')
  const following = card.getByRole('button', { name: 'Following', exact: true })
  await following.waitFor()
  await ring(following)
  // (Down to the row of boxes, so it's clear which part of the card this is.)
  return around(
    [
      card.getByRole('navigation'),
      card.getByLabel('Title'),
      following,
      card.getByRole('button', { name: 'Close' }),
      card.getByRole('button', { name: /^Dates/ }),
    ],
    24,
  )
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
  // (A description saves as it is written, a few seconds behind the keys. More is typed, and the page reloads before
  // it is saved: the card offers the writing back.)
  await page.keyboard.type(' And where the visitors come from.')
  await page.waitForTimeout(600)
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
  const box = await openDates(card)
  await ring(dateButton(box, 'Due'))
  return around([card.getByRole('button', { name: /^Dates/ }), box], 40)
})
await shot('date-2-typed', async () => {
  const card = await openCard('analytics')
  await dateButton(await openDates(card), 'Due').click()
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
// (The starters are made in a workspace of their own: its fields are only theirs, so each has the name the starter
// gives it, and they share that workspace's board of clients.)
let shopSpace = null
const starters = {}
async function starter(kind, name, background) {
  shopSpace ??= (await api(ann, 'POST', '/workspaces', { name: 'Northside' })).id
  return (starters[kind] ??= (await api(ann, 'POST', '/boards', { name, template: kind, background, workspaceId: shopSpace })).id)
}
await shot('fields-11-starter', async () => {
  const id = await starter('sales', 'Sales pipeline', 'violet')
  // (Five lists: a little wider than the usual window, so the last one is whole.)
  await page.setViewportSize({ width: 1500, height: 860 })
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Leads', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  return { clip: { x: 0, y: 0, width: 1500, height: 480 } }
})
await page.setViewportSize({ width: 1360, height: 860 })
await shot('fields-12-bookings', async () => {
  const id = await starter('bookings', 'Bookings', 'teal')
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Booked', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  return { clip: { x: 0, y: 0, width: 1360, height: 560 } }
})
await shot('fields-13-client', async () => {
  // (Dana Keller has an order at the shop and two bookings at the salon: her card lists all three.)
  await starter('store', 'Store orders', 'orange')
  await starter('bookings', 'Bookings', 'teal')
  const clients = (await api(ann, 'GET', '/boards')).boards.find((b) => b.workspaceId === shopSpace && b.name === 'Clients')
  const cards = Object.values((await api(ann, 'GET', `/boards/${clients.id}`)).data.tasks)
  const dana = cards.find((c) => c.title === 'Dana Keller')
  // (A taller window: the list of what points at her is at the end of the card.)
  await page.setViewportSize({ width: 1360, height: 1180 })
  await page.goto(`${SITE}/#/b/${clients.id}/board?task=${dana.id}`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  const section = card.locator('section').filter({ has: page.getByRole('heading', { name: 'Linked from', exact: true }) })
  await section.getByText('Order 1042: Dana Keller').waitFor()
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  const { clip } = await around([section], 20)
  // (From the section's own heading: the line above it belongs to the one before.)
  return { clip: { ...clip, y: clip.y + 14, height: clip.height - 14 } }
})
await page.setViewportSize({ width: 1360, height: 860 })
// The Outline's columns, one being dragged in front of another (the line shows where it lands).
await shot('outline-columns', async () => {
  const id = await starter('sales', 'Sales pipeline', 'violet')
  await page.goto(`${SITE}/#/b/${id}/outline`)
  await page.reload()
  await page.getByRole('table', { name: 'Tasks' }).waitFor()
  const header = (name) => page.locator('[role="columnheader"]', { hasText: new RegExp(`^${name}$`) })
  const from = await header('Deal value').boundingBox()
  const to = await header('Status').boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 })
  await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 12 })
  await page.waitForTimeout(300)
  const { clip } = await around([page.getByRole('table', { name: 'Tasks' })], 24)
  return { clip: { ...clip, height: Math.min(clip.height, 330) } }
})
await page.mouse.up()

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

// ── Webhooks: a board that tells another app (the site has to allow them: needs GUIDES_SQL, for an admin) ──────────
let hooked = null
/** A place for the sample board's webhook to go: a little server here that answers yes, and the site set to allow it. */
async function listener() {
  if (hooked) return hooked
  if (!aged) throw new Error('webhooks have to be turned on by a site admin: set GUIDES_SQL')
  await api(ann, 'PATCH', '/admin/settings', { webhooks: 'any' })
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  server.unref()
  return (hooked = `http://127.0.0.1:${server.address().port}/kanbanto`)
}
/** The pictures show an address and a secret that could be anyone's, not this run's. */
const asInTheGuide = (address, shown = 'https://hooks.example.com/kanbanto') =>
  page.evaluate(
    ([from, to]) => {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.replaceAll(from, to)
      for (const el of document.querySelectorAll('input')) if (el.value.startsWith('whsec_')) el.value = 'whsec_Xk3v9QmT7LwA2pRZ8cYdN4hJ6sBf0uGe'
    },
    [address, shown],
  )
const openWebhooks = async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('button', { name: 'People & apps', exact: true }).click()
  await page.getByLabel('Webhook address').waitFor()
}
await shot('hooks-1-add', async () => {
  const address = await listener()
  await openWebhooks()
  await page.getByLabel('Webhook address').fill(address)
  await page.getByLabel('Webhook address').press('Enter')
  await page.getByLabel('Signing secret').waitFor()
  await page.waitForTimeout(400)
  await asInTheGuide(address)
  return page.getByRole('dialog')
})
await shot('hooks-2-detail', async () => {
  const address = await listener()
  // (Something to have sent: a card finished and a comment on it.)
  if (!(await api(ann, 'GET', `/boards/${board}/webhooks`)).webhooks.length) await api(ann, 'POST', `/boards/${board}/webhooks`, { url: address })
  await run({ type: 'task.update', id: 'analytics', fields: { status: 'done' } })
  await api(ann, 'POST', `/boards/${board}/tasks/analytics/comments`, { body: 'Counting since this morning.' })
  await page.waitForTimeout(6500)
  await openWebhooks()
  await page.getByRole('button', { name: new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
  await page.getByRole('button', { name: 'Send a test' }).click()
  await page.getByText('Delivered (200)').first().waitFor()
  // (The "Test delivered" message goes away by itself: wait for it, then open the test's own line.)
  await page.waitForTimeout(5000)
  await page.getByRole('button', { name: /ping/ }).first().click()
  await page.getByRole('button', { name: 'Send again' }).waitFor()
  await page.waitForTimeout(300)
  await asInTheGuide(address)
  return page.getByRole('dialog')
})

// A webhook to a chat channel: Slack's words on the screen, the little server above at the other end (the site
// allows any address for these pictures, so a chat webhook's address needn't be the chat app's own).
const SLACK = 'https://hooks.slack.com/services/T024BE7LD/B08N3QX4Z/…'
/** The addresses on the screen as they'd be for real: Slack's for the chat webhook, a made-up one for the other, and a made-up site. */
const chatAsInTheGuide = async (address) => {
  await asInTheGuide(`${address}-chat`, SLACK)
  await asInTheGuide(address)
  await asInTheGuide(SITE, 'https://kanbanto.example.com')
}
await shot('hooks-3-chat-add', async () => {
  const address = await listener()
  await openWebhooks()
  await page.getByRole('combobox', { name: 'Send to' }).click()
  await page.getByRole('option', { name: 'Slack' }).click()
  await page.getByLabel('The channel’s address').fill(`${address}-chat`)
  await page.getByLabel('The channel’s address').press('Enter')
  await page.getByText('Added. Look in the channel').waitFor()
  await page.waitForTimeout(400)
  await chatAsInTheGuide(address)
  return page.getByRole('dialog')
})
await shot('hooks-4-chat-detail', async () => {
  const address = await listener()
  const chat = `${address}-chat`
  if (!(await api(ann, 'GET', `/boards/${board}/webhooks`)).webhooks.some((h) => h.url === chat))
    await api(ann, 'POST', `/boards/${board}/webhooks`, { url: chat, format: 'slack' })
  // (Something to have said: a card moved along, and a comment on it.)
  await run({ type: 'task.update', id: 'pricing', fields: { status: 'doing' } })
  await api(ann, 'POST', `/boards/${board}/tasks/pricing/comments`, { body: 'The three plans are in. Numbers still to check.' })
  await page.waitForTimeout(6500)
  await openWebhooks()
  await page.getByRole('button', { name: /-chat/ }).click()
  await page.getByText('Delivered (200)').first().waitFor()
  await page
    .getByRole('button', { name: /board\.changed/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Send again' }).waitFor()
  await page.waitForTimeout(300)
  await chatAsInTheGuide(address)
  return page.getByRole('dialog')
})

// ── A board's Telegram bot. The site has to talk to a stand-in for Telegram (see telegram.mjs): GUIDES_TELEGRAM is
// its address, and this script plays the people in the chat through it. Needs GUIDES_SQL too, for an admin. ─────────
const TELEGRAM = process.env.GUIDES_TELEGRAM
/** A bot as @BotFather would have made it: a token of the right shape, which the stand-in names after its end. */
const botToken = (name, k) => `${String(stamp + k).slice(-9)}:AAHq3vT9LwA2pRZ8cYdN4hJ6sBf0uGe_bot_${name}`
const inChat = (token, chat, from, text) =>
  fetch(`${TELEGRAM}/say/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: JSON.stringify({ message: { message_id: Date.now() % 1e6, date: Math.floor(Date.now() / 1000), chat, from, text } }),
  })
const ANN_TG = { id: 5010, first_name: 'Ann', last_name: 'Lee' }
const telegramOn = async () => {
  if (!TELEGRAM) throw new Error('set GUIDES_TELEGRAM to the stand-in the site talks to (node shots/telegram.mjs)')
  await listener()
  await api(ann, 'PATCH', '/admin/settings', { telegramBots: true })
}
const launchBot = botToken('acme_launch_bot', 1)
await shot('telegram-1-add', async () => {
  await telegramOn()
  await openWebhooks()
  await page.getByLabel('The bot’s token').fill(launchBot)
  // (The whole Telegram box in view, and any webhooks above it with addresses as they'd be for real.)
  await page.getByText('One bot serves one board.').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await chatAsInTheGuide(await listener())
  return page.getByRole('dialog')
})
await shot('telegram-2-connect', async () => {
  await telegramOn()
  await openWebhooks()
  await page.getByLabel('The bot’s token').fill(launchBot)
  await page.getByLabel('The bot’s token').press('Enter')
  await page.getByText('Connect a chat: send the bot this code').waitFor()
  await page.waitForTimeout(300)
  return page.getByRole('dialog')
})
await shot('telegram-3-connected', async () => {
  await telegramOn()
  // (The bot's page is open from the picture before, its code on it; Ann sends it from the team's group.)
  if (!(await page.getByLabel('The message that connects a chat').count())) throw new Error('take telegram-2-connect in the same run')
  const start = await page.getByLabel('The message that connects a chat').inputValue()
  await inChat(launchBot, { id: -90010, type: 'group', title: 'Launch team' }, ANN_TG, start.replace('/start', '/start@acme_launch_bot'))
  await page.getByText('Connected to Launch team').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(400)
  return page.getByRole('dialog')
})
await shot('telegram-4-news', async () => {
  await telegramOn()
  const mine = botToken('ann_inbox_bot', 2)
  const { boardId } = await api(ann, 'POST', '/inbox')
  const { connect } = await api(ann, 'POST', `/boards/${boardId}/webhooks`, { format: 'telegram', token: mine })
  await inChat(mine, { id: ANN_TG.id, type: 'private', first_name: 'Ann' }, ANN_TG, `/start ${connect.code}`)
  await page.waitForTimeout(3000)
  await page.goto(`${SITE}/#/account/notifications`)
  await page.reload()
  await page.getByText('Through @ann_inbox_bot').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(500)
  const card = page.getByText('Through @ann_inbox_bot').locator('xpath=ancestor::*[contains(@class,"rounded")][1]')
  await card.scrollIntoViewIfNeeded()
  return around([card], 16)
})

// ── Add from anywhere: the bookmark button's page, and the little window it opens (also what a phone's Share opens) ──
await shot('add-1-button', async () => {
  await page.goto(`${SITE}/#/account/add`)
  await page.reload()
  await page.getByText('Add to Kanbanto', { exact: true }).waitFor()
  await page.waitForTimeout(500)
})
const HANDED = { title: 'Pricing – Acme', url: 'https://acme.example/pricing', text: 'Teams pay per seat, billed yearly.' }
await shot('add-2-window', async () => {
  await page.goto(`${SITE}/#/add?w=1&${new URLSearchParams(HANDED)}`)
  await page.reload()
  await page.getByLabel('Title').waitFor()
  await page.waitForTimeout(500)
  return around([page.getByRole('heading', { name: 'Add a card' }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')], 28)
})
await shot('add-3-phone', async () => {
  // (What Share sends from a phone: a link as text, which the page finds and files under the title.)
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto(`${SITE}/share?${new URLSearchParams({ title: 'Acme pricing', text: 'Look at this https://acme.example/pricing' })}`)
  await page.getByLabel('Title').waitFor()
  await page.waitForTimeout(500)
  return { clip: { x: 0, y: 0, width: 390, height: 520 } }
})
await page.setViewportSize({ width: 1360, height: 860 })

// ── The Timeline as a calendar: a board of bookings, where cards are on a day more than they last days ───────────
let salon = null
const salonBoard = async () => {
  if (salon) return salon
  const { id } = await api(ann, 'POST', '/boards', { name: 'Salon bookings', background: 'teal' })
  let k = 0
  const put = (command) => api(ann, 'POST', `/boards/${id}/mutations`, { mutationId: `s${stamp}-${k++}`, command })
  const card = (cid, title, fields = {}, parentId = null) => put({ type: 'task.create', id: cid, parentId, fields: { title, ...fields } })
  // (A time on this computer's clock, as someone typing it means it.)
  const at = (n, time) => new Date(`${day(n)}T${time}:00`).toISOString()
  await put({ type: 'board.update', fields: { mode: 'manual' } })
  const NAMES = [
    'Mai S. · Haircut',
    'Ben O. · Colour',
    'Nok P. · Manicure',
    'June T. · Facial',
    'Tom H. · Beard trim',
    'Fah R. · Massage',
    'Dao L. · Haircut',
  ]
  const TIMES = ['09:00', '10:30', '13:00', '14:30', '16:00', '17:30']
  const PER_DAY = [3, 2, 5, 3, 4, 2, 0, 3, 4, 2, 3, 5, 1, 0, 2, 3, 1, 2]
  let b = 0
  for (const [i, count] of PER_DAY.entries()) {
    const n = i - 4
    for (let j = 0; j < count; j++, b++)
      await card(`bk${b}`, NAMES[b % NAMES.length], {
        due: at(n, TIMES[(j * 2 + i) % TIMES.length]),
        status: n < 0 ? 'done' : 'todo',
        ...(b % 2 === 0 && { assigneeId: me.id }),
      })
  }
  await card('order', 'Order #1114', { due: day(0), status: 'doing' })
  for (const [i, t] of ['Shampoo x2', 'Hair oil', 'Gift wrap'].entries()) await card(`order-${i}`, t, { status: i ? 'todo' : 'done' }, 'order')
  await card('refit', 'Shop refit', { start: day(-1), due: day(8), status: 'doing' })
  await card('refit-1', 'Order mirrors', { due: day(-1), status: 'done' }, 'refit')
  await card('refit-2', 'Painter comes', { due: at(1, '09:00') }, 'refit')
  await card('refit-3', 'Fit new lights', { due: day(3) }, 'refit')
  await card('refit-4', 'Deep clean', { due: at(8, '17:00') }, 'refit')
  await card('away', 'Bo away', { start: day(4), due: day(6) })
  await card('idea', 'Think about a loyalty card')
  return (salon = id)
}
const openCalendar = async (range, subtasks = false) => {
  const id = await salonBoard()
  await page.goto(`${SITE}/#/b/${id}/timeline`)
  await page.reload()
  await page.getByRole('radio', { name: 'Calendar' }).click()
  await page.getByRole('heading', { level: 2 }).waitFor()
  await page.getByRole('radio', { name: range, exact: true }).click()
  await page.getByRole('button', { name: 'Display' }).click()
  const sub = page.getByRole('switch', { name: /subtasks/i })
  if (((await sub.getAttribute('aria-checked')) === 'true') !== subtasks) await sub.click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.waitForTimeout(500)
}
await shot('timeline-cal-1-month', async () => {
  await openCalendar('Month')
  await ring(page.getByRole('radio', { name: 'Calendar' }))
})
await shot('timeline-cal-2-week', async () => {
  await openCalendar('Week', true)
  return { clip: { x: 0, y: 0, width: 1360, height: 640 } }
})
await shot('timeline-cal-3-add', async () => {
  await openCalendar('2 weeks')
  const cell = page.locator(`[data-day="${day(2)}"]`)
  await cell.hover()
  await cell.getByRole('button', { name: /^Add a card on/ }).click()
  await page.keyboard.type('Call Sam 3pm')
  await page.waitForTimeout(300)
  return around([cell, page.locator(`[data-day="${day(1)}"]`), page.locator(`[data-day="${day(3)}"]`)], 12)
})
await page.keyboard.press('Escape')
await shot('timeline-cal-4-phone', async () => {
  await page.setViewportSize({ width: 390, height: 760 })
  await openCalendar('Month')
})
await page.setViewportSize({ width: 1360, height: 860 })

// ── Bring your work in: a Trello board (a made-up export), and cards from pasted rows ─────────────────────────────
const TRELLO = {
  name: 'Shop opening',
  desc: 'Everything before the doors open in November.',
  prefs: { background: 'green' },
  lists: [
    ['tl1', 'Ideas'],
    ['tl2', 'To do'],
    ['tl3', 'Doing'],
    ['tl4', 'With the printer'],
    ['tl5', 'Done'],
  ]
    .map(([id, name], i) => ({ id, name, pos: i + 1, closed: false }))
    .concat([{ id: 'tl6', name: 'Last year', pos: 9, closed: true }]),
  labels: [
    { id: 'tb1', name: 'Shopfront', color: 'orange' },
    { id: 'tb2', name: 'Paperwork', color: 'purple' },
  ],
  members: [{ id: 'tm1', fullName: 'Dana Reyes', username: 'dana' }],
  customFields: [],
  checklists: [
    {
      id: 'tk1',
      idCard: 'tc3',
      name: 'Before opening day',
      pos: 1,
      checkItems: ['Measure the window', 'Choose the lettering', 'Send the artwork'].map((name, i) => ({
        id: `ti${i}`,
        name,
        pos: i,
        state: i < 2 ? 'complete' : 'incomplete',
      })),
    },
  ],
  cards: [
    ['tc1', 'A loyalty card', 'tl1'],
    ['tc2', 'Opening-week offer', 'tl1'],
    ['tc3', 'Sign for the window', 'tl4'],
    ['tc4', 'Order the till', 'tl2'],
    ['tc5', 'Hire weekend staff', 'tl2'],
    ['tc6', 'Paint the back wall', 'tl3'],
    ['tc7', 'Register the business', 'tl5'],
    ['tc8', 'Sign the lease', 'tl5'],
    ['tc9', 'Christmas window 2025', 'tl6'],
  ].map(([id, name, idList], i) => ({
    id,
    name,
    idList,
    pos: i,
    desc: '',
    idLabels: id === 'tc3' ? ['tb1'] : id === 'tc7' ? ['tb2'] : [],
    idMembers: id === 'tc3' || id === 'tc5' ? ['tm1'] : [],
    badges: { comments: id === 'tc3' ? 2 : id === 'tc7' ? 1 : 0 },
    attachments:
      id === 'tc3'
        ? [{ name: 'window-sketch.pdf', url: 'https://trello.com/1/cards/tc3/attachments/a1/download/window-sketch.pdf', isUpload: true }]
        : [],
    dateLastActivity: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
  })),
  actions: [
    ['tc3', 'The printer needs the artwork by Friday.'],
    ['tc3', 'Sent. They will call when it is ready.'],
    ['tc7', 'Certificate arrived by post.'],
  ].map(([id, text], i) => ({
    type: 'commentCard',
    date: new Date(Date.now() - (9 - i) * 86_400_000).toISOString(),
    data: { text, card: { id } },
    memberCreator: { fullName: 'Dana Reyes' },
  })),
}
await shot('import-1-trello', async () => {
  await page.goto(`${SITE}/#/`)
  await page.reload()
  await page.getByText('Website launch').first().waitFor()
  await page.locator('input[type=file][accept*="json"]').setInputFiles({
    name: 'shop-opening.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(TRELLO)),
  })
  const dialog = page.getByRole('dialog')
  await dialog.getByText('What comes over').waitFor()
  await page.waitForTimeout(500)
  return dialog
})
await page.keyboard.press('Escape')
// (Nothing is added: the pictures are of the screen before the button is pressed.)
const ROWS = [
  ['Task', 'Deadline', 'Tags', 'Owner', 'Status'],
  ['Book the photographer', '3/11/2026', 'Marketing', 'Ben Ortiz', 'To Do'],
  ['Write the press release', '5/11/2026', 'Marketing, Press', 'Ben Ortiz', 'To Do'],
  ['Order printed flyers', 'next week', 'Print', 'Sam', 'Waiting on supplier'],
  ['Update the price list', '10/11/2026', '', '', 'Doing'],
]
  .map((r) => r.join('\t'))
  .join('\n')
const openImport = async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Import cards…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Rows pasted from a spreadsheet').fill(ROWS)
  await dialog.getByText('Which way round are the dates?').waitFor()
  return dialog
}
await shot('import-3-dates', async () => {
  const dialog = await openImport()
  return around([dialog.getByText('Which way round are the dates?'), dialog.getByRole('button', { name: /^Month first/ })], 28)
})
await page.keyboard.press('Escape')
await shot('import-2-cards', async () => {
  const dialog = await openImport()
  await dialog.getByRole('button', { name: /^Day first/ }).click()
  await dialog.getByText(/will be added/).waitFor()
  await page.waitForTimeout(400)
  return dialog
})
await page.keyboard.press('Escape')

// ── Your Inbox: the panel beside the board (made last: it stays open from page to page, and files a card) ─────────
const { boardId: inbox } = await api(ann, 'POST', '/inbox')
let notes = 0
const note = (id, title, status, fields = {}) =>
  api(ann, 'POST', `/boards/${inbox}/mutations`, {
    mutationId: `n${stamp}-${notes++}`,
    command: { type: 'task.create', id, parentId: null, fields: { title, status, ...fields } },
  })
if (!only.length || only.some((w) => 'inbox'.includes(w) || w.includes('inbox'))) {
  await note('printer', 'Call the printer about the banner', 'todo', { due: day(1) })
  await note('referral', 'Idea: a page for referrals', 'todo')
  await note('budget', 'Ask Ben about the photo budget', 'todo')
  await note('guide', 'Read the brand guide', 'doing')
  await note('desk', 'Book a desk for Friday', 'done')
}
const tray = page.locator('button[aria-pressed][aria-label^="Inbox"]')
const inboxPanel = page.locator('aside[aria-label="Inbox"]')
await shot('inbox-1-open', async () => {
  await openBoard()
  await tray.click()
  await inboxPanel.getByText('Read the brand guide').waitFor()
  await ring(tray)
})
await shot('inbox-2-drag', async () => {
  // A card on its way from the Inbox to the board's To Do list, held mid-air.
  await openBoard()
  await inboxPanel.getByText('Idea: a page for referrals').waitFor()
  const from = await inboxPanel.getByText('Idea: a page for referrals').boundingBox()
  const to = await page.getByText('Fix the sign-up form on phones', { exact: true }).first().boundingBox()
  await page.mouse.move(from.x + 60, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(from.x + 90, from.y + 30, { steps: 5 })
  await page.mouse.move(to.x + 40, to.y - 14, { steps: 14 })
  await page.waitForTimeout(400)
  return { clip: { x: 0, y: 0, width: 1120, height: 560 } }
})
await page.keyboard.press('Escape')
await page.mouse.up()
await shot('inbox-3-menu', async () => {
  await openBoard()
  await inboxPanel.getByRole('button', { name: 'Ask Ben about the photo budget options' }).click()
  await page.getByRole('menu').waitFor()
  await ring(page.getByRole('menuitem', { name: /Move to “Website launch”/ }))
  return around([inboxPanel.getByText('Call the printer about the banner'), page.getByRole('menu')], 40)
})
await page.keyboard.press('Escape')
await shot('inbox-4-phone', async () => {
  await page.setViewportSize({ width: 390, height: 760 })
  await openBoard()
  await tray.click()
  await inboxPanel.getByText('Read the brand guide').waitFor()
  await page.waitForTimeout(400)
})
await page.setViewportSize({ width: 1360, height: 860 })

// ── A card's history: last of all, since it changes a card and no picture after it shows the board ──────
await shot('history', async () => {
  const change = (who, fields) =>
    api(who, 'POST', `/boards/${board}/mutations`, { mutationId: `g${stamp}-h-${n++}`, command: { type: 'task.update', id: 'quotes', fields } })
  // Ben picks it up; later Ann takes it over. (Each person's changes, minutes apart, read as one visit.)
  await change(benCtx, { status: 'doing' })
  await change(benCtx, { priority: 'high', labels: ['writing'] })
  await api(benCtx, 'POST', `/boards/${board}/tasks/quotes/time`, { minutes: 90, day: day(0) })
  await change(ann, { assigneeId: me.id, due: day(4) })
  await change(ann, { description: 'Two quotes for the launch announcement: one from a shop, one from a club.' })
  const card = await openCard('quotes')
  await card.getByRole('tab', { name: 'History' }).click()
  await card.getByRole('list', { name: 'History' }).waitFor()
  await page.waitForTimeout(400)
  return around([card.getByRole('tablist'), card.getByRole('list', { name: 'History' }), card.getByText('History goes back 180 days.')], 24)
})

// ── Card numbers, covers and the board's rules: after everything else, since they change how the board looks ──────

/** The board as the server has it now (its letters, each card's number, its lists and rules). */
const boardNow = async () => (await api(ann, 'GET', `/boards/${board}`)).data
/** A card's name, like WEB-3. */
const nameOf = (data, id) => `${data.board.code}-${data.tasks[id].number}`
/** A switch in the Display menu, turned on or off (the menu is left open). */
const display = async (label, on) => {
  await page.getByRole('button', { name: 'Display' }).click()
  const sw = page.getByRole('switch', { name: label })
  await sw.waitFor()
  if (((await sw.getAttribute('aria-checked')) === 'true') !== on) await sw.click()
  await page.waitForTimeout(300)
  return sw
}

await shot('number-1-card', async () => {
  const card = await openCard('announce')
  const name = card.getByRole('button', { name: /copy a link to this card/ })
  await ring(name)
  return around([card.getByRole('navigation'), card.getByLabel('Title'), name, card.getByRole('button', { name: /^Dates/ })], 24)
})
await shot('number-2-board', async () => {
  await openBoard()
  const sw = await display('Card numbers', true)
  await ring(sw)
  return { clip: { x: 300, y: 50, width: 1060, height: 640 } }
})
// (Off again: the pictures after this one show the board as it starts.)
if (made.includes('number-2-board')) {
  await openBoard()
  await display('Card numbers', false)
  await page.keyboard.press('Escape')
}
await shot('number-3-letters', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.locator('#board-letters').waitFor()
  await page.locator('#board-letters').scrollIntoViewIfNeeded()
  await ring(page.locator('#board-letters'))
  return page.getByRole('dialog')
})
/** What was typed in a description and not saved is kept in the browser: forgotten, so a card opens as it is. */
const forgetDrafts = async () => {
  await page.goto(`${SITE}/#/`)
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('kankan:draft:')) localStorage.removeItem(key)
  })
}
/** A card's empty description, opened for writing, with a few words and then "/". */
const slashIn = async (id, words) => {
  // (Leaving the editor saves what was typed: the picture before this one may have left its words on the card.
  // So the editor is left first, then the card is emptied.)
  await forgetDrafts()
  await page.waitForTimeout(600)
  await run({ type: 'task.update', id, fields: { description: '' } })
  await forgetDrafts()
  const card = await openCard(id)
  await card.getByRole('button', { name: /Add more detail/ }).click()
  await page.getByRole('textbox', { name: 'Description' }).waitFor()
  await page.waitForTimeout(400)
  await page.keyboard.type(words)
  await page.keyboard.type('/')
  await page.getByRole('listbox', { name: 'Put in' }).waitFor()
  return card
}
await shot('mention-1-menu', async () => {
  const card = await slashIn('photographer', 'Wait for the brief: ')
  const entry = page.getByRole('listbox', { name: 'Put in' }).getByRole('option').first()
  await ring(entry)
  return around([card.getByText('Description', { exact: true }), page.getByRole('listbox', { name: 'Put in' })], 28)
})
await shot('mention-2-cards', async () => {
  const card = await slashIn('photographer', 'Wait for the brief: ')
  await page.getByRole('listbox', { name: 'Put in' }).getByRole('option').first().click()
  await page.getByLabel('Mention a card').waitFor()
  await page.getByLabel('Find a card').fill('hero')
  await page.waitForTimeout(600)
  return around([card.getByText('Description', { exact: true }), page.getByLabel('Mention a card')], 28)
})
await shot('mention-3-link', async () => {
  const data = await boardNow()
  await forgetDrafts()
  await page.waitForTimeout(600)
  await run({
    type: 'task.update',
    id: 'photographer',
    fields: {
      description: `Wait for the brief: ${nameOf(data, 'hero')} says what the pictures are for, and ${nameOf(data, 'announce')} is where they go.`,
    },
  })
  const card = await openCard('photographer')
  const link = card.getByRole('link', { name: nameOf(data, 'hero') })
  await link.waitFor()
  await link.hover()
  await page.waitForTimeout(700)
  await ring(link)
  return around([card.getByText('Description', { exact: true }), link, card.getByText(/where they go/)], 36)
})

// Pictures to attach: drawn here, so the script needs no files of its own.
const drawing = (inner, bg) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="${bg}"/>${inner}</svg>`))
    .png()
    .toBuffer()
const DRAWINGS = {
  // A homepage: a top bar, a headline, a button and a picture.
  'homepage-draft.png': () =>
    drawing(
      `<rect width="1280" height="84" fill="#1e3a8a"/><rect x="60" y="30" width="150" height="24" rx="6" fill="#bfdbfe"/><rect x="920" y="32" width="80" height="20" rx="6" fill="#93c5fd"/><rect x="1030" y="32" width="80" height="20" rx="6" fill="#93c5fd"/><rect x="1140" y="32" width="80" height="20" rx="6" fill="#93c5fd"/><rect x="80" y="210" width="480" height="56" rx="10" fill="#1e293b"/><rect x="80" y="290" width="380" height="56" rx="10" fill="#1e293b"/><rect x="80" y="390" width="440" height="20" rx="6" fill="#94a3b8"/><rect x="80" y="424" width="360" height="20" rx="6" fill="#94a3b8"/><rect x="80" y="500" width="200" height="64" rx="14" fill="#2563eb"/><rect x="700" y="170" width="500" height="430" rx="24" fill="#bfdbfe"/><circle cx="1060" cy="290" r="54" fill="#fde68a"/><path d="M700 600 L880 400 L1000 520 L1090 440 L1200 560 L1200 576 Q1200 600 1176 600 Z" fill="#60a5fa"/>`,
      '#eff6ff',
    ),
  // A sign-up box: a few words, a field and a button.
  'signup-box.png': () =>
    drawing(
      `<rect x="290" y="150" width="700" height="420" rx="28" fill="#ffffff" stroke="#fdba74" stroke-width="6"/><rect x="360" y="220" width="420" height="40" rx="8" fill="#1e293b"/><rect x="360" y="286" width="520" height="20" rx="6" fill="#94a3b8"/><rect x="360" y="320" width="400" height="20" rx="6" fill="#94a3b8"/><rect x="360" y="400" width="380" height="72" rx="12" fill="#fff7ed" stroke="#fdba74" stroke-width="4"/><rect x="760" y="400" width="160" height="72" rx="12" fill="#ea580c"/>`,
      '#ffedd5',
    ),
  // A phone with a form on it.
  'phone-form.png': () =>
    drawing(
      `<rect x="470" y="60" width="340" height="600" rx="44" fill="#0f172a"/><rect x="490" y="110" width="300" height="500" rx="14" fill="#f8fafc"/><rect x="520" y="160" width="180" height="26" rx="6" fill="#1e293b"/><rect x="520" y="220" width="240" height="52" rx="10" fill="#e2e8f0"/><rect x="520" y="296" width="240" height="52" rx="10" fill="#e2e8f0"/><rect x="520" y="372" width="240" height="52" rx="10" fill="#fecaca" stroke="#dc2626" stroke-width="4"/><rect x="520" y="470" width="240" height="60" rx="12" fill="#16a34a"/>`,
      '#dcfce7',
    ),
}
/** Attaches drawn pictures to a card that is open, and waits for them to be listed. */
const attach = async (card, names) => {
  const files = []
  for (const name of names) files.push({ name, mimeType: 'image/png', buffer: await DRAWINGS[name]() })
  await card.locator('input[type=file]').first().setInputFiles(files)
  for (const name of names) await card.getByText(name).first().waitFor()
  await page.waitForTimeout(500)
}
/** Makes one of an open card's pictures its cover, with its button (which shows when the row is pointed at). */
const useAsCover = async (card, name) => {
  const row = card.locator('li, [class*=group]').filter({ hasText: name }).last()
  await row.hover()
  await row.getByRole('button', { name: 'Use as cover' }).click()
  await row.getByRole('button', { name: 'Remove cover' }).waitFor()
  await page.waitForTimeout(300)
}
await shot('cover-1-use', async () => {
  const card = await openCard('newsletter')
  await attach(card, ['signup-box.png', 'homepage-draft.png'])
  await useAsCover(card, 'signup-box.png')
  const other = card.locator('li, [class*=group]').filter({ hasText: 'homepage-draft.png' }).last()
  await other.hover()
  await ring(other.getByRole('button', { name: 'Use as cover' }))
  return around(
    [card.getByText('Files', { exact: true }), card.getByText('signup-box.png').first(), other, card.getByRole('button', { name: 'Attach' }).first()],
    28,
  )
})
await shot('cover-2-board', async () => {
  // (Two more cards get a cover, so the board shows how they sit among cards without one.)
  for (const [id, name] of [
    ['hero', 'homepage-draft.png'],
    ['signup', 'phone-form.png'],
  ]) {
    const card = await openCard(id)
    await attach(card, [name])
    await useAsCover(card, name)
  }
  if (!(await boardNow()).tasks.newsletter.cover) {
    const card = await openCard('newsletter')
    await attach(card, ['signup-box.png'])
    await useAsCover(card, 'signup-box.png')
  }
  await openBoard()
  await page.locator('img[src*="/thumb"]').first().waitFor()
  await page.waitForTimeout(800)
})

// The board's rules. Limits first: the menu and the editor before any is made, then a few made at once.
await shot('limit-1-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Doing list options' }).click()
  await page.getByRole('menu').waitFor()
  await ring(page.getByRole('menuitem', { name: /^(Change limit|Limit)…$/ }))
  return around([page.getByRole('menu'), page.getByText('Doing', { exact: true })], 30)
})
await shot('limit-2-editor', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'Doing list options' }).click()
  await page.getByRole('menuitem', { name: /^(Change limit|Limit)…$/ }).click()
  await page.locator('#limit-most').fill('3')
  await page.waitForTimeout(300)
  return page.getByRole('dialog')
})
/** The sample's rules, made once: three limits and two rules that tell people. */
const rulesOnce = async () => {
  const data = await boardNow()
  if (data.rules?.length) return
  const counts = data.board.mode === 'manual' ? 'topLevel' : 'leaves'
  const limit = (rule) =>
    api(ann, 'POST', `/boards/${board}/rules`, { rule: { kind: 'limit', counts, measure: { by: 'cards' }, then: [{ do: 'show' }], ...rule } })
  const tell = (rule, who) =>
    api(ann, 'POST', `/boards/${board}/rules`, { rule: { kind: 'when', on: 'enters', counts, ...rule, then: [{ do: 'tell', who }] } })
  await limit({ cards: { statuses: ['doing'] }, max: 3 })
  await limit({ cards: { statuses: ['todo', 'doing'] }, per: 'person', max: 4 })
  await limit({ name: 'Urgent work', cards: { priorities: ['urgent'] }, max: 1 })
  await tell({ name: 'Started', cards: { statuses: ['doing'] } }, [me.id])
  await tell({ name: 'Finished', cards: { statuses: ['done'] } }, ['@assignee', me.id])
}
await shot('limit-3-list', async () => {
  await rulesOnce()
  await openBoard()
  const list = page.locator('[data-list-id="doing"]').first()
  await ring(
    list
      .locator('header')
      .getByText(/^\d+ \/ \d+$/)
      .first(),
  )
  return around([list], 16)
})
await shot('limit-4-which', async () => {
  await rulesOnce()
  // (A taller window: the whole editor, with "Which cards" open.)
  await page.setViewportSize({ width: 1360, height: 1340 })
  await openBoard()
  await page.getByRole('button', { name: /^Rules/ }).click()
  await page.getByRole('button', { name: /^Change: At most 4 cards for each person/ }).click()
  const box = page.getByRole('dialog').filter({ hasText: 'Which cards' })
  await box.waitFor()
  await page.waitForTimeout(500)
  return box
})
await page.setViewportSize({ width: 1360, height: 860 })
await shot('rules-button', async () => {
  await rulesOnce()
  await openBoard()
  const button = page.getByRole('button', { name: /^Rules/ })
  await button.click()
  const list = page.locator('[data-slot=popover-content]').filter({ hasText: 'When this, tell someone' })
  await list.waitFor()
  await page.waitForTimeout(500)
  await ring(button)
  return around([button, list], 20)
})
await shot('rules-settings', async () => {
  await rulesOnce()
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Rules', exact: true }).click()
  // (Scrolled to the end: the last limits, then the rules that tell people.)
  const last = page.getByRole('dialog').getByRole('button', { name: 'New rule' })
  await last.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  return page.getByRole('dialog')
})
await shot('tell-1-menu', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'To Do list options' }).click()
  await page.getByRole('menu').waitFor()
  await ring(page.getByRole('menuitem', { name: 'Tell people when a card arrives…' }))
  return around([page.getByRole('menu'), page.getByText('To Do', { exact: true })], 30)
})
await shot('tell-2-editor', async () => {
  await openBoard()
  await page.getByRole('button', { name: 'To Do list options' }).click()
  await page.getByRole('menuitem', { name: 'Tell people when a card arrives…' }).click()
  const box = page.getByRole('dialog')
  await box.locator('#tell-who').getByText('Ben Ortiz').click()
  await box.locator('#tell-who').getByText('Whoever it is assigned to').click()
  await box.locator('#tell-name').fill('New work')
  await page.waitForTimeout(300)
  return box
})
await shot('tell-3-bell', async () => {
  await rulesOnce()
  // Ben starts two cards: the rule "Started" tells Ann, in one line.
  await api(ann, 'POST', '/notifications/read', {})
  for (const id of ['pricing', 'signup'])
    await api(benCtx, 'POST', `/boards/${board}/mutations`, {
      mutationId: `g${stamp}-tell-${n++}`,
      command: { type: 'task.update', id, fields: { status: 'doing' } },
    })
  await openBoard()
  await page
    .getByRole('button', { name: /Notifications/ })
    .first()
    .click()
  await page.waitForTimeout(600)
  const list = page.getByText('Mark all as read').locator('xpath=ancestor::*[@data-slot="popover-content"][1]')
  await ring(list.getByRole('button', { name: 'Stop telling me' }).first())
  return around([page.getByRole('button', { name: /Notifications/ }), list], 20)
})
await shot('tell-4-switch', async () => {
  await rulesOnce()
  await openBoard()
  await page.getByRole('button', { name: /^Rules/ }).click()
  const list = page.locator('[data-slot=popover-content]').filter({ hasText: 'When this, tell someone' })
  await list.waitFor()
  const row = list.locator('li').filter({ hasText: 'Started' })
  await row.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await ring(row.locator('label').filter({ hasText: 'Tells you' }))
  return around([list.getByText('When this, tell someone'), row, list.locator('li').filter({ hasText: 'Finished' })], 24)
})

// Templates: a card with its steps saved to start the next one from, and the board's shape for the next board.
/** A card worth keeping as a template, and the template made from it (once). */
const templateOnce = async () => {
  const have = (await api(ann, 'GET', `/boards/${board}/templates`)).templates
  if (!(await boardNow()).tasks.page) {
    await add('page', 'New page', null, 'todo', { labels: ['design'], priority: 'medium', description: 'Rename this card to the page it is for.' })
    for (const [i, title] of ['Write the copy', 'Design it', 'Build it', 'Check it on a phone'].entries())
      await add(`page${i}`, title, 'page', 'todo')
  }
  if (!have.some((t) => t.name === 'New page')) await api(ann, 'POST', `/boards/${board}/templates`, { taskId: 'page', name: 'New page' })
  if (!have.some((t) => t.name === 'Launch day')) await api(ann, 'POST', `/boards/${board}/templates`, { taskId: 'announce', name: 'Launch day' })
}
/** The region around some boxes measured earlier (an open menu hides the page behind it from being asked). */
const regionOf = (boxes, pad = 24) => {
  const view = page.viewportSize()
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad)
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad)
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad)
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad)
  return { clip: { x, y, width: right - x, height: bottom - y } }
}
await shot('template-1-save', async () => {
  await templateOnce()
  const card = await openCard('page')
  const head = [await card.getByRole('navigation').boundingBox(), await card.getByLabel('Title').boundingBox()]
  await card.getByRole('button', { name: 'More to do with this card' }).click()
  await page.getByRole('menu').waitFor()
  await ring(page.getByRole('menuitem', { name: 'Save as template…' }))
  return regionOf([...head, await page.getByRole('menu').boundingBox()])
})
await shot('template-2-add', async () => {
  await templateOnce()
  await openBoard()
  const list = page.locator('[data-list-id="todo"]').first()
  await list.getByRole('button', { name: 'Add a card' }).click()
  const arrow = list.getByRole('button', { name: 'From a template' })
  const box = [
    await list.getByRole('button', { name: 'Add card' }).boundingBox(),
    await arrow.boundingBox(),
    await list.locator('textarea').boundingBox(),
  ]
  await ring(arrow)
  await arrow.click()
  await page.getByRole('menu').waitFor()
  await page.waitForTimeout(300)
  return regionOf([...box, await page.getByRole('menu').boundingBox()], 32)
})
await shot('template-3-settings', async () => {
  await templateOnce()
  await openBoard()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Board settings' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Templates', exact: true }).click()
  await page.getByRole('dialog').getByText('New page', { exact: true }).waitFor()
  await page.waitForTimeout(400)
  return page.getByRole('dialog')
})
await shot('template-4-board', async () => {
  await templateOnce()
  const mine = (await api(ann, 'GET', '/board-templates')).templates
  if (!mine.some((t) => t.name === 'A website')) await api(ann, 'POST', `/boards/${board}/template`, { name: 'A website' })
  // (A taller window: the starters, then the templates under them.)
  await page.setViewportSize({ width: 1360, height: 1180 })
  await page.goto(`${SITE}/#/`)
  await page.reload()
  await page.getByRole('button', { name: 'Create board' }).first().click()
  const box = page.getByRole('dialog')
  await box.getByText('Your templates').waitFor()
  await box.getByRole('radio', { name: /A website/ }).click()
  await box.locator('#new-board-name').fill('Spring campaign site')
  await page.waitForTimeout(400)
  await ring(box.getByRole('radio', { name: /A website/ }).locator('xpath=ancestor::div[1]'))
  return box
})
await page.setViewportSize({ width: 1360, height: 860 })

// The two kinds of file a board can be saved as.
await shot('export-1-choice', async () => {
  await openBoard()
  await page.getByLabel('Search tasks').fill('set up')
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Export board…' }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForTimeout(500)
  return page.getByRole('dialog')
})

// A comment answered with emoji (after the rest: the comments of this card are in other pictures as they were).
await shot('comment-2-react', async () => {
  const all = (await api(ann, 'GET', `/boards/${board}/tasks/announce/comments`)).comments
  const [bens, anns] = [all.find((c) => c.body.startsWith('First draft')), all.find((c) => c.body.startsWith('Reads well'))]
  const react = (who, c, emoji) => api(who, 'PUT', `/boards/${board}/comments/${c.id}/reactions`, { emoji, on: true })
  await react(ann, bens, '👀')
  await react(benCtx, anns, '👍')
  await react(benCtx, anns, '✅')
  const card = await openCard('announce')
  const mine = card.locator('li.group').filter({ hasText: 'Reads well' }).first()
  const theirs = card.locator('li.group').filter({ hasText: 'First draft' }).first()
  await theirs.getByRole('button', { name: 'React to this comment' }).click()
  const six = page.getByLabel('Reactions').last()
  await six.waitFor()
  await ring(theirs.getByRole('button', { name: 'React to this comment' }))
  return around([card.getByRole('tab', { name: /Comments/ }), theirs, mine, six], 24)
})

// The Outline grouped by a column (last: how the Outline is set here stays that way for the rest of a run).
const groupOutline = async (by) => {
  await page.getByRole('table', { name: 'Tasks' }).waitFor()
  await page.getByRole('button', { name: 'Display' }).click()
  await page.getByRole('combobox', { name: 'Group by' }).click()
  await page.getByRole('option', { name: by, exact: true }).click()
  // (The list closes first, then the menu.)
  await page.waitForTimeout(450)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const { clip } = await around([page.getByText('Grouped by'), page.getByRole('table', { name: 'Tasks' })], 24)
  return clip
}
await shot('outline-groups', async () => {
  await openBoard('outline')
  const clip = await groupOutline('Assignee')
  return { clip: { ...clip, height: Math.min(clip.height, 640) } }
})
// By one of the board's own fields: where each deal came from, with what each heading's deals add up to.
await shot('outline-groups-field', async () => {
  const id = await starter('sales', 'Sales pipeline', 'violet')
  await page.goto(`${SITE}/#/b/${id}/outline`)
  await page.reload()
  const clip = await groupOutline('Source')
  await page.mouse.move(4, 4)
  // (Down to the table's own edge: what's under it isn't the point.)
  return { clip: { ...clip, height: clip.height - 18 } }
})

// Several cards ticked in the Outline, and the bar that changes them (after the grouped pictures: not grouped here).
const tickRows = async (titles) => {
  await openBoard('outline')
  const stop = page.getByRole('button', { name: 'Stop grouping' })
  if (await stop.count()) await stop.click()
  for (const title of titles) {
    const row = page
      .locator('[role=table] > [role=row]')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) })
      .first()
    await row.hover()
    await row.getByRole('checkbox', { name: `Select ${title}`, exact: true }).click()
  }
  await page.mouse.move(4, 4)
  return page.getByRole('toolbar', { name: 'Change the selected cards' })
}
// (A shorter window, so the bar at its foot is near the rows it is about.)
await page.setViewportSize({ width: 1360, height: 600 })
await shot('several-1-bar', async () => {
  const bar = await tickRows(['Hero picture', 'Pricing section', 'Collect customer quotes'])
  const table = await page.getByRole('table', { name: 'Tasks' }).boundingBox()
  const at = await bar.boundingBox()
  return { clip: { x: 0, y: table.y - 16, width: 1360, height: at.y + at.height + 14 - (table.y - 16) } }
})
await shot('several-2-labels', async () => {
  const bar = await tickRows(['Hero picture', 'Pricing section'])
  await bar.getByRole('button', { name: 'Labels' }).click()
  const menu = page.locator('[data-radix-popper-content-wrapper]').last()
  await menu.getByText('Labels on 2 cards').waitFor()
  await page.waitForTimeout(350)
  return around([menu, bar], 20)
})
await page.keyboard.press('Escape')
await page.setViewportSize({ width: 1360, height: 860 })
// The same on the Board: ⌘ or Ctrl with a click ticks the first card, plain clicks the next ones.
await shot('several-3-board', async () => {
  await openBoard()
  const card = (title) =>
    page
      .locator('article[data-card-id]')
      .filter({ has: page.getByText(title, { exact: true }) })
      .first()
  await card('Launch announcement').click({ modifiers: ['ControlOrMeta'] })
  await card('Fix the sign-up form on phones').click()
  await card('Collect customer quotes').click()
  await page.mouse.move(4, 4)
  const bar = await page.getByRole('toolbar', { name: 'Change the selected cards' }).boundingBox()
  const lists = await page.locator('[data-list-row]').boundingBox()
  return { clip: { x: 0, y: lists.y, width: 1360, height: bar.y + bar.height + 14 - lists.y } }
})
// (Only when that picture was taken: asked for a few pictures by name, the script skips the rest.)
if (await page.getByRole('button', { name: 'Clear the selection' }).count()) await page.getByRole('button', { name: 'Clear the selection' }).click()

// ── A knowledge base on a board: the studio's handbook (last: a board of its own, made only for these) ────────────
let handbook = null
/** The handbook: five lists for an article's life, three fields, and articles with pictures and pages inside. */
async function theHandbook() {
  if (handbook) return handbook
  const { id } = await api(ann, 'POST', '/boards', { name: 'Team handbook', background: 'teal' })
  let k = 0
  const go = (command) => api(ann, 'POST', `/boards/${id}/mutations`, { mutationId: `h${stamp}-${k++}`, command })
  await go({ type: 'board.update', fields: { description: 'How we work, written down. An article is a card; its list says how far along it is.' } })
  const lists = [
    ['todo', 'Inbox', 'todo'],
    ['drafting', 'Drafting', 'doing'],
    ['doing', 'In review', 'doing'],
    ['published', 'Published', 'doing'],
    ['done', 'Outdated', 'done'],
  ]
  for (const [list, name, category] of lists) {
    if (['todo', 'doing', 'done'].includes(list)) await go({ type: 'column.update', id: list, fields: { name, category } })
    else await go({ type: 'column.create', id: list, name, category })
  }
  await go({ type: 'column.delete', id: 'backlog', moveTo: 'todo' }).catch(() => {})
  for (const [list] of lists) await go({ type: 'column.move', id: list })
  const invite = (await api(ann, 'PUT', `/boards/${id}/invites/link`, { role: 'editor' })).link
  await api(benCtx, 'POST', '/join', { invite: invite.token })
  await ann.request.delete(`${SITE}/api/boards/${id}/invites/link`)
  const field = async (def) => {
    const made = (await api(ann, 'POST', '/fields', def)).id
    return (await api(ann, 'GET', '/fields')).fields.find((f) => f.id === made)
  }
  const topic = await field({
    name: 'Topic',
    type: 'choice',
    options: [
      { name: 'Start here', color: 'blue' },
      { name: 'How we work', color: 'orange' },
      { name: 'Clients', color: 'green' },
      { name: 'Tools', color: 'teal' },
    ],
  })
  const owner = await field({ name: 'Owner', type: 'person' })
  const review = await field({ name: 'Review by', type: 'date' })
  await api(ann, 'PUT', `/boards/${id}/fields`, { fields: [topic, owner, review].map((f, i) => ({ id: f.id, front: i === 0, total: false })) })
  for (const [name, color] of [
    ['how-to', 'blue'],
    ['policy', 'red'],
    ['decision', 'violet'],
  ])
    await go({ type: 'label.create', id: name, name, color })
  const about = (t, who, days) => ({
    [topic.id]: [topic.options.find((o) => o.name === t).id],
    ...(who && { [owner.id]: [who] }),
    ...(days !== undefined && { [review.id]: day(days) }),
  })
  const page = (card, title, parentId, status, text, fields = {}) =>
    go({ type: 'task.create', id: card, parentId, fields: { title, status, ...(text && { description: text }), ...fields } })
  // Its pictures: plain diagrams, drawn here.
  const box = (x, w, text, fill = '#eef2ff', stroke = '#6366f1') =>
    `<rect x="${x}" y="34" width="${w}" height="54" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"/><text x="${x + w / 2}" y="67" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="600" text-anchor="middle" fill="#1e1b4b">${text}</text>`
  const arrow = (x) =>
    `<path d="M${x} 61 h26 m-9 -7 l9 7 l-9 7" fill="none" stroke="#64748b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
  const steps = (names, tint = {}) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="122" viewBox="0 0 900 122"><rect width="900" height="122" fill="#ffffff"/>${names
      .map((t, i) => box(24 + i * 176, 138, t, ...(tint[t] ?? [])) + (i < names.length - 1 ? arrow(24 + i * 176 + 144) : ''))
      .join('')}</svg>`
  const attach = async (card, name, svg) => {
    const r = await ann.request.fetch(`${SITE}/api/boards/${id}/tasks/${card}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': 'image/png' },
      data: await sharp(Buffer.from(svg)).png().toBuffer(),
    })
    if (!r.ok()) throw new Error(`attach ${name} → ${r.status()}`)
  }
  await page(
    'start',
    'Start here: how this handbook works',
    null,
    'published',
    `This board is our handbook. Every card is an article, and its description is the article.

## The life of an article

📎article-life.png

1. **Inbox**: something worth writing down. A title is enough.
2. **Drafting**: someone is writing it.
3. **In review**: ready for a second pair of eyes.
4. **Published**: it is what we do.
5. **Outdated**: it was true once.

## Reading

Click **Expand** above a description to read it full page. The **Outline** tab is the table of contents.`,
    { custom: about('Start here', me.id, 120) },
  )
  await attach(
    'start',
    'article-life.png',
    steps(['Inbox', 'Drafting', 'In review', 'Published', 'Outdated'], { Published: ['#dcfce7', '#16a34a'], Outdated: ['#f1f5f9', '#94a3b8'] }),
  )
  await page(
    'week',
    'Your first week',
    null,
    'published',
    `Welcome. This is what happens in your first five days, and who to ask.\n\n## Who to ask\n\n| About | Ask |\n|---|---|\n| Pay and holidays | Ann |\n| Which project | Ben |\n\nThe pages inside this one cover each day.`,
    { custom: about('Start here', ben.id, 60) },
  )
  await page(
    'day1',
    'Day 1: accounts and your laptop',
    'week',
    'published',
    `## Morning\n\n- [ ] Your email works\n- [ ] You can open the boards\n\n## Afternoon\n\nSit in on the launch call. You listen today.`,
    { custom: about('Start here', ben.id) },
  )
  await page(
    'day2',
    'Day 2: how a launch runs',
    'week',
    'published',
    `Read **How we launch a website**, then look at a launch on staging with whoever is running it.`,
    { custom: about('Start here', ben.id) },
  )
  await page('tools', 'Tools we use', 'week', 'published', `## Every day\n\n- Kanbanto, for the work and this handbook\n- The team chat`, {
    custom: about('Tools', ben.id),
  })
  await page(
    'launch',
    'How we launch a website',
    null,
    'published',
    `## Problem

Two launches went out with the old prices on them, because nobody owned the last look.

## What we do

📎launch-steps.png

1. **Freeze** the text two days before. Changes after that wait for the next week.
2. **Check on staging**, on a phone and on a laptop.
3. **Sign-off** is one person's, and their name is on the launch card.
4. **Go live** before noon, never on a Friday.
5. **Watch** the visitor counts and the sign-up form for a day.

| Check | Who |
|---|---|
| Prices and dates | The client |
| Links and forms | Ben |
| The last look | Ann |

## Lessons learned

- A launch after 16:00 is a launch nobody watches.
- "One small change" on launch day is a new launch.

## References

- The launch checklist from 2024 is in **Outdated**. Don't use it.`,
    { labels: ['how-to'], custom: about('How we work', me.id, 30) },
  )
  await attach('launch', 'launch-steps.png', steps(['Freeze', 'Staging', 'Sign-off', 'Go live', 'Watch'], { 'Go live': ['#dcfce7', '#16a34a'] }))
  await page(
    'names',
    'Naming pages and files',
    null,
    'published',
    `## What we do\n\nLower case, words joined with a dash, no dates in a page's address.`,
    { labels: ['how-to'], custom: about('How we work', ben.id, -8) },
  )
  await page(
    'hosting',
    'Why we host with one provider',
    null,
    'published',
    `## What we decided\n\nEvery client site is hosted in one place, on our account.\n\n## Why\n\n- One bill, one login, one way to deploy to staging.`,
    { labels: ['decision'], custom: about('Tools', me.id, 200) },
  )
  await page(
    'refunds',
    'Refunds for retainers',
    null,
    'doing',
    `## The rule\n\nA retainer month that hasn't started is refunded in full.\n\n## Open questions\n\n- What about a month that is half used?`,
    { labels: ['policy'], assigneeId: me.id, due: day(3), custom: about('Clients', me.id) },
  )
  await page(
    'handover',
    'Handing over to a client',
    null,
    'drafting',
    `## What we do\n\n1. A call to walk through the site.\n2. (To write: logins, and who they ask afterwards.)`,
    { labels: ['how-to'], assigneeId: ben.id, custom: about('Clients', ben.id) },
  )
  await page('old', 'Launch checklist 2024', null, 'done', `Replaced by **How we launch a website**.`, { custom: about('How we work', me.id) })
  await page('pricing', 'Write up how we price a redesign', null, 'todo', '')
  await page('logins', 'Who has the domain logins?', null, 'todo', '')
  await api(benCtx, 'POST', `/boards/${id}/tasks/refunds/comments`, { body: 'Half-used months: we said pro rata last time. Worth writing down.' })
  return (handbook = { id, topic, owner, review })
}
await page.setViewportSize({ width: 1500, height: 860 })
await shot('km-1-board', async () => {
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/b/${id}/board`)
  await page.reload()
  await page.getByText('Published', { exact: true }).first().waitFor()
  await page.waitForTimeout(700)
  return { clip: { x: 0, y: 0, width: 1500, height: 640 } }
})
await page.setViewportSize({ width: 1360, height: 860 })
await shot('km-2-outline', async () => {
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/b/${id}/outline`)
  await page.reload()
  await page.getByRole('table', { name: 'Tasks' }).waitFor()
  // (Fewer of the usual columns, so the board's own show: who keeps an article, and when to look at it again.)
  await page.getByRole('button', { name: 'Display' }).click()
  for (const name of ['Progress', 'Assignee', 'Priority', 'Start', 'Due', 'Topic']) {
    const tick = page.getByRole('dialog').getByLabel(name, { exact: true })
    if (await tick.isChecked()) await tick.click()
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const clip = await groupOutline('Topic')
  await page.mouse.move(4, 4)
  return { clip: { ...clip, height: Math.min(clip.height - 18, 640) } }
})
await shot('km-3-page', async () => {
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/b/${id}/outline?task=launch&full=1`)
  await page.reload()
  await page.getByRole('navigation', { name: 'Contents' }).waitFor()
  await page.locator('.md-reader img').first().waitFor()
  await page.waitForTimeout(700)
  return { clip: { x: 0, y: 0, width: 1360, height: 800 } }
})
await shot('desc-4-picture', async () => {
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/b/${id}/board?task=start`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.locator('.md img').first().waitFor()
  await page.waitForTimeout(700)
  return around(
    [card.getByText('Description', { exact: true }), card.getByRole('button', { name: 'Expand', exact: true }), card.locator('.md').first()],
    28,
  )
})
await shot('km-5-search', async () => {
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/cards?board=${id}&q=staging`)
  await page.reload()
  await page.getByText('How we launch a website').first().waitFor()
  await page.waitForTimeout(500)
  return { clip: { x: 0, y: 0, width: 1360, height: 640 } }
})

// ── Writing a description with other people at once ─────────────────────────────────────────────────────

await page.setViewportSize({ width: 1360, height: 860 })
/** Other people's windows on the handbook, each signed in as them and writing (closed again by `alone`). */
const theirs = []
const alone = async () => {
  for (const p of theirs.splice(0)) {
    await p.keyboard.press('Escape').catch(() => {})
    await p.waitForTimeout(300)
    await p.close()
  }
}
/**
 * Someone else opens a card of the handbook in a window of their own, starts writing its description, puts the
 * cursor at the end of the line that starts with `after`, and types.
 */
const writesToo = async (who, id, card, after, words) => {
  const p = await who.newPage()
  theirs.push(p)
  await p.setViewportSize({ width: 1200, height: 800 })
  await p.goto(`${SITE}/#/b/${id}/outline?task=${card}`)
  // (A click in the text starts the writing there.)
  await p.getByRole('dialog').first().locator('.md').first().getByText(after).click()
  const text = p.getByRole('textbox', { name: 'Description' })
  await text.waitFor()
  await p.waitForTimeout(400)
  await text.getByText(after).click()
  await p.keyboard.press('End')
  await p.keyboard.type(words, { delay: 10 })
}
let cleoCtx = null
/** A third person on the handbook. */
const cleo = async (id) => {
  if (cleoCtx) return cleoCtx
  cleoCtx = await browser.newContext()
  await api(cleoCtx, 'POST', '/auth/signup', { name: 'Cleo Marsh', email: `cleo.marsh+${stamp}@example.com`, password: 'correct horse' })
  const invite = (await api(ann, 'PUT', `/boards/${id}/invites/link`, { role: 'editor' })).link
  await api(cleoCtx, 'POST', '/join', { invite: invite.token })
  await ann.request.delete(`${SITE}/api/boards/${id}/invites/link`)
  return cleoCtx
}
await shot('desc-5-writing', async () => {
  const { id } = await theHandbook()
  await writesToo(benCtx, id, 'handover', 'A call to walk through the site', ' Record it.')
  await page.goto(`${SITE}/#/b/${id}/outline?task=handover`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.getByText(/is writing this now/).waitFor()
  await page.waitForTimeout(600)
  await ring(card.getByText(/is writing this now/))
  return around(
    [card.getByText('Description', { exact: true }), card.getByRole('button', { name: 'Expand', exact: true }), card.locator('.md').first()],
    28,
  )
})
await shot('km-6-together', async () => {
  await alone()
  const { id } = await theHandbook()
  await page.goto(`${SITE}/#/b/${id}/outline?task=refunds`)
  await page.reload()
  const card = page.getByRole('dialog').first()
  await card.locator('.md').first().getByText('Open questions').click()
  const text = page.getByRole('textbox', { name: 'Description' })
  await text.waitFor()
  await writesToo(benCtx, id, 'refunds', 'A retainer month that', ' We say so on every invoice.')
  await writesToo(await cleo(id), id, 'refunds', 'What about a month that is half used?', ' Pro rata, by the day.')
  await text.getByText('Open questions').click()
  // (Saved by itself, a few seconds after the last key.)
  await card.getByRole('status').filter({ hasText: 'Saved' }).waitFor()
  await page.waitForTimeout(500)
  return around([card.getByText('Description', { exact: true }), text, card.getByRole('button', { name: 'Write full page' })], 28)
})
await shot('km-7-versions', async () => {
  await alone()
  const { id } = await theHandbook()
  // (Ann leaves the text too, if she was in it.)
  await page.goto(`${SITE}/#/b/${id}/outline`)
  await page.waitForTimeout(800)
  // (Its versions, if the picture before this one wasn't taken: Ben changes the text, then Ann does.)
  const text = (await api(ann, 'GET', `/boards/${id}`)).data.tasks.refunds.description
  if (!(await api(ann, 'GET', `/boards/${id}/tasks/refunds/versions`)).versions.length) {
    const change = (who, description) =>
      api(who, 'POST', `/boards/${id}/mutations`, {
        mutationId: `v${stamp}-${description.length}`,
        command: { type: 'task.update', id: 'refunds', fields: { description } },
      })
    await change(benCtx, `${text}\n- Who agrees to an exception?`)
    await change(ann, `${text}\n- Who agrees to an exception? Ann.`)
  }
  await page.goto(`${SITE}/#/b/${id}/outline?task=refunds&full=1`)
  await page.reload()
  await page.getByRole('button', { name: 'Versions' }).click()
  const list = page.getByRole('navigation', { name: 'Versions' })
  await list.getByRole('button').nth(1).waitFor()
  await list.getByRole('button').nth(2).click()
  await page.getByRole('button', { name: 'Bring this version back' }).waitFor()
  await page.waitForTimeout(500)
  return { clip: { x: 0, y: 0, width: 1360, height: 560 } }
})
await alone()

await browser.close()
console.log(`made ${made.length}: ${made.join(', ')}`)
if (failed.length) console.log(`\nnot made (${failed.length}):\n  ${failed.join('\n  ')}`)
