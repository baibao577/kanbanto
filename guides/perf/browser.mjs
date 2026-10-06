// How long the app takes in Chrome on a big board with fields of every kind: opening it, the Outline, sorting,
// filtering, editing a cell. Each thing is done three times and the middle time is printed.
//
//   PERF_SITE=http://127.0.0.1:5481 PERF_BOARD=<the board's id> node perf/browser.mjs
//
// The site is a throwaway one, filled by apps/server/test/perfSeedRun.ts (which prints the board's id and the
// sign-in used here: PERF_EMAIL and PERF_PASSWORD say another). PERF_OUT: a file to write the numbers to, as JSON.
//
// Times are taken inside the page (performance.now()), from the click to just after the frame that shows what was
// asked for (rows there, a column marked as sorted, a value in its cell): what is waited for is always something on
// the page, never a pause. The page is looked at once per frame, so a time is good to about 16 ms. Beside each time
// is how much of it Chrome spent running the app's code and how much working out styles and layout (from its record
// of long frames, so short ones aren't counted).
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const SITE = process.env.PERF_SITE?.replace(/\/+$/, '')
const BOARD = process.env.PERF_BOARD
if (!SITE || !BOARD) throw new Error('Set PERF_SITE to the throwaway site (http://127.0.0.1:5481) and PERF_BOARD to the big board’s id.')
const EMAIL = process.env.PERF_EMAIL ?? 'ann@example.com'
const PASSWORD = process.env.PERF_PASSWORD ?? 'correct horse'
// The big board's fields, as bigBoard.ts names them: a choice with 50 options, a number that adds up, a link to a
// card of another board, and plain text.
const CHOICE = 'Stage'
const NUMBER = 'Amount'
const LINK = 'Company'
const TEXT = 'Notes'
const RUNS = 3

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
const page = await ctx.newPage()
const api = async (method, path, data) => {
  const r = await ctx.request.fetch(`${SITE}/api${path}`, { method, data })
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
  return r.json()
}

// What every measurement uses, inside the page.
await page.addInitScript(() => {
  const frames = []
  const watch = new PerformanceObserver((list) => frames.push(...list.getEntries()))
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) watch.observe({ type: 'long-animation-frame', buffered: true })
  window.perf = {
    /**
     * Waits (looking once per frame) until `test` is true and that frame is on the screen. Gives how long that was
     * since `started`, and how much of it went to the app's code and to styles and layout.
     */
    drawn: (started, test) =>
      new Promise((resolve) => {
        const done = () => {
          const ended = performance.now()
          // (Chrome hands over its record of a frame a moment after it. Waiting for it is after the time was taken.)
          const read = () => {
            frames.push(...watch.takeRecords())
            const during = frames.filter((f) => f.startTime + f.duration > started && f.startTime < ended)
            const sum = (of) => Math.round(during.reduce((ms, f) => ms + of(f), 0))
            resolve({
              ms: ended - started,
              code: sum((f) => f.scripts.reduce((ms, s) => ms + s.duration, 0)),
              layout: sum((f) => (f.styleAndLayoutStart ? f.startTime + f.duration - f.styleAndLayoutStart : 0)),
            })
          }
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(read, 100)))
        }
        const look = () => (test() ? requestAnimationFrame(() => setTimeout(done, 0)) : requestAnimationFrame(look))
        look()
      }),
    cards: () => document.querySelectorAll('[data-card-id]').length,
    // (The Outline's rows of cards: not its headings, nor the totals under them.)
    rows: () => document.querySelectorAll('[role="table"][aria-label="Tasks"] > [role="row"].drag-handle').length,
    tab: (name) => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === name),
    heading: (name) => [...document.querySelectorAll('[role="columnheader"]')].find((h) => h.textContent.trim() === name),
    button: (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text),
  }
})
// (Leaving a page with a change still on its way asks first: say yes.)
page.on('dialog', (d) => d.accept())
// Every time the page asks what links point at (40 links at a time, as cards with links come into view).
let asked = 0
page.on('requestfinished', (r) => r.url().includes('/linked?refs=') && asked++)

const lines = []
/**
 * Does `run` three times and keeps the one in the middle. `run` gives what `perf.drawn` gave (and maybe a `note`);
 * `before` and `after` get the page ready and put it back, and aren't timed.
 */
