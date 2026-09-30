// Kanbanto's service worker: only for desktop notifications (no offline caching).

self.addEventListener('push', (event) => {
  let m = { title: 'Kanbanto', body: '', url: '/#/' }
  try {
    m = { ...m, ...event.data.json() }
  } catch {
    // Not JSON: show what we can.
  }
  event.waitUntil(self.registration.showNotification(m.title, { body: m.body, tag: m.tag, data: { url: m.url }, icon: '/apple-touch-icon.png' }))
})

// Clicking a notification opens the card: in a tab that's already open, if there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/#/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin)
      if (tab) {
        await tab.focus()
        return tab.navigate(url)
      }
      return self.clients.openWindow(url)
    })(),
  )
})
