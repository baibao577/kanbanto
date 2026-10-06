import { reset, setup } from './helpers'
import { perfSizes, seedPerf } from './perfSeed'

/**
 * Fills a throwaway database with the big workspace of perfSeed.ts, for a site to open in a browser (see
 * guides/perf/browser.mjs). EVERYTHING in that database is emptied first, so it only runs against one whose name
 * says what it's for:
 *
 *   DATABASE_URL=postgres://kankan:kankan@127.0.0.1:5471/kankan_perf_web NODE_ENV=test \
 *     pnpm --filter @kanbanto/server exec tsx test/perfSeedRun.ts
 *
 * (NODE_ENV=test: signing up thirty people in a row isn't held back.) It prints the main board's id and a sign-in.
 */
const url = process.env.DATABASE_URL ?? ''
if (!/\/[^/?]*perf[^/?]*(\?|$)/.test(url)) {
  console.error('Set DATABASE_URL to a throwaway database with “perf” in its name: this empties it.')
  process.exit(1)
}

const t = await setup()
await reset(t.db)
const seed = await seedPerf(t.app, t.db, perfSizes(), (line) => console.info(line))
console.info(JSON.stringify({ board: seed.main.id, companies: seed.companies.id, email: seed.ann.user.email, password: 'correct horse' }))
await t.close()
