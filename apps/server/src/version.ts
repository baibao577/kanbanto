import { version } from '../package.json'

/** The day the server was built: put in by the build (tsup.config.ts), so there's none when run from the source. */
declare const __BUILT__: string | undefined

/**
 * Which Kanbanto this is: the `version` in the server's package.json (the release it's from), and the day it was
 * built. A copy built from the main branch between two releases still says the last release's number: the day is
 * what tells such copies apart. No day (null) when run straight from the source, as in development.
 */
export const VERSION: { number: string; built: string | null } = {
  number: version,
  built: typeof __BUILT__ === 'string' ? __BUILT__ : null,
}

/** "0.1.0 (built 2026-10-07)", for the log and the command line. */
export const versionWords = () => `${VERSION.number}${VERSION.built ? ` (built ${VERSION.built})` : ''}`
