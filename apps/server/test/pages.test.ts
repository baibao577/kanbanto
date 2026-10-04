import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
let dir: string
beforeAll(async () => {
  t = await setup()
  await reset(t.db)
  dir = mkdtempSync(path.join(os.tmpdir(), 'kanbanto-pages-'))
})
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await t.close()
})

const put = (name: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  writeFileSync(path.join(dir, name), text)
}

describe('the site’s own pages', () => {
  it('are served next to the app, with the links shown under the sign-in form', async () => {
    put('privacy.html', '<h1>Privacy</h1>')
    put('img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    put('links.json', JSON.stringify([{ label: 'Privacy', url: '/privacy' }]))
    // Not served: the main address and the API are the app's, hidden files stay hidden, and programs aren't pages.
    put('index.html', 'mine')
    put('api/health.html', 'mine')
    put('.secret.html', 'hidden')
    put('run.sh', 'echo')
    const app = await buildApp(t.db, { transport: t.mail, pagesDir: dir })
    const get = (url: string) => app.inject({ method: 'GET', url })

    const page = await get('/privacy')
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toBe('<h1>Privacy</h1>')
    expect((await get('/privacy.html')).body).toBe('<h1>Privacy</h1>')
    expect((await get('/img/logo.svg')).headers['content-type']).toBe('image/svg+xml')

    expect((await get('/api/health')).json()).toEqual({ ok: true })
    for (const url of ['/links.json', '/index.html', '/.secret', '/.secret.html', '/run.sh', '/api/health.html', '/../package.json'])
      expect((await get(url)).body, url).not.toMatch(/mine|hidden|echo|label|kanbanto/)

    expect((await get('/api/auth/me')).json().links).toEqual([{ label: 'Privacy', url: '/privacy' }])
    await app.close()
  })

  it('there are none by default, and a links file that isn’t right says so', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).json().links).toEqual([])
    put('links.json', JSON.stringify([{ label: 'Bad', url: 'javascript:alert(1)' }]))
    await expect(buildApp(t.db, { transport: t.mail, pagesDir: dir })).rejects.toThrow(/links\.json/)
    put('links.json', '{ not json')
    await expect(buildApp(t.db, { transport: t.mail, pagesDir: dir })).rejects.toThrow(/isn’t valid JSON/)
    await expect(buildApp(t.db, { transport: t.mail, pagesDir: path.join(dir, 'nope') })).rejects.toThrow(/no such folder/)
  })
})
