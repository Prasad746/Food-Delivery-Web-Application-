import User from "../models/user.model.js"
import { ADMIN_ROLE } from "./roles.js"

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const provisionAdmin = async ({ email } = {}) => {
    const normalizedEmail = String(email || "").trim()
    if (!normalizedEmail) {
        return { ok: false, reason: "email-required" }
    }

    const matches = await User.find({
        email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: "i" }
    }).limit(2)

    if (matches.length === 0) {
        return { ok: false, reason: "not-found", email: normalizedEmail }
    }
    if (matches.length > 1) {
        return { ok: false, reason: "ambiguous-email", email: normalizedEmail }
    }

    const user = matches[0]
    const alreadyAdmin = user.role === ADMIN_ROLE
    if (!alreadyAdmin) {
        user.role = ADMIN_ROLE
        await user.save()
    }

    return {
        ok: true,
        id: String(user._id),
        email: user.email,
        role: user.role,
        alreadyAdmin
    }
}
