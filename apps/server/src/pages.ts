import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SiteLink } from '@kanbanto/model/api'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

/**
 * A site's own pages: a folder (PAGES_DIR) of plain files that the server serves next to the app, for things every
 * public site needs and the app doesn't have: an about page, a privacy policy, terms, an imprint.
 *
 *   privacy.html      → /privacy (and /privacy.html)
 *   img/team.png      → /img/team.png
 *   links.json        → not served: links shown under the sign-in form, [{ "label": "Privacy", "url": "/privacy" }]
 *
 * The app keeps the main address (/) and everything under /api. Pages are found once, when the server starts; they
 * run on the same site as the app, so only put pages you wrote (or trust) there.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
}
/** Addresses that are the app's own. */
const RESERVED = /^\/(api|oauth|assets|\.well-known)(\/|$)/
const LINKS_FILE = 'links.json'
const MAX_DEPTH = 4

const Links = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(40),
      /** A page on this site (/privacy), or a full address. */
      url: z.string().regex(/^(\/(?!\/)|https?:\/\/)/, 'Use an address on this site (/privacy) or a full one (https://…).'),
    }),
  )
  .max(8)

/** Every file under `dir` (not hidden ones), as paths from it with forward slashes. */
function filesIn(dir: string, under = '', depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  return readdirSync(path.join(dir, under), { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return []
    const rel = under ? `${under}/${e.name}` : e.name
    return e.isDirectory() ? filesIn(dir, rel, depth + 1) : e.isFile() ? [rel] : []
  })
}

/** The links in the folder's links.json (none without one). A file that isn't right stops the server, saying why. */
export function siteLinks(dir: string | undefined): SiteLink[] {
  const file = dir && path.join(dir, LINKS_FILE)
  if (!file || !existsSync(file)) return []
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} isn’t valid JSON.`)
  }
  const r = Links.safeParse(json)
  if (!r.success)
    throw new Error(`${file}: ${r.error.issues[0]?.message ?? 'not a list of links'} Expected [{ "label": "Privacy", "url": "/privacy" }].`)
  return r.data
}

/** Serves the pages in `dir`. Returns the addresses it serves. */
export function servePages(app: FastifyInstance, dir: string): string[] {
  const root = path.resolve(dir)
  if (!existsSync(root)) throw new Error(`PAGES_DIR is set to ${dir}, but there’s no such folder.`)
  const served: string[] = []
  for (const rel of filesIn(root)) {
    const type = TYPES[path.extname(rel).toLowerCase()]
    if (rel === LINKS_FILE) continue
    // The main address is the app's; and only kinds of files a page is made of.
    if (!type || rel === 'index.html') {
      app.log.warn(
        `Pages: ${rel} isn’t served (${type ? 'the main address is the app’s: give the page another name' : 'not a kind of file pages use'}).`,
      )
      continue
    }
    const file = path.join(root, rel)
    const urls = rel.endsWith('.html') ? [`/${rel.slice(0, -'.html'.length)}`, `/${rel}`] : [`/${rel}`]
    for (const url of urls) {
      if (RESERVED.test(url) || app.hasRoute({ method: 'GET', url })) {
        app.log.warn(`Pages: ${rel} isn’t served at ${url} (the app uses that address).`)
        continue
      }
      app.get(url, (_req, reply) =>
        reply.type(type).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff').send(createReadStream(file)),
      )
      served.push(url)
    }
  }
  return served
}
