import { describe, expect, it } from 'vitest'
import { fileSafe } from './transfer'

describe('export file names', () => {
  it('keep letters and digits in any language', () => {
    expect(fileSafe('Website launch 2026!')).toBe('website-launch-2026')
    expect(fileSafe('แผนงานไตรมาส 3')).toBe('แผนงานไตรมาส-3')
    expect(fileSafe('ตั้งค่า ระบบ')).toBe('ตั้งค่า-ระบบ')
    expect(fileSafe('Café Crème')).toBe('café-crème')
    expect(fileSafe('計画 / 予定')).toBe('計画-予定')
    expect(fileSafe('***')).toBe('')
  })
})
