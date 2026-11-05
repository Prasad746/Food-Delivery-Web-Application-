import { v2 as cloudinary } from 'cloudinary'
import fs from "node:fs/promises"
import path from "node:path"
import { UPLOAD_DIR } from "../middlewares/multer.js"
import { isProduction } from "../config/security.js"

const configureCloudinary = () => {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

const isInsideUploadDir = (file) => {
    const relative = path.relative(UPLOAD_DIR, path.resolve(file))
    return (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    )
}

const removeTemporaryFile = async (file) => {
    if (!file || !isInsideUploadDir(file)) {
        return
    }
    try {
        await fs.unlink(path.resolve(file))
    } catch {
        return
    }
}

const uploadOnCloudinary = async (file) => {
    if (!file) {
        return undefined
    }
    configureCloudinary()
    try {
        const result = await cloudinaryUploadForCloudinary(file)
        return result?.secure_url
    } catch (error) {
    console.error("Cloudinary upload failed:", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        http_code: error?.http_code
    });
    throw error;
} finally {
        await removeTemporaryFile(file)
    }
}

let cloudinaryOverride = null
let cloudinaryDeleterOverride = null

// Test-only seam: injects a stand-in for the network call only. The local
// upload lifecycle (including temporary-file removal above) is shared by both
// paths, so tests observe exactly the production file-cleanup behavior. Guarded
// like the Razorpay seam: the override cannot be installed in production.
export const setCloudinaryUploaderForTesting = (uploader) => {
    if (isProduction()) {
        return
    }
    cloudinaryOverride = uploader
}

export const setCloudinaryDeleterForTesting = (deleter) => {
    if (isProduction()) {
        return
    }
    cloudinaryDeleterOverride = deleter
}

const cloudinaryUploadForCloudinary = async (file) => {
    if (cloudinaryOverride) {
        return cloudinaryOverride(file)
    }
    return cloudinary.uploader.upload(file)
}

export const cloudinaryPublicIdFromUrl = (url) => {
    if (typeof url !== "string" || url === "") {
        return null
    }
    let parsed
    try {
        parsed = new URL(url)
    } catch {
        return null
    }
    if (parsed.hostname !== "res.cloudinary.com") {
        return null
    }
    const parts = parsed.pathname.split("/").filter(Boolean)
    const uploadIndex = parts.indexOf("upload")
    if (uploadIndex === -1) {
        return null
    }
    if (process.env.CLOUDINARY_CLOUD_NAME && parts[0] !== process.env.CLOUDINARY_CLOUD_NAME) {
        return null
    }
    const remaining = parts.slice(uploadIndex + 1)
    if (/^v\d+$/.test(remaining[0] || "")) {
        remaining.shift()
    }
    const assetPath = [...remaining]
    if (assetPath.length === 0) {
        return null
    }
    const filename = assetPath.pop().replace(/\.[a-zA-Z0-9]+$/, "")
    if (!filename) {
        return null
    }
    assetPath.push(filename)
    return assetPath.join("/")
}

export const deleteCloudinaryAsset = async (url) => {
    if (typeof url !== "string" || url === "") {
        return false
    }
    if (cloudinaryDeleterOverride) {
        try {
            await cloudinaryDeleterOverride(url)
            return true
        } catch {
            console.error("cloudinary cleanup failed")
            return false
        }
    }
    const publicId = cloudinaryPublicIdFromUrl(url)
    if (!publicId) {
        return false
    }
    configureCloudinary()
    try {
        const result = await cloudinary.uploader.destroy(publicId)
        return result?.result === "ok" || result?.result === "not found"
    } catch {
        console.error("cloudinary cleanup failed")
        return false
    }
}

export default uploadOnCloudinary
