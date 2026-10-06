import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from '@/app/auth'
import { InboxProvider } from '@/app/inbox'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { reloadForUpdate } from '@/lib/reload'
import { ThemeProvider } from '@/app/theme'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App'
import './index.css'

// After an update, parts of the old app that load on demand are gone: reload once to get the new one.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForUpdate()) e.preventDefault()
})

// Something shared to Kanbanto from another app on a phone arrives at /share (see the manifest): that's the add page.
if (location.pathname === '/share') history.replaceState(null, '', `/#/add${location.search}`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        <ErrorBoundary>
          <AuthProvider>
            <InboxProvider>
              <App />
            </InboxProvider>
          </AuthProvider>
        </ErrorBoundary>
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