async function measure(what, run, { before, after, note } = {}) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    await before?.(i)
    runs.push(await run(i))
    await after?.(i)
    process.stderr.write('.')
  }
  const mid = [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(RUNS / 2)]
  lines.push({
    what,
    ms: Math.round(mid.ms),
    runs: runs.map((r) => Math.round(r.ms)),
    code: mid.code,
    layout: mid.layout,
    note: [mid.note, await note?.()].filter(Boolean).join('; '),
  })
}

/** How long the page waited for the board itself (the request, and how big the answer was), the last time it asked. */
const fetched = () =>
  page.evaluate((board) => {
    const e = performance.getEntriesByType('resource').findLast((r) => r.name.endsWith(`/api/boards/${board}`))
    return e ? `${Math.round(e.responseEnd - e.startTime)} ms of it waiting for the board (${(e.decodedBodySize / 1e6).toFixed(1)} MB)` : undefined
  }, BOARD)

const home = async () => {
  await page.evaluate(() => (location.hash = '#/'))
  await page.waitForSelector(`a[href="#/b/${BOARD}"]`)
}
/** Onto a tab of the board, and there. (The Outline starts with 500 rows, or all of them when there are fewer.) */
const toTab = (name) =>
  page.evaluate(async (name) => {
    window.perf.tab(name).click()
    await window.perf.drawn(0, () => (name === 'Board' ? window.perf.cards() >= 50 : window.perf.rows() >= 1))
  }, name)

