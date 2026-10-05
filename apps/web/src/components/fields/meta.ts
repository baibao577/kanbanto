import { CalendarBlank, CheckSquare, Hash, LinkSimple, Tag, TextT, type Icon } from '@phosphor-icons/react'
import { FIELD_TYPE_LABEL, type FieldDef, type FieldType, type TextFormat } from '@kanbanto/model/fields'

export const FIELD_ICON: Record<FieldType, Icon> = {
  text: TextT,
  number: Hash,
  date: CalendarBlank,
  choice: Tag,
  checkbox: CheckSquare,
  link: LinkSimple,
}
export const FORMAT_LABEL: Record<TextFormat, string> = { plain: 'Plain text', link: 'A link', email: 'An email address', phone: 'A phone number' }

/** A field in a few words: "Number · ฿", "Choice · 3 options", "Text · a link". */
export function fieldSummary(f: FieldDef): string {
  const type = FIELD_TYPE_LABEL[f.type]
  if (f.type === 'number' && f.unit) return `${type} · ${f.unit}`
  if (f.type === 'text' && f.format && f.format !== 'plain') return `${type} · ${FORMAT_LABEL[f.format].toLowerCase()}`
  if (f.type === 'link') return `${type} · ${f.many ? 'several cards' : 'one card'}`
  if (f.type === 'choice') {
    const n = (f.options ?? []).filter((o) => !o.archived).length
    return `${type} · ${n} ${n === 1 ? 'option' : 'options'}`
  }
  return type
}
