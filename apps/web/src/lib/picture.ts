import type { PublicUser } from '@kanbanto/model/api'

/** A profile picture is a square this many pixels across: several times the biggest circle it's drawn in. */
const SIDE = 256

const UNREADABLE = 'That file isn’t a picture this browser can read. Try a JPG or PNG.'

const sheet = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error(UNREADABLE)
  g.imageSmoothingQuality = 'high'
  return { canvas, g }
}
const square = (side: number) => sheet(side, side)

/** The picture in a file, read by the browser (which is what says whether it is one). */
const readImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error(UNREADABLE))
    el.src = url
  })

/** A canvas as a WebP (JPEG where the browser can't write WebP: asked for one, it hands back a PNG, several times bigger). */
async function written(canvas: HTMLCanvasElement, quality: number) {
  const as = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  const webp = await as('image/webp')
  const picture = webp?.type === 'image/webp' ? webp : await as('image/jpeg')
  if (!picture) throw new Error(UNREADABLE)
  return picture
}

/**
 * Makes a profile picture from a file someone chose: a square cut from its middle, shrunk to 256 pixels, as WebP
 * (JPEG where the browser can't write WebP: asked for one, it hands back a PNG, which is several times bigger).
 * See-through parts turn white. A file that isn't a picture is refused with words for the person.
 */
export async function squarePicture(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await readImage(url)
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
    return await written(canvas, 0.88)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A cover's small copy is at most this wide and this tall: twice the widest a card is drawn, on a phone too. */
const COVER_WIDE = 640
const COVER_TALL = 1280
/** …and this big, under what the server takes (see routes/covers.ts on the server). */
const COVER_MAX = 280 * 1024

/**
 * Makes the small copy of a picture that is becoming a card's cover: the whole picture (the Board cuts it to its
 * frame when it draws it, so the cut can change without making these again), no wider than 640 pixels and no taller
 * than 1280, as WebP or JPEG. See-through parts turn white. A picture already that small is written again all the
 * same: what's kept is always one of the kinds a browser writes. A GIF gives its first frame.
 */
export async function coverPicture(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await readImage(url)
    let w = img.naturalWidth
    let h = img.naturalHeight
    if (!w || !h) throw new Error(UNREADABLE)
    const scale = Math.min(1, COVER_WIDE / w, COVER_TALL / h)
    const wide = Math.max(1, Math.round(w * scale))
    const tall = Math.max(1, Math.round(h * scale))
    let from: CanvasImageSource = img
    // (Halved until it's near the size wanted, as for a profile picture: shrunk in one go, it comes out jagged.)
    while (w / 2 > wide) {
      const half = sheet(Math.ceil(w / 2), Math.ceil(h / 2))
      half.g.drawImage(from, 0, 0, w, h, 0, 0, half.canvas.width, half.canvas.height)
      from = half.canvas
      w = half.canvas.width
      h = half.canvas.height
    }
    const { canvas, g } = sheet(wide, tall)
    g.fillStyle = '#fff'
    g.fillRect(0, 0, wide, tall)
    g.drawImage(from, 0, 0, w, h, 0, 0, wide, tall)
    // (A busy picture can come out big: then it's written a little rougher.)
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const picture = await written(canvas, quality)
      if (picture.size <= COVER_MAX) return picture
    }
    throw new Error('That picture couldn’t be made small enough for a cover.')
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
