import mongoose from "mongoose"
import User from "../models/user.model.js"
import { handleSupportMessage } from "../services/supportChatbot.service.js"
import { validateSupportChatBody } from "../utils/validate.js"

const SUPPORT_ERROR_MESSAGE =
    "Unable to process your support request right now. Please try again."

export const supportChat = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.userId)) {
            return res.status(401).json({ message: "Invalid or expired token" })
        }

        const user = await User.findById(req.userId).select("role").lean()
        if (!user) {
            return res.status(401).json({ message: "Invalid or expired token" })
        }
        if (user.role !== "user") {
            return res.status(403).json({
                message: "Support chat is available to customer accounts only"
            })
        }

        const validation = validateSupportChatBody(req.body)
        if (validation.error) {
            return res.status(400).json({
                success: false,
                message: validation.error
            })
        }

        const result = await handleSupportMessage({
            message: validation.message,
            userId: req.userId,
            contextOrderId: validation.orderId
        })

        return res.status(200).json(result)
    } catch (error) {
        if (process.env.NODE_ENV !== "test") {
            console.error("Support chat request failed:", error?.message)
        }
        return res.status(500).json({
            success: false,
            message: SUPPORT_ERROR_MESSAGE
        })
    }
}
