import type { CSSProperties, ReactNode } from 'react'

/**
 * The few building blocks the emails need, written for what mail apps accept: layout with tables, every style
 * inline, and fallbacks for Outlook (which draws email with Word). Rendered with @react-email/render.
 */

type Props = { children?: ReactNode; style?: CSSProperties }
/** Props for layout tables: no spacing of their own, and read by screen readers as layout, not data. */
const layout = { role: 'presentation', border: 0, cellPadding: 0, cellSpacing: 0 } as const

export function Html({ children, lang = 'en' }: { children: ReactNode; lang?: string }) {
  return (
    <html lang={lang} dir="ltr">
      {children}
    </html>
  )
}

export function Head({ children }: { children?: ReactNode }) {
  return (
    <head>
      <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
      {/* Stops Apple Mail from resizing text on its own. */}
      <meta name="x-apple-disable-message-reformatting" />
      {children}
    </head>
  )
}

/**
 * The line inbox lists show after the subject. Hidden in the email itself; the filler after it keeps mail apps from
 * adding the start of the email to it. Left out of the plain-text version.
 */
export function Preview({ children }: { children: string }) {
  const text = children.slice(0, 200)
  return (
    <div style={{ display: 'none', overflow: 'hidden', lineHeight: '1px', opacity: 0, maxHeight: 0, maxWidth: 0 }} data-skip-in-text="true">
      {text}
      <div>{' ‌​‍‎‏﻿'.repeat(200 - text.length)}</div>
    </div>
  )
}

/** The page. Some mail apps drop styles on <body>, so they're repeated on a full-width table inside it. */
export function Body({ children, style }: Props) {
  return (
    <body style={{ backgroundColor: style?.backgroundColor, margin: 0, padding: 0 }}>
      <table {...layout} width="100%" style={{ width: '100%' }}>
        <tbody>
          <tr>
            <td style={style}>{children}</td>
          </tr>
        </tbody>
      </table>
    </body>
  )
}

/** A centred column, at most `maxWidth` wide. */
export function Container({ children, style }: Props) {
  return (
    <table {...layout} align="center" width="100%" style={{ maxWidth: '37.5em', ...style }}>
      <tbody>
        <tr style={{ width: '100%' }}>
          <td>{children}</td>
        </tr>
      </tbody>
    </table>
  )
}

/** A block of content. Its padding goes on the cell, where every mail app honours it. */
export function Section({ children, style = {} }: Props) {
  const { padding, ...box } = style
  return (
    <table {...layout} align="center" width="100%" style={box}>
      <tbody>
        <tr>
          <td style={padding === undefined ? undefined : { padding }}>{children}</td>
        </tr>
      </tbody>
    </table>
  )
}

export function Text({ children, style }: Props) {
  return <p style={{ fontSize: 14, lineHeight: '24px', margin: '16px 0', ...style }}>{children}</p>
}

export function Heading({ children, style }: Props) {
  return <h1 style={style}>{children}</h1>
}

export function Link({ children, href, style }: Props & { href: string }) {
  return (
    <a href={href} target="_blank" style={{ color: '#067df7', textDecoration: 'none', ...style }}>
      {children}
    </a>
  )
}

/**
 * A button that works everywhere: a coloured cell with the link inside. Mail apps use the link's padding; Outlook
 * ignores that, so the cell carries the same padding just for Outlook (mso-padding-alt).
 */
export function Button({ children, href, style = {} }: Props & { href: string }) {
  const { backgroundColor, borderRadius, padding, ...text } = style
  return (
    <table {...layout} style={{ borderCollapse: 'separate' }}>
      <tbody>
        <tr>
          <td style={{ backgroundColor, borderRadius, msoPaddingAlt: padding } as CSSProperties}>
            <a href={href} target="_blank" style={{ display: 'inline-block', padding, borderRadius, textDecoration: 'none', ...text }}>
              {children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export function Hr({ style }: { style?: CSSProperties }) {
  return <hr style={{ width: '100%', border: 'none', borderTop: '1px solid #eaeaea', ...style }} />
}
