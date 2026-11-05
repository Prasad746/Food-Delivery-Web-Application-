import jwt from "jsonwebtoken"
import crypto from "crypto"
import User from "../models/user.model.js"
import { sanitizeUserProfile } from "./user.controllers.js"
import bcrypt from "bcryptjs"
import genToken from "../utils/token.js"
import { verifyFirebaseIdToken } from "../utils/firebase-admin.js"
import { isMailConfigError, sendOtpMail } from "../utils/mail.js"
import { validateSignUp, validateSignIn, validateSendOtp, validateVerifyOtp, validateResetPassword, validateGoogleAuth } from "../utils/validate.js"
import { disconnectSessionSockets, disconnectUserSockets } from "../socket.js"
import { revokeSessionToken } from "../utils/sessionRevocation.js"
import { getCookieOptions, getJwtSecret } from "../config/security.js"
import { resolvePublicSignupRole } from "../utils/roles.js"

export { getCookieOptions }

const INVALID_SIGN_IN_MESSAGE = "Invalid email or password"
const GENERIC_RESET_OTP_SENT_MESSAGE = "If an account exists, an OTP has been sent."
const INVALID_RESET_OTP_MESSAGE = "invalid/expired otp"
const dummyPasswordHashPromise = bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10).catch(() => null)

const generateAndSetCsrfCookie = (res, purpose) => {
  const csrfId = crypto.randomBytes(32).toString("base64")
  const signedCsrf = jwt.sign(
    { csrf: csrfId, purpose },
    getJwtSecret(),
    { expiresIn: purpose === "post-login" ? "7d" : "24h" }
  )
  const { sameSite, secure } = getCookieOptions()
  res.cookie("XSRF-TOKEN", signedCsrf, {
    httpOnly: false,
    sameSite,
    secure,
    maxAge: purpose === "post-login" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
  })
  return signedCsrf
}

export const signUp = async (req, res) => {
  try {
    const { fullName, email, password, mobile, role } = req.body
    const assignedRole = resolvePublicSignupRole(role)
    if (!assignedRole) {
      return res.status(400).json({ message: "Invalid role" })
    }
    let user = await User.findOne({ email })
    if (user) {
      return res.status(400).json({ message: "User Already exist." })
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "password must be at least 6 characters." })
    }
    if (mobile.length < 10) {
      return res.status(400).json({ message: "mobile no must be at least 10 digits." })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    user = await User.create({
      fullName,
      email,
      role: assignedRole,
      mobile,
      password: hashedPassword,
    })

    const token = await genToken(user._id, user.authVersion)
    res.cookie("token", token, getCookieOptions())

    const csrfToken = generateAndSetCsrfCookie(res, "initial")
    res.status(201).json({ user: sanitizeUserProfile(user), csrfToken })
  } catch (error) {
    console.error("sign up error:", error)
    return res.status(500).json({ message: "Sign up failed" })
  }
}

export const signIn = async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await User.findOne({ email }).select("+password")
    const hasPassword = typeof user?.password === "string" && user.password.length > 0
    const storedPasswordHash = hasPassword ? user.password : await dummyPasswordHashPromise
    const isMatch = await bcrypt.compare(password, storedPasswordHash).catch(() => false)
    if (!user || !hasPassword || !isMatch) {
      return res.status(400).json({ message: INVALID_SIGN_IN_MESSAGE })
    }

    const token = await genToken(user._id, user.authVersion)
    res.cookie("token", token, getCookieOptions())

    const csrfToken = generateAndSetCsrfCookie(res, "post-login")
    res.status(200).json({ user: sanitizeUserProfile(user), csrfToken })
  } catch (error) {
    console.error("sign in error:", error)
    return res.status(500).json({ message: "Sign in failed" })
  }
}

