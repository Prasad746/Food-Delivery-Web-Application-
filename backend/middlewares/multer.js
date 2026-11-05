import multer from "multer"
import crypto from "crypto"
import fsSync from "node:fs"
import flow from "node:fs/promises"
import path from "path"

// Dedicated upload directory. Uploads are written only beneath this absolute
// path and only with server-generated random names; the client-provided
// filename is never used to build a filesystem path. Test processes can point
// this at an isolated directory so parallel test files never share temporary
// files; production ignores the override and uses the project directory.
export const UPLOAD_DIR = process.env.VINGO_TEST_UPLOAD_DIR
  ? path.resolve(process.env.VINGO_TEST_UPLOAD_DIR)
  : path.resolve(process.cwd(), "public", "uploads")

export const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
])

const EXTENSION_FOR_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
}

// Byte patterns for content-based image detection. Only image
// content that matches one of these signatures is accepted;
// client-declared MIME types and extensions are never trusted alone.
const IMAGE_SIGNATURES = [
  { mime: "image/jpeg", prefix: Buffer.from([0xff, 0xd8, 0xff]) },
  { mime: "image/png", prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { mime: "image/gif", prefix: Buffer.from("GIF8", "latin1") }
]

const detectImageMime = (buffer) => {
  for (const signature of IMAGE_SIGNATURES) {
    if (buffer.subarray(0, signature.prefix.length).equals(signature.prefix)) {
      return signature.mime
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp"
  }
  return null
}

const imageUploadError = (code, message) => {
  const error = new Error(message)
  error.code = code
  error.isUploadError = true
  return error
}

export const detectUploadedMimeType = async (file) => {
  const handle = await flow.open(file.path, "r")
  try {
    const target = Buffer.alloc(16)
    const { buffer } = await handle.read(target, 0, 16, 0)
    return detectImageMime(buffer.subarray(0, buffer.length))
  } finally {
    await handle.close()
  }
}

try {
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true })
} catch (error) {
  console.error("upload directory is not writable")
  throw error
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const extension = EXTENSION_FOR_MIME[file.mimetype]
    if (!extension) {
      return cb(imageUploadError("UNSUPPORTED_IMAGE_TYPE", "Only JPEG, PNG, WEBP or GIF images are allowed."))
    }
    cb(null, `${crypto.randomBytes(16).toString("hex")}${extension}`)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(imageUploadError("UNSUPPORTED_IMAGE_TYPE", "Only JPEG, PNG, WEBP or GIF images are allowed."))
    }
    cb(null, true)
  }
})

const respondUploadError = (res, error) => {
  if (error?.isUploadError) {
    return res.status(415).json({ message: "Only JPEG, PNG, WEBP or GIF images are allowed." })
  }
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ message: "Uploaded file is too large. Maximum size is 5 MB." })
  }
  if (error?.code === "LIMIT_UNEXPECTED_FILE" || error?.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({ message: "Only a single image file may be uploaded." })
  }
  console.error("image upload failed")
  return res.status(400).json({ message: "Failed to process image upload. Please try again." })
}

// Wraps multer's single-file upload: requests that fail multer validation get
// a safe, consistent JSON error and never expose filesystem paths or stacks.
export const secureImageUpload = (fieldName) => {
  const single = upload.single(fieldName)
  return (req, res, next) => {
    single(req, res, (error) => {
      if (error) {
        return respondUploadError(res, error)
      }
      next()
    })
  }
}

// Deletion is restricted to files that resolve inside UPLOAD_DIR so a
// malformed or tampered file record can never remove anything else on disk.
const isInsideUploadDir = (filePath) => {
  const relative = path.relative(UPLOAD_DIR, path.resolve(filePath))
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

const removeUploadedFile = async (file) => {
  if (!file?.path || !isInsideUploadDir(file.path)) {
    return false
  }
  try {
    await flow.unlink(path.resolve(file.path))
    return true
  } catch {
    return false
  }
}

// Content-level validation after the file is written. Mismatched payloads
// (for example text disguised as image/png) are deleted and rejected.
export const validateUploadedImages = async (req, res, next) => {
  if (!req.file) {
    return next()
  }
  try {
    const detectedMime = await detectUploadedMimeType(req.file)
    if (!detectedMime) {
      await removeUploadedFile(req.file)
      return res.status(415).json({ message: "Only JPEG, PNG, WEBP or GIF images are allowed." })
    }
    return next()
  } catch (error) {
    await removeUploadedFile(req.file)
    console.error("image content validation failed")
    return res.status(400).json({ message: "Failed to process image upload. Please try again." })
  }
}

// Best-effort removal of a written upload that its controller will not
// process (authorization failure, unexpected error, missing records, etc.)
// so failed operations leave no lingering temporary files.
export const cleanupUnprocessedUpload = async (req) => {
  if (!req?.file?.path) {
    return
  }
  if (!isInsideUploadDir(req.file.path)) {
    return
  }
  await removeUploadedFile(req.file)
  req.file = undefined
}