try {
  await api('POST', '/auth/signin', { email: EMAIL, password: PASSWORD })
  const { data } = await api('GET', `/boards/${BOARD}`)
  const count = Object.keys(data.tasks).length
  const fieldId = (name) => data.fields.find((f) => f.name === name)?.id
  for (const name of [CHOICE, NUMBER, LINK, TEXT]) if (!fieldId(name)) throw new Error(`The board has no field “${name}”.`)

  await page.goto(`${SITE}/#/`)
  await page.waitForSelector(`a[href="#/b/${BOARD}"]`)

  // ── Opening the board ───────────────────────────────────────────────────────
  await measure(
    'open the board from the boards page, until its cards are drawn',
    () =>
      page.evaluate((board) => {
        // (As a device that never opened it: the Board tab, nothing sorted or filtered.)
        localStorage.removeItem(`kankan:v3:prefs:${board}`)
        const started = performance.now()
        document.querySelector(`a[href="#/b/${board}"]`).click()
        return window.perf.drawn(started, () => window.perf.cards() >= 50)
      }, BOARD),
    { after: async (i) => i < RUNS - 1 && (await home()), note: fetched },
  )
  const shown = await page.evaluate(() => window.perf.cards())

  // ── The Outline ─────────────────────────────────────────────────────────────
  const first = Math.min(500, count)
  await measure(
    `open the Outline (its first ${first} rows)`,
    () =>
      page.evaluate((first) => {
        const started = performance.now()
        window.perf.tab('Outline').click()
        return window.perf.drawn(started, () => window.perf.rows() >= first)
      }, first),
    { after: () => toTab('Board') },
  )
  if (count > 500)
    await measure(
      '“Show more”: 500 more rows',
      () =>
        page.evaluate(
          (want) => {
            const started = performance.now()
            window.perf.button('Show more').click()
            return window.perf.drawn(started, () => window.perf.rows() >= want)
          },
          Math.min(1000, count),
        ),
      // (Leaving the Outline and coming back starts it at 500 rows again.)
      { before: () => toTab('Outline'), after: () => toTab('Board') },
    )
  await toTab('Outline')
  const columns = await page.evaluate(() => document.querySelectorAll('[role="columnheader"]').length)

  // Sorting: from the click on a column's heading to that column marked as sorted (the rows are redrawn with it).
  for (const [kind, name] of [
    ['a choice', CHOICE],
    ['a number that adds up', NUMBER],
    ['a card link', LINK],
  ])
    await measure(
      `sort the Outline by ${kind} (${name})`,
      () =>
        page.evaluate((name) => {
          const heading = window.perf.heading(name)
          const started = performance.now()
          heading.querySelector('button').click()
          return window.perf.drawn(started, () => heading.getAttribute('aria-sort') === 'ascending')
        }, name),
      {
        after: () =>
          page.evaluate(async (name) => {
            document.querySelector('button[aria-label="Stop sorting"]').click()
            await window.perf.drawn(0, () => window.perf.heading(name).getAttribute('aria-sort') === 'none')
          }, name),
      },
    )

  // Filtering: the Filter menu is opened and the field picked first; timed from ticking one of its options to the
  // table showing other rows.
  const menu = page.getByRole('dialog')
  const before = await page.evaluate(() => window.perf.rows())
  await measure(
    `filter by a choice (${CHOICE}) from the Filter menu`,
    (i) =>
      page.evaluate(
        async ({ option, before }) => {
          const row = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === option)
          const started = performance.now()
          row.querySelector('[role="checkbox"]').click()
          const took = await window.perf.drawn(started, () => window.perf.rows() !== before)
          return { ...took, note: `${window.perf.rows()} rows left` }
        },
        { option: `${CHOICE} ${i + 1}`, before },
      ),
    {
      before: async () => {
        await page.getByTitle('Filter', { exact: true }).click()
        await menu.getByLabel(`Filter by ${CHOICE}`).click()
        await menu.getByText(`${CHOICE} 50`, { exact: true }).waitFor()
      },
      after: async () => {
        await page.evaluate(async (before) => {
          window.perf.button('Clear filters').click()
          await window.perf.drawn(0, () => window.perf.rows() === before)
        }, before)
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'detached' })
      },
    },
  )

  // Editing: a text cell of the first row. Typed with a space after it: once the board has the new value, the cell
  // shows it without the space, and that is what's waited for.
  await measure(`edit a text cell (${TEXT}) and commit it with Enter`, (i) =>
    page.evaluate(
      ({ name, text }) => {
        const cell = document.querySelector(`[role="table"] [role="row"] input[aria-label="${name}"]`)
        cell.focus()
        cell.value = `${text} `
        const started = performance.now()
        cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return window.perf.drawn(started, () => cell.value === text)
      },
      { name: TEXT, text: `Edited ${i + 1}` },
    ),
  )
  // (And it was a real edit: the server has it.)
  const saved = async () =>
    Object.values((await api('GET', `/boards/${BOARD}`)).data.tasks).some((t) => t.custom?.[fieldId(TEXT)] === `Edited ${RUNS}`)
  for (let tries = 0; !(await saved()); tries++) if (tries > 20) throw new Error('The edited cell never reached the server.')

  // ── Loading the page afresh ─────────────────────────────────────────────────
  const reload = async (what, least) => {
    await page.reload({ waitUntil: 'commit' })
    // (Inside the new page, time starts when it started loading.)
    return page.evaluate(({ what, least }) => window.perf.drawn(0, () => window.perf[what]() >= least), { what, least })
  }
  await toTab('Board')
  await measure('reload the page on the Board tab, until its cards are drawn', () => reload('cards', 50), { note: fetched })
  await toTab('Outline')
  await measure(`reload the page on the Outline, until its first ${first} rows are drawn`, () => reload('rows', first), { note: fetched })

  // ── The table ───────────────────────────────────────────────────────────────
  const width = Math.max(...lines.map((l) => l.what.length))
  console.log(
    [
      `\n${data.board.name}: ${count.toLocaleString('en-US')} cards, ${data.fields.length} fields, in Chrome ${browser.version()}.`,
      `The Board tab draws ${shown} cards at first; the Outline has ${columns} columns. The page asked what links point at ${asked} times (40 links each).`,
      'Median of 3, in ms (each run); of the median run, the app’s code / styles and layout; notes.',
      ...lines.map(
        (l) =>
          `  ${l.what.padEnd(width)}  ${String(l.ms).padStart(5)}  (${l.runs.join(', ')})  ${l.code} / ${l.layout}${l.note ? `  ${l.note}` : ''}`,
      ),
    ].join('\n'),
  )
  if (process.env.PERF_OUT)
    writeFileSync(process.env.PERF_OUT, JSON.stringify({ at: new Date().toISOString(), chrome: browser.version(), cards: count, lines }, null, 2))
} finally {
  await browser.close()
}
