import express from "express"
import isAuth from "../middlewares/isAuth.js"
import { createOrderRateLimiter } from "../middlewares/orderRateLimit.js"
import { supportChat } from "../controllers/support.controllers.js"

const router = express.Router()

const supportChatLimiter = createOrderRateLimiter(
    { limit: 30, windowMs: 60 * 1000 },
    { name: "support-chat" }
)

router.post("/chat", isAuth, supportChatLimiter, supportChat)

export default router