export const signOut=async (req,res) => {
    try {
        const token = req.cookies?.token || req.headers?.authorization?.replace(/^Bearer\s+/, "")
        let revokedSessionHash = null

        if (token) {
            let decodedToken = null
            try {
                decodedToken = jwt.verify(token, getJwtSecret())
            } catch {
                decodedToken = null
            }
            if (decodedToken?.userId) {
                revokedSessionHash = await revokeSessionToken(token, decodedToken)
            }
        }

        const { secure, sameSite } = getCookieOptions()
        res.clearCookie("token", {
            secure,
            sameSite,
            httpOnly: true
        });
        res.clearCookie("XSRF-TOKEN", {
            httpOnly: false,
            secure,
            sameSite
        });
        if (revokedSessionHash) {
            disconnectSessionSockets(req.app?.get?.("io"), revokedSessionHash)
        }
        return res.status(200).json({message:"log out successfully"})
    } catch (error) {
        console.error("sign out error")
        return res.status(500).json({ message: "Sign out failed" })
    }
}

export const sendOtp=async (req,res) => {
  try {
    const {email}=req.body
    const user=await User.findOne({email}).select("_id")
    if(!user){
       return res.status(200).json({message:GENERIC_RESET_OTP_SENT_MESSAGE})
    }
    const otp=crypto.randomInt(1000, 10000).toString()
    await User.updateOne(
      { _id: user._id },
      {
        $set: { resetOtp: otp, otpExpires: Date.now()+5*60*1000, otpAttempts: 0, isOtpVerified: false },
        // A newly issued OTP always invalidates any earlier reset authorization.
        $unset: { resetPasswordTokenHash: 1, resetPasswordExpires: 1 }
      }
    )
    await sendOtpMail(email,otp)
    return res.status(200).json({message:GENERIC_RESET_OTP_SENT_MESSAGE})
  } catch (error) {
     if (isMailConfigError(error)) {
        console.error("send otp error: email service is unavailable")
        return res.status(503).json({ message: "Email service is unavailable. Please try again later." })
     }
     console.error("send otp error:", error?.code || "unknown");
     return res.status(500).json({ message: "Failed to send OTP" })
  }
}

export const MAX_RESET_OTP_ATTEMPTS = 5
export const RESET_TOKEN_TTL_MS = 10 * 60 * 1000
export const hashResetToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex")

const hasLiveResetOtp = (user, now) =>
  Boolean(user && user.resetOtp && user.otpExpires && user.otpExpires > now)

const guardLiveResetOtp = (userId, storedOtp, now) => ({
  _id: userId,
  resetOtp: storedOtp,
  otpExpires: { $gt: now },
  otpAttempts: { $not: { $gte: MAX_RESET_OTP_ATTEMPTS } }
})

// Every wrong-code count and the verify-and-consume write are applied through
// guarded MongoDB updates so concurrent requests cannot exceed the attempt
// budget, apply attempts to a rotated OTP, or verify past expiry or a spent
// window.
export const verifyOtp=async (req,res) => {
    try {
        const {email,otp}=req.body
        const now=Date.now()
        const user=await User.findOne({email}).select("+resetOtp +otpExpires +otpAttempts")
        if(!hasLiveResetOtp(user,now)){
            return res.status(400).json({message:INVALID_RESET_OTP_MESSAGE})
        }
        if((user.otpAttempts||0)>=MAX_RESET_OTP_ATTEMPTS){
            return res.status(400).json({message:INVALID_RESET_OTP_MESSAGE})
        }

        const storedOtp=String(user.resetOtp)
        if(storedOtp!==String(otp)){
            await User.updateOne(
                guardLiveResetOtp(user._id,storedOtp,now),
                { $inc: { otpAttempts: 1 } }
            )
            return res.status(400).json({message:INVALID_RESET_OTP_MESSAGE})
        }

        // The OTP exchange is completed atomically with the issuance of a
        // short-lived, single-use reset credential. Only its hash is stored;
        // the raw token is returned once in this response and is never logged.
        const resetToken=crypto.randomBytes(32).toString("base64url")
        const resetPasswordTokenHash=hashResetToken(resetToken)
        const resetPasswordExpires=new Date(now + RESET_TOKEN_TTL_MS)
        const verified=await User.updateOne(
            guardLiveResetOtp(user._id,storedOtp,now),
            {
                $set: { resetPasswordTokenHash, resetPasswordExpires, isOtpVerified: false },
                $unset: { resetOtp: 1, otpExpires: 1, otpAttempts: 1 }
            }
        )
        if(verified.modifiedCount===0){
            return res.status(400).json({message:INVALID_RESET_OTP_MESSAGE})
        }
        return res.status(200).json({message:"otp verify successfully", resetToken})
    } catch (error) {
         console.error("verify otp error:", error);
         return res.status(500).json({ message: "Failed to verify OTP" })
    }
}

