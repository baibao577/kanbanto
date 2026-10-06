/** What a page handed over to "add a card": from the bookmark button, or from another app's Share on a phone. */
export interface Shared {
  title?: string
  url?: string
  text?: string
}

const ADDRESS = /https?:\/\/[^\s<>"']+/i

/**
 * The card it makes: a title to start from, and what goes in the description (the page's address, then any words
 * that were selected or shared). Phones often send a link as text, with or without words around it: the address is
 * taken out of them. With no title, the first line of the words is one, or the address's site.
 */
export function cardFromShared({ title = '', url = '', text = '' }: Shared): { title: string; description: string } {
  let address = url.trim()
  let words = text.trim()
  if (!address) {
    const found = ADDRESS.exec(words)
    if (found) {
      address = found[0]
      words = (words.slice(0, found.index) + words.slice(found.index + found[0].length)).trim()
    }
  }
  if (words === address) words = ''
  let name = title.trim()
  if (!name && words) {
    // (The words are the title, and not said twice when that's all of them.)
    const [first, ...rest] = words.split('\n')
    name = first.trim().slice(0, 200)
    words = first.trim().length <= 200 ? rest.join('\n').trim() : words
  }
  if (!name && address) {
    try {
      name = new URL(address).hostname.replace(/^www\./, '')
    } catch {
      name = address
    }
  }
  return { title: name.slice(0, 500), description: [address, words && `> ${words.replace(/\n/g, '\n> ')}`].filter(Boolean).join('\n\n') }
}

/**
 * The bookmark button's code: opens the add page in a small window with the page's title, its address and the
 * selected words (2,000 characters of them). `noopener`: the page it was clicked on can't reach that window.
 */
export const bookmarkCode = (site: string) =>
  `javascript:(function(){var s=String(window.getSelection?window.getSelection():'').slice(0,2000);window.open(${JSON.stringify(`${site}/#/add?w=1`)}+'&title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href)+'&text='+encodeURIComponent(s),'_blank','noopener,width=520,height=640')})()`
