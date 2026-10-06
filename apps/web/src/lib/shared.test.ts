import { describe, expect, it } from 'vitest'
import { bookmarkCode, cardFromShared } from './shared'

describe('what a page hands over, as a card', () => {
  it('the bookmark button: the page’s title, its address, and the selected words as a quote', () => {
    expect(cardFromShared({ title: 'Pricing – Acme', url: 'https://acme.example/pricing', text: 'Teams pay per seat.\nBilled yearly.' })).toEqual({
      title: 'Pricing – Acme',
      description: 'https://acme.example/pricing\n\n> Teams pay per seat.\n> Billed yearly.',
    })
    expect(cardFromShared({ title: 'Pricing', url: 'https://acme.example/pricing' })).toEqual({
      title: 'Pricing',
      description: 'https://acme.example/pricing',
    })
  })

  it('a phone’s Share: a link that came as text is found in it, and the words around it kept', () => {
    expect(cardFromShared({ text: 'https://acme.example/pricing' })).toEqual({ title: 'acme.example', description: 'https://acme.example/pricing' })
    expect(cardFromShared({ title: 'Acme pricing', text: 'Look at this https://acme.example/pricing' })).toEqual({
      title: 'Acme pricing',
      description: 'https://acme.example/pricing\n\n> Look at this',
    })
    // Words alone: the first line is the title, and isn't said twice.
    expect(cardFromShared({ text: 'Buy milk' })).toEqual({ title: 'Buy milk', description: '' })
    expect(cardFromShared({ text: 'Buy milk\nand eggs' })).toEqual({ title: 'Buy milk', description: '> and eggs' })
    expect(cardFromShared({})).toEqual({ title: '', description: '' })
  })

  it('the button’s code opens the add page of this site, in a window the page can’t reach', () => {
    const code = bookmarkCode('https://kanbanto.example')
    expect(code.startsWith('javascript:')).toBe(true)
    expect(code).toContain('"https://kanbanto.example/#/add?w=1"')
    expect(code).toContain('noopener')
    expect(code).toContain('encodeURIComponent(document.title)')
  })
})
