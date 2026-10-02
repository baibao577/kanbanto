import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ThemeContext, type Theme } from './use-theme'

// Keep in sync with the inline script in index.html, which applies the theme before first paint.
const KEY = 'kankan:theme'

const readTheme = (): Theme => {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Light / dark / follow the system, applied as a `dark` class on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [dark, setDark] = useState(() => (theme === 'system' ? systemDark() : theme === 'dark'))

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => setDark(theme === 'system' ? media.matches : theme === 'dark')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    // The browser's bars, and an installed app's (the phone's status bar and bottom bar), take their colors from these.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#18191c' : '#f9fafb')
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', dark ? '/manifest-dark.webmanifest' : '/manifest.webmanifest')
  }, [dark])

  const setTheme = useCallback((t: Theme | string) => {
    const next: Theme = t === 'light' || t === 'dark' ? t : 'system'
    setThemeState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme: dark ? 'dark' : 'light' }}>{children}</ThemeContext.Provider>
}
