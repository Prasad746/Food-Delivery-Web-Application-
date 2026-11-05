import User from "../models/user.model.js"
import { ADMIN_ROLE } from "../utils/roles.js"

export const isAdmin = async (req, res, next) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        const user = await User.findById(req.userId).select("role")
        if (!user) {
            return res.status(401).json({ message: "Unauthorized" })
        }
        if (user.role !== ADMIN_ROLE) {
            return res.status(403).json({ message: "Admin access required" })
        }
        next()
    } catch (error) {
        console.error("admin authorization error:", error)
        return res.status(500).json({ message: "Unable to verify admin access" })
    }
}
