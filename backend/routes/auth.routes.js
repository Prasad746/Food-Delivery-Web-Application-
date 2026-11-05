import express from "express"
import { googleAuth, resetPassword, sendOtp, signIn, signOut, signUp, verifyOtp } from "../controllers/auth.controllers.js"
import { createRateLimitMiddleware } from "../middlewares/orderRateLimit.js"
import { validateSignUp, validateSignIn, validateSendOtp, validateVerifyOtp, validateResetPassword, validateGoogleAuth } from "../utils/validate.js"

const authRouter=express.Router()

// Rate limiter for authentication endpoints
const authLimiter=createRateLimitMiddleware({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: { message: "Too many requests from this IP, please try again after 15 minutes" }
}, { name: "auth" })

authRouter.post("/signup",authLimiter,validateSignUp,signUp)
authRouter.post("/signin",authLimiter,validateSignIn,signIn)
authRouter.post("/signout",signOut)
authRouter.post("/send-otp",authLimiter,validateSendOtp,sendOtp)
authRouter.post("/verify-otp",authLimiter,validateVerifyOtp,verifyOtp)
authRouter.post("/reset-password",authLimiter,validateResetPassword,resetPassword)
authRouter.post("/google-auth",authLimiter,validateGoogleAuth,googleAuth)

export default authRouter