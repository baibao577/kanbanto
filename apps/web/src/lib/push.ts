import { api } from '@/api/client'

/** Desktop notifications in this browser: whether they can work, and turning them on or off. */
export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** "granted", "denied" (blocked in the browser's settings) or "default" (not asked yet). */
export const pushPermission = () => (pushSupported() ? Notification.permission : 'denied')

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

/** This browser's subscription, if notifications are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Asks the browser, subscribes, and tells the server about this browser. */
export async function turnOnHere(): Promise<'on' | 'denied'> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied'
  const { publicKey } = await api<{ publicKey: string }>('GET', '/push/key')
  const reg = await registration()
  await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) }))
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  await api('POST', '/push/devices', { endpoint: json.endpoint, keys: json.keys, label: browserLabel() })
  return 'on'
}

/** Stops notifications in this browser (and forgets it on the server). */
export async function turnOffHere(deviceId?: string) {
  const sub = await currentSubscription()
  await sub?.unsubscribe()
  if (deviceId) await api('DELETE', `/push/devices/${deviceId}`)
}

/** "Chrome on Mac", roughly, to tell browsers apart in the list. */
export function browserLabel() {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'A browser'
  const os = /Mac OS X/.test(ua)
    ? 'Mac'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} on ${os}` : browser
}

function fromBase64Url(s: string) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
