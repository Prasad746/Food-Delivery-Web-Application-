import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import { createRateLimitStore } from "./mongoRateLimitStore.js"

export const ORDER_RATE_LIMITS = {
    placeOrder: { limit: 10, windowMs: 60 * 1000 },
    verifyPayment: { limit: 30, windowMs: 5 * 60 * 1000 },
    cancelOrder: { limit: 10, windowMs: 60 * 1000 },
    sendDeliveryOtp: { limit: 5, windowMs: 5 * 60 * 1000 },
    verifyDeliveryOtp: { limit: 20, windowMs: 5 * 60 * 1000 },
    rating: { limit: 20, windowMs: 60 * 1000 },
    upload: { limit: 20, windowMs: 15 * 60 * 1000 }
}

export const createRateLimitMiddleware = (options, {
    name = "default",
    store,
    config
} = {}) => {
    const resolvedStore = store ?? createRateLimitStore({
        name,
        windowMs: options.windowMs,
        config
    })

    return rateLimit({
        ...options,
        passOnStoreError: false,
        ...(resolvedStore ? { store: resolvedStore } : {})
    })
}

export const createOrderRateLimiter = ({ limit, windowMs }, {
    name = "order",
    store,
    config
} = {}) => createRateLimitMiddleware({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.userId ? `u:${req.userId}` : `ip:${ipKeyGenerator(req.ip)}`),
    handler: (req, res) => {
        return res.status(429).json({ message: "Too many requests. Please try again later." })
    }
}, { name, store, config })
