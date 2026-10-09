// The languages a code block can say it is in (```ts): their names as people know them, and the other ways the same
// language is written. Small, and known at once: what colours a language's words (highlight.ts) is fetched only when
// a text has code in it.

export interface CodeLang {
  /** As it is written after the fence, and what the colouring knows it by. */
  id: string
  label: string
  also?: string[]
}

/** A diagram written as text: drawn, not coloured (see diagram.ts). */
export const DIAGRAM = 'mermaid'

export const CODE_LANGS: CodeLang[] = [
  { id: 'bash', label: 'Shell', also: ['sh', 'shell', 'zsh', 'console'] },
  { id: 'c', label: 'C', also: ['h'] },
  { id: 'cpp', label: 'C++', also: ['c++', 'cc', 'hpp'] },
  { id: 'csharp', label: 'C#', also: ['cs', 'c#'] },
  { id: 'css', label: 'CSS' },
  { id: 'diff', label: 'Diff', also: ['patch'] },
  { id: 'dockerfile', label: 'Dockerfile', also: ['docker'] },
  { id: 'go', label: 'Go', also: ['golang'] },
  { id: 'xml', label: 'HTML', also: ['html', 'svg', 'vue'] },
  { id: 'ini', label: 'INI, TOML', also: ['toml', 'conf', 'env'] },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript', also: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'json', label: 'JSON', also: ['jsonc', 'json5'] },
  { id: 'kotlin', label: 'Kotlin', also: ['kt'] },
  { id: 'markdown', label: 'Markdown', also: ['md'] },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python', also: ['py'] },
  { id: 'ruby', label: 'Ruby', also: ['rb'] },
  { id: 'rust', label: 'Rust', also: ['rs'] },
  { id: 'sql', label: 'SQL', also: ['postgres', 'postgresql', 'mysql', 'sqlite'] },
  { id: 'swift', label: 'Swift' },
  { id: 'typescript', label: 'TypeScript', also: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'yaml', label: 'YAML', also: ['yml'] },
  { id: DIAGRAM, label: 'Diagram (Mermaid)' },
]

const byName = new Map(CODE_LANGS.flatMap((l) => [l.id, ...(l.also ?? [])].map((name) => [name, l] as const)))

/** The language a code block names, when it is one we know (however it is cased, whatever else follows it). */
export const langOf = (named: string | null | undefined): CodeLang | null =>
  byName.get(
    (named ?? '')
      .trim()
      .split(/[\s{,:]/)[0]
      .toLowerCase(),
  ) ?? null
