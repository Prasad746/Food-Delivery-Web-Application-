import User from "../models/user.model.js"
import { buildFoodRecommendations, parseRecommendationLimit } from "../services/recommendation.service.js"

export const getFoodRecommendations = async (req, res) => {
    try {
        const { limit, error } = parseRecommendationLimit(req.query?.limit)
        if (error) {
            return res.status(400).json({ success: false, message: error })
        }

        const requester = await User.findById(req.userId).select("role")
        if (!requester) {
            return res.status(401).json({ success: false, message: "User not found" })
        }
        if (requester.role !== "user") {
            return res.status(403).json({ success: false, message: "Recommendations are available to customers only" })
        }

        const result = await buildFoodRecommendations({ userId: requester._id, limit })
        return res.status(200).json({ success: true, ...result })
    } catch (error) {
        console.error("getFoodRecommendations error:", error)
        return res.status(500).json({ success: false, message: "Internal server error" })
    }
}
