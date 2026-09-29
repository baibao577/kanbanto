import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSmtpUrl, serverSender } from '../src/mail/senders'
import { providerTransport, SendError, type Credentials } from '../src/mail/transport'

/** A real SMTP server on a free port: signs in ann / secret, and keeps what it receives. */
const received: { from: string; to: string[]; data: string }[] = []
let server: SMTPServer
let port = 0

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, done) {
      if (auth.username === 'ann' && auth.password === 'secret') return done(null, { user: 'ann' })
      done(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }))
    },
    onData(stream, session, done) {
      let data = ''
      stream.on('data', (c: Buffer) => (data += c.toString()))
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          data,
        })
        done()
      })
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const email = { from: 'Kanbanto <noreply@example.com>', to: 'bob@example.com', subject: 'Hello over SMTP', html: '<p>Hi</p>', text: 'Hi' }
type Smtp = Extract<Credentials, { provider: 'smtp' }>
const smtp = (over: Partial<Smtp> = {}): Smtp => ({
  provider: 'smtp',
  host: '127.0.0.1',
  port,
  security: 'none',
  username: 'ann',
  password: 'secret',
  allowSelfSigned: false,
  ...over,
})

describe('sending through an SMTP server', () => {
  it('signs in and delivers', async () => {
    const { id } = await providerTransport.send(smtp(), email)
    expect(id).toBeTruthy()
    const got = received.at(-1)!
    expect(got).toMatchObject({ from: 'noreply@example.com', to: ['bob@example.com'] })
    expect(got.data).toContain('Subject: Hello over SMTP')
  })

  it('explains a refused password, and doesn’t retry it', async () => {
    const err = await providerTransport.send(smtp({ password: 'wrong' }), email).catch((e: SendError) => e)
    expect(err).toBeInstanceOf(SendError)
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(/refused the username or password/) })
  })

  it('explains a server it can’t reach, and retries later', async () => {
    const err = await providerTransport.send(smtp({ port: 1 }), email).catch((e: SendError) => e)
    expect(err).toMatchObject({ permanent: false, message: expect.stringMatching(/Couldn’t connect to 127\.0\.0\.1:1.*Check the host and port/) })
  })
})

describe('encryption', () => {
  /** A server that speaks TLS from the start, with smtp-server's built-in self-signed certificate. */
  let tls: SMTPServer
  let tlsPort = 0
  beforeAll(async () => {
    tls = new SMTPServer({ secure: true, authOptional: true, logger: false, onData: (s, _session, done) => s.on('end', () => done()).resume() })
    tls.on('error', () => {}) // clients that refuse its certificate hang up mid-handshake
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
    tlsPort = (tls.server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => tls.close(() => resolve())))

  it('refuses a self-signed certificate unless allowed', async () => {
    const creds = smtp({ port: tlsPort, security: 'tls', username: null, password: null })
    const err = await providerTransport.send(creds, email).catch((e: SendError) => e)
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(/certificate isn’t trusted.*Allow a self-signed certificate/) })
    await expect(providerTransport.send({ ...creds, allowSelfSigned: true }, email)).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('explains TLS on a port that doesn’t speak it', async () => {
    const err = await providerTransport.send(smtp({ security: 'tls' }), email).catch((e: SendError) => e)
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(/encryption matches the port/) })
  })

  it('explains STARTTLS on a server that doesn’t offer it', async () => {
    const err = await providerTransport.send(smtp({ security: 'starttls' }), email).catch((e: SendError) => e)
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(/doesn’t offer STARTTLS/) })
  })
})

describe('SMTP_URL', () => {
  it('reads the server, encryption, sign-in and options', () => {
    expect(parseSmtpUrl('smtp://ann%40corp.com:p%40ss@smtp.corp.com')).toEqual({
      host: 'smtp.corp.com',
      port: 587,
      security: 'starttls',
      username: 'ann@corp.com',
      password: 'p@ss',
      allowSelfSigned: false,
    })
    expect(parseSmtpUrl('smtps://u:p@smtp.example.com')).toMatchObject({ port: 465, security: 'tls' })
    expect(parseSmtpUrl('smtp://relay.internal?security=none&allow_self_signed=true')).toEqual({
      host: 'relay.internal',
      port: 25,
      security: 'none',
      username: null,
      password: null,
      allowSelfSigned: true,
    })
  })

  it('says what’s wrong with a bad setting', () => {
    expect(() => parseSmtpUrl('smtp.example.com:587')).toThrow(/smtp:\/\/ or smtps:\/\/|valid address/)
    expect(() => parseSmtpUrl('smtp://x.example.com?security=ssl')).toThrow(/tls, starttls or none/)
    expect(() => serverSender({ smtpUrl: 'smtp://x.example.com' })).toThrow(/SMTP_FROM/)
    expect(serverSender({})).toBeNull()
    expect(serverSender({ smtpUrl: 'smtp://x.example.com', smtpFrom: 'X <x@example.com>' })).toMatchObject({
      provider: 'smtp',
      fromServer: true,
      keyHint: 'x.example.com:587',
    })
  })
})