export const resetPassword=async (req,res) => {
    try {
        const {email,newPassword,resetToken}=req.body
        if(typeof resetToken!=="string" || resetToken.trim()===""){
            return res.status(400).json({message:"invalid or expired reset token"})
        }
        const tokenHash=hashResetToken(resetToken.trim())
        const hashedPassword=await bcrypt.hash(newPassword,10)
        // Read the clock after hashing so a token that expires during the
        // request cannot be consumed after its deadline.
        const now=Date.now()
        // Filtering on the hash and expiry makes consumption atomic: only one
        // of any concurrent requests can match before the credential is unset.
        const resetUser=await User.findOneAndUpdate(
            {
                email,
                resetPasswordTokenHash: tokenHash,
                resetPasswordExpires: { $gt: now }
            },
            {
                $set: { password: hashedPassword, isOtpVerified: false },
                $inc: { authVersion: 1 },
                $unset: {
                    resetPasswordTokenHash: 1,
                    resetPasswordExpires: 1,
                    resetOtp: 1,
                    otpExpires: 1,
                    otpAttempts: 1
                }
            },
            { new: true, projection: { _id: 1 } }
        )
        if(!resetUser){
            return res.status(400).json({message:"invalid or expired reset token"})
        }
        disconnectUserSockets(req.app?.get?.("io"), resetUser._id)
        return res.status(200).json({message:"password reset successfully"})
    } catch (error) {
         console.error("reset password error:", error);
         return res.status(500).json({ message: "Failed to reset password" })
    }
}

export const googleAuth=async (req,res) => {
    try {
        const {firebaseToken, mobile, role}=req.body
        if(!firebaseToken){
            return res.status(400).json({message:"Firebase ID token required"})
        }
        const assignedRole=resolvePublicSignupRole(role)
        if(!assignedRole){
            return res.status(400).json({message:"Invalid role"})
        }

        const decodedToken=await verifyFirebaseIdToken(firebaseToken)
        const {uid,email}=decodedToken

        if(
            typeof uid!=="string" || uid.trim()==="" ||
            typeof email!=="string" || email.trim()===""
        ) {
            return res.status(401).json({message:"Firebase token does not contain an account identity"})
        }
        if(decodedToken.email_verified !== true) {
            return res.status(401).json({message:"Google authentication failed"})
        }

        const googleDisplayName=(typeof decodedToken.name==="string" && decodedToken.name.trim())||(typeof decodedToken.fullName==="string" && decodedToken.fullName.trim())||""

        let user=await User.findOne({firebaseUid:uid})
        if(!user){
            const existingEmailUser=await User.findOne({email})
            if(existingEmailUser){
                return res.status(409).json({message:"An account with this email already exists. Please sign in with your email and password."})
            }
            const normalizedMobile=String(mobile||"").trim()
            if(normalizedMobile.length<10 || normalizedMobile.length>15){
                return res.status(400).json({message:"Mobile number is required to complete Google sign up (10-15 digits).", needsMobile:true})
            }
            user=await User.create({
                fullName:googleDisplayName||email||"User",
                email,
                role:assignedRole,
                mobile:normalizedMobile,
                firebaseUid:uid
            })
        }else{
            if(user.fullName===null||user.fullName==="") {
                user.fullName=googleDisplayName||email||"User"
                await user.save()
            }
        }

        const token=await genToken(user._id, user.authVersion)
        res.cookie("token",token,getCookieOptions())

        const csrfToken=generateAndSetCsrfCookie(res,"post-login")
        return res.status(200).json({ user: sanitizeUserProfile(user), csrfToken })


    } catch (error) {
         console.error("googleAuth error:", error);
         if(error?.code === 11000 && /firebaseUid/.test(error?.message || "")) {
             return res.status(409).json({ message: "This Google account is already registered. Please try signing in again." })
         }
         if(error?.message === "Invalid or expired Firebase ID token") {
             return res.status(401).json({ message: "Invalid or expired Firebase ID token" })
         }
         return res.status(500).json({ message: "Google authentication failed" })
    }
}