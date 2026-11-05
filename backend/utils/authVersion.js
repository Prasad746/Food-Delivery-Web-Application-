import User from "../models/user.model.js"

export const normalizeAuthVersion = (value) => {
    const version = Number(value ?? 0)
    return Number.isInteger(version) && version >= 0 ? version : null
}

export const isCurrentAuthVersion = async (userId, authVersion) => {
    const claimed = normalizeAuthVersion(authVersion)
    if (claimed === null) {
        return false
    }
    try {
        const user = await User.findById(userId).select("authVersion").lean()
        if (!user) {
            return false
        }
        return normalizeAuthVersion(user.authVersion) === claimed
    } catch {
        return false
    }
}
