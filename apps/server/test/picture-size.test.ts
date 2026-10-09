import { describe, expect, it } from 'vitest'
import { pictureSize, pictureType } from '../src/routes/files'

// The first bytes of real pictures, 256 pixels by 256, as an image library wrote them.
const STARTS = {
  png: '89504e470d0a1a0a0000000d4948445200000100000001000802000000d3103f31',
  'webp, lossy': '52494646c40000005745425056503820b80000003011009d012a000100013e6d369949a42322a120',
  'webp, lossless': '5249464624000000574542505650384c180000002fffc03f0007508f22d7a3ff010045faff9f22fa',
  'webp, with see-through parts': '52494646f000000057454250565038580a00000010000000ff0000ff0000414c5048120000000107',
}
const from = (hex: string) => Buffer.from(hex, 'hex')
/** A JPEG as far as the part that says its size, with `before` other parts in front of it (as a camera's notes are). */
const jpeg = (width: number, height: number, before = 0, mark = 0xc0) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...Array.from({ length: before }, () => Buffer.concat([Buffer.from([0xff, 0xe1, 0x01, 0x02]), Buffer.alloc(0x100)])),
    Buffer.from([0xff, mark, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ])

describe('how big a picture says it is', () => {
  it('is read from the start of a PNG, a JPEG and each kind of WebP, without drawing anything', () => {
    for (const [name, hex] of Object.entries(STARTS)) {
      const bytes = from(hex)
      expect([name, pictureSize(bytes, pictureType(bytes)!)]).toEqual([name, { width: 256, height: 256 }])
    }
    expect(pictureSize(jpeg(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
    // (After a camera's notes, however many; and a picture saved to come in gradually says it in another part.)
    expect(pictureSize(jpeg(3000, 17, 40), 'image/jpeg')).toEqual({ width: 3000, height: 17 })
    expect(pictureSize(jpeg(300, 200, 2, 0xc2), 'image/jpeg')).toEqual({ width: 300, height: 200 })
  })

  it('is nothing when the file ends before it says, says nothing, or isn’t one of these', () => {
    for (const hex of Object.values(STARTS)) {
      const bytes = from(hex)
      expect(pictureSize(bytes.subarray(0, 18), pictureType(bytes)!)).toBeNull()
    }
    expect(pictureSize(jpeg(640, 480).subarray(0, 6), 'image/jpeg')).toBeNull()
    expect(pictureSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg')).toBeNull()
    expect(pictureSize(jpeg(0, 480), 'image/jpeg')).toBeNull()
    expect(pictureSize(from(STARTS.png), 'image/gif')).toBeNull()
    // (A JPEG made of parts that never get to the picture is read to its end once, and no further.)
    expect(pictureSize(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200_000, 0xff)]), 'image/jpeg')).toBeNull()
  })
})
