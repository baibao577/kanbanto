import type { PublicUser } from '@kanbanto/model/api'

/** A profile picture is a square this many pixels across: several times the biggest circle it's drawn in. */
const SIDE = 256

const UNREADABLE = 'That file isn’t a picture this browser can read. Try a JPG or PNG.'

const square = (side: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = side
  const g = canvas.getContext('2d')
  if (!g) throw new Error(UNREADABLE)
  g.imageSmoothingQuality = 'high'
  return { canvas, g }
}

/**
 * Makes a profile picture from a file someone chose: a square cut from its middle, shrunk to 256 pixels, as WebP
 * (JPEG where the browser can't write WebP: asked for one, it hands back a PNG, which is several times bigger).
 * See-through parts turn white. A file that isn't a picture is refused with words for the person.
 */
export async function squarePicture(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(UNREADABLE))
      el.src = url
    })
    let side = Math.min(img.naturalWidth, img.naturalHeight)
    if (!side) throw new Error(UNREADABLE)
    let from: CanvasImageSource = img
    let x = (img.naturalWidth - side) / 2
    let y = (img.naturalHeight - side) / 2
    // A big photo is halved until it's near the size wanted: shrunk in one go, it comes out jagged.
    while (side / 2 > SIDE) {
      const half = square(Math.ceil(side / 2))
      half.g.drawImage(from, x, y, side, side, 0, 0, half.canvas.width, half.canvas.width)
      from = half.canvas
      side = half.canvas.width
      x = y = 0
    }
    const { canvas, g } = square(SIDE)
    g.fillStyle = '#fff'
    g.fillRect(0, 0, SIDE, SIDE)
    g.drawImage(from, x, y, side, side, 0, 0, SIDE, SIDE)
    const as = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88))
    const webp = await as('image/webp')
    const picture = webp?.type === 'image/webp' ? webp : await as('image/jpeg')
    if (!picture) throw new Error(UNREADABLE)
    return picture
  } finally {
    URL.revokeObjectURL(url)
  }
}

const answer = async (res: Response | null) => {
  const json = res ? await res.json().catch(() => null) : null
  if (!res?.ok)
    throw new Error(json?.error ?? (res ? `Something went wrong (${res.status}).` : 'Can’t reach the server. Check your connection and try again.'))
  return (json as { user: PublicUser }).user
}

/** Saves your profile picture (its bytes as they are, like a file on a card). Gives back your account with it. */
export const savePicture = async (picture: Blob) =>
  answer(
    await fetch('/api/account/picture', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': picture.type },
      body: picture,
    }).catch(() => null),
  )

/** Takes your profile picture away: you show as your initials again. */
export const removePicture = async () =>
  answer(await fetch('/api/account/picture', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null))
