import nodemailer from "nodemailer"
import dotenv from "dotenv"
import { isProduction } from "../config/security.js"
dotenv.config({ quiet: true })

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASS_LENGTH = 8
const PLACEHOLDER_MAIL_PATTERN =
  /^(?:your(?:[\s._-]|$)|replace(?:[\s._-]|$)|change(?:[\s._-]|$)|example(?:[\s._-]|$)|sample(?:[\s._-]|$)|test(?:[\s._-]|$)|demo(?:[\s._-]|$)|placeholder(?:[\s._-]|$)|password$|email$|app[\s._-]?password$)/i

export class MailConfigError extends Error {
    constructor(message = "Email service is not configured correctly", code = "MAIL_NOT_CONFIGURED") {
        super(message)
        this.name = "MailConfigError"
        this.code = code
    }
}

const normalizeMailValue = (value) => typeof value === "string" ? value.trim() : ""

export const validateMailConfig = (env = process.env) => {
    const email = normalizeMailValue(env.EMAIL)
    const pass = normalizeMailValue(env.PASS)
    const valid =
        email !== "" &&
        EMAIL_PATTERN.test(email) &&
        !PLACEHOLDER_MAIL_PATTERN.test(email) &&
        pass.length >= MIN_PASS_LENGTH &&
        !PLACEHOLDER_MAIL_PATTERN.test(pass)

    if (!valid) {
        throw new MailConfigError("Email service is not configured correctly")
    }

    return Object.freeze({ email, pass })
}

const getMailTransport = () => {
    const { email, pass } = validateMailConfig()
    return {
        from: email,
        transporter: nodemailer.createTransport({
            service: "Gmail",
            port: 465,
            secure: true, // true for 465, false for other ports
            auth: {
                user: email,
                pass,
            },
        })
    }
}

const mapMailError = (error) => {
    if (error?.code === "EAUTH") {
        return new MailConfigError("Email service authentication failed", "MAIL_AUTH_FAILED")
    }
    return error
}

export const isMailConfigError = (error) =>
    error?.code === "MAIL_NOT_CONFIGURED" || error?.code === "MAIL_AUTH_FAILED"

let authOtpMailOverride = null

// Test-only seam: replaces the SMTP call for the password-reset OTP mail so
// tests stay deterministic. The production path and message content are
// unchanged; the override cannot be installed when NODE_ENV is "production".
export const setAuthOtpMailSenderForTesting = (sender) => {
    if (isProduction()) {
        return
    }
    authOtpMailOverride = sender
}

export const sendOtpMail=async (to,otp) => {
    if (authOtpMailOverride) {
        return authOtpMailOverride(to, otp)
    }
    const { transporter, from } = getMailTransport()
    try {
        await transporter.sendMail({
            from,
            to,
            subject:"Reset Your Password",
            html:`<p>Your OTP for password reset is <b>${otp}</b>. It expires in 5 minutes.</p>`
        })
    } catch (error) {
        throw mapMailError(error)
    }
}


let deliveryOtpMailOverride = null

// Test-only seam: replaces the SMTP call for delivery OTP mail so tests stay
// deterministic. The production path and message content are unchanged;
// the override cannot be installed when NODE_ENV is "production".
export const setDeliveryOtpMailSenderForTesting = (sender) => {
    if (isProduction()) {
        return
    }
    deliveryOtpMailOverride = sender
}

export const sendDeliveryOtpMail=async (user,otp) => {
    if (deliveryOtpMailOverride) {
        return deliveryOtpMailOverride(user, otp)
    }
    const { transporter, from } = getMailTransport()
    try {
        await transporter.sendMail({
            from,
            to:user.email,
            subject:"Delivery OTP",
            html:`<p>Your OTP for delivery is <b>${otp}</b>. It expires in 5 minutes.</p>`
        })
    } catch (error) {
        throw mapMailError(error)
    }
}
