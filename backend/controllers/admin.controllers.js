import User from "../models/user.model.js"
import { USER_ROLES } from "../utils/roles.js"

export const getAdminSummary = async (req, res) => {
    try {
        const counts = await User.aggregate([
            { $group: { _id: "$role", count: { $sum: 1 } } }
        ])
        const users = Object.fromEntries(USER_ROLES.map((role) => [role, 0]))
        let total = 0
        for (const entry of counts) {
            if (Object.prototype.hasOwnProperty.call(users, entry._id)) {
                users[entry._id] = entry.count
            }
            total += entry.count
        }
        res.set("Cache-Control", "no-store")
        return res.status(200).json({ users: { total, ...users } })
    } catch (error) {
        console.error("admin summary error:", error)
        return res.status(500).json({ message: "Unable to load admin summary" })
    }
}
