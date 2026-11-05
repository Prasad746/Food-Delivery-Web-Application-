import crypto from "crypto"
import RevokedSession from "../models/revokedSession.model.js"

const FALLBACK_REVOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const hashSessionToken = (token) =>
    crypto.createHash("sha256").update(String(token)).digest("hex")

const resolveExpiry = (decoded) => {
    const expirySeconds = Number(decoded?.exp)
    if (Number.isFinite(expirySeconds) && expirySeconds > 0) {
        return new Date(expirySeconds * 1000)
    }
    return new Date(Date.now() + FALLBACK_REVOCATION_TTL_MS)
}

export const revokeSessionToken = async (token, decoded) => {
    const tokenHash = hashSessionToken(token)
    try {
        await RevokedSession.updateOne(
            { tokenHash },
            {
                $setOnInsert: {
                    tokenHash,
                    expiresAt: resolveExpiry(decoded)
                }
            },
            { upsert: true }
        )
        return tokenHash
    } catch (error) {
        if (error?.code === 11000) {
            return tokenHash
        }
        throw error
    }
}

export const isSessionTokenRevoked = async (token) => {
    if (typeof token !== "string" || token === "") {
        return false
    }
    try {
        return Boolean(await RevokedSession.exists({ tokenHash: hashSessionToken(token) }))
    } catch {
        return true
    }
}
