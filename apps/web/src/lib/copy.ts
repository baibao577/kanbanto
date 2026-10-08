import { toast } from 'sonner'

/** Puts `text` on the clipboard and says so ("Link copied"), or says how to do it by hand when the browser won't. */
export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast.error('Couldn’t copy. Select it and copy it yourself.')
  }
}
