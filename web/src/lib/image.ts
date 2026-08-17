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

function isHeic(file: File): boolean {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.hei[cf]$/i.test(file.name)
  )
}

/**
 * HEIC to JPEG first. It is the default camera format on every iPhone, and
 * no browser can decode it into a <canvas> — without this step it skipped
 * the resize below entirely and uploaded at full size, up to the server's
 * 8 MB cap. heic2any decodes it in-browser (WASM); nothing new touches the
 * server. Falls back to the original bytes if the decode fails for any
 * reason, same as before this existed.
 *
 * Imported dynamically: the decoder bundles ~1.3 MB of WASM, and every
 * parent, admin and superadmin who never touches this screen was paying to
 * download it on first load. This way only a counselor who actually posts a
 * HEIC photo fetches it, once, the first time they do.
 */
async function toJpegIfHeic(file: File): Promise<File> {
  if (!isHeic(file)) return file
  try {
    const { default: heic2any } = await import('heic2any')
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: QUALITY,
    })
    const blob = Array.isArray(converted) ? converted[0] : converted
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg',
    })
  } catch {
    return file
  }
}

export async function downscale(rawFile: File): Promise<File> {
  const file = await toJpegIfHeic(rawFile)
  if (!file.type.startsWith('image/')) return file

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
