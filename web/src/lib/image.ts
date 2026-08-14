/**
 * Shrink a photo in the browser before it goes anywhere.
 *
 * A phone camera writes 4–12 MB per shot. A counselor posting a dozen photos
 * on JCC wifi would spend minutes uploading, and the Supabase free tier is
 * 1 GB total — a season of untouched originals fills it. At 1600px on the long
 * edge a photo still looks right on any phone and lands around 300 KB.
 *
 * Falls back to the original file whenever anything goes wrong. A photo that
 * uploads slowly beats a photo that doesn't upload.
 */
const MAX_EDGE = 1600
const QUALITY = 0.82

export async function downscale(file: File): Promise<File> {
  // HEIC has no canvas decoder in any browser; leave it for the server.
  if (!file.type.startsWith('image/') || file.type === 'image/heic') return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 1_000_000) {
      bitmap.close()
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    )
    if (!blob || blob.size >= file.size) return file

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    return file
  }
}
