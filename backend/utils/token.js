import jwt from "jsonwebtoken"
import crypto from "crypto"
import { normalizeAuthVersion } from "./authVersion.js"
import { getJwtSecret } from "../config/security.js"

const genToken=async (userId, authVersion=0) => {
    try {
        const version=normalizeAuthVersion(authVersion) ?? 0
        const token= jwt.sign({userId, authVersion: version, jti: crypto.randomUUID()},getJwtSecret(),{expiresIn:"7d"})
        return token
    } catch (error) {
        console.error("token generation failed:", error?.message || "unknown error")
        throw error
    }
}

export default genToken