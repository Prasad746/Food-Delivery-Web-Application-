import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import bcrypt from "bcryptjs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_reset_otp_attempts_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import { signUp, signIn, sendOtp, verifyOtp, resetPassword, MAX_RESET_OTP_ATTEMPTS, RESET_TOKEN_TTL_MS, hashResetToken } from "../controllers/auth.controllers.js"
import { validateSignUp, validateSendOtp, validateSignIn, validateVerifyOtp, validateResetPassword } from "../utils/validate.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import isAuth from "../middlewares/isAuth.js"
import { setAuthOtpMailSenderForTesting } from "../utils/mail.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const INVALID_SIGN_IN_MESSAGE = "Invalid email or password"
const GENERIC_RESET_OTP_SENT_MESSAGE = "If an account exists, an OTP has been sent."
const INVALID_RESET_OTP_MESSAGE = "invalid/expired otp"
const INVALID_RESET_TOKEN_MESSAGE = "invalid or expired reset token"
const here = path.dirname(fileURLToPath(import.meta.url))

let mongo
let app
let authMailCaptures
let resetSeq

const csrfToken = () => jwt.sign({ csrf: "cs-reset-otp", purpose: "initial" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const authPost = (path, body) => {
    const token = csrfToken()
    return request(app)
        .post(path)
        .set("Cookie", `XSRF-TOKEN=${token}`)
        .set("X-XSRF-TOKEN", token)
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)
}

const sendResetOtp = (email) => authPost("/api/auth/send-otp", { email })
const verifyResetOtp = (email, otp) => authPost("/api/auth/verify-otp", { email, otp })
const doResetPassword = (email, newPassword, resetToken) => authPost("/api/auth/reset-password", {
    email,
    newPassword,
    ...(resetToken === undefined ? {} : { resetToken })
})

const tokenCookieFrom = (response) => {
    const cookies = response.headers["set-cookie"] || []
    const tokenCookie = cookies.find((cookie) => cookie.startsWith("token="))
    return tokenCookie ? tokenCookie.slice(0, tokenCookie.indexOf(";")) : null
}

const getProtected = (cookie) => request(app).get("/api/protected").set("Cookie", cookie)

const seedResetUser = async (overrides = {}) => {
    resetSeq += 1
    return User.create({
        fullName: "Reset Person",
        email: `reset${resetSeq}${Date.now()}@t.com`,
        mobile: "9000000100",
        role: "user",
        password: await bcrypt.hash("first-password", 10),
        ...overrides
    })
}

const resetState = async (user) => {
    const doc = await User.findById(user._id).select("+resetOtp +otpExpires +isOtpVerified +otpAttempts +resetPasswordTokenHash +resetPasswordExpires")
    return {
        otp: doc.resetOtp,
        verified: doc.isOtpVerified,
        otpAttempts: doc.otpAttempts,
        otpExpires: doc.otpExpires,
        resetPasswordTokenHash: doc.resetPasswordTokenHash,
        resetPasswordExpires: doc.resetPasswordExpires
    }
}

const rawUserState = async (user) => {
    const raw = await User.collection.findOne({ _id: user._id })
    return {
        resetOtp: raw?.resetOtp,
        otpExpires: raw?.otpExpires,
        otpAttempts: raw?.otpAttempts,
        isOtpVerified: raw?.isOtpVerified,
        resetPasswordTokenHash: raw?.resetPasswordTokenHash,
        resetPasswordExpires: raw?.resetPasswordExpires,
        password: raw?.password
    }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await User.init()

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.post("/api/auth/signup", csrfMiddleware, validateSignUp, signUp)
    app.post("/api/auth/send-otp", csrfMiddleware, validateSendOtp, sendOtp)
    app.post("/api/auth/verify-otp", csrfMiddleware, validateVerifyOtp, verifyOtp)
    app.post("/api/auth/reset-password", csrfMiddleware, validateResetPassword, resetPassword)
    app.post("/api/auth/signin", csrfMiddleware, validateSignIn, signIn)
    app.get("/api/protected", isAuth, (req, res) => res.status(200).json({ userId: req.userId }))

    setAuthOtpMailSenderForTesting(async (to, otp) => {
        authMailCaptures.push({ to, otp })
    })
})

after(async () => {
    setAuthOtpMailSenderForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await User.deleteMany({})
    authMailCaptures = []
    resetSeq = 0
})

describe("password-reset OTP attempt limiting (Stage 6C)", () => {
    test("the exported attempt limit and per-OTP configuration are the documented values", () => {
        assert.strictEqual(typeof MAX_RESET_OTP_ATTEMPTS, "number")
        assert.ok(MAX_RESET_OTP_ATTEMPTS > 0)
    })

    test("incorrect attempts are counted per live OTP, capped, and never leak the code or the counter", async () => {
        const user = await seedResetUser()
        const sent = await sendResetOtp(user.email)
        assert.strictEqual(sent.status, 200)
        assert.strictEqual(sent.body.message, GENERIC_RESET_OTP_SENT_MESSAGE)

        let state = await resetState(user)
        assert.strictEqual(state.otpAttempts || 0, 0, "a fresh OTP starts a fresh attempt budget")
        assert.match(String(state.otp), /^\d{4}$/)
        assert.ok(state.otpExpires > Date.now())
        assert.strictEqual(authMailCaptures.at(-1).otp, state.otp, "the OTP travels only through the mail channel")

        const messages = new Set()
        for (let i = 0; i < MAX_RESET_OTP_ATTEMPTS; i++) {
            const wrong = await verifyResetOtp(user.email, "0000")
            assert.strictEqual(wrong.status, 400)
            assert.strictEqual(wrong.body.message, "invalid/expired otp")
            assert.ok(!wrong.body.message.includes(String(state.otp)), "responses must never include the OTP value")
            assert.deepStrictEqual(Object.keys(wrong.body), ["message"])
            messages.add(wrong.body.message)
        }

        state = await resetState(user)
        assert.strictEqual(state.otpAttempts, MAX_RESET_OTP_ATTEMPTS, "each wrong attempt against the live OTP counts exactly once")
        assert.strictEqual(state.verified, false)
        assert.deepStrictEqual([...messages].sort(), ["invalid/expired otp"])

        const correctAfterCap = await verifyResetOtp(user.email, state.otp)
        assert.strictEqual(correctAfterCap.status, 400)
        assert.strictEqual(correctAfterCap.body.message, INVALID_RESET_OTP_MESSAGE)
        assert.ok(!correctAfterCap.body.message.includes(String(state.otp)))

        const unknownVerify = await verifyResetOtp(`missing-${Date.now()}@t.com`, "0000")
        assert.strictEqual(unknownVerify.status, correctAfterCap.status)
        assert.deepStrictEqual(unknownVerify.body, correctAfterCap.body, "a capped account must be indistinguishable from an unknown account")

        state = await resetState(user)
        assert.strictEqual(state.otpAttempts, MAX_RESET_OTP_ATTEMPTS, "the capped budget must not grow further")
        assert.strictEqual(state.verified, false)

        const anotherWrong = await verifyResetOtp(user.email, "0000")
        assert.strictEqual(anotherWrong.status, 400)
        assert.strictEqual(await resetState(user).then((s) => s.otpAttempts), MAX_RESET_OTP_ATTEMPTS)
    })

    test("concurrent incorrect attempts cannot exceed the configured limit", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp, otpAttempts: initial } = await resetState(user)
        assert.strictEqual(initial || 0, 0)

        const wrongs = await Promise.all(
            Array.from({ length: MAX_RESET_OTP_ATTEMPTS * 2 }, () => verifyResetOtp(user.email, "0000"))
        )
        assert.ok(wrongs.every((r) => r.status === 400))

        const state = await resetState(user)
        assert.strictEqual(state.otpAttempts, MAX_RESET_OTP_ATTEMPTS, "racing attempts must land exactly on the cap")
        assert.strictEqual(state.verified, false)

        const capped = await verifyResetOtp(user.email, otp)
        assert.strictEqual(capped.status, 400)
        assert.strictEqual(capped.body.message, INVALID_RESET_OTP_MESSAGE)
        assert.strictEqual((await resetState(user)).otpAttempts, MAX_RESET_OTP_ATTEMPTS)
    })

    test("an expired OTP is rejected without consuming the attempt budget", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp } = await resetState(user)

        const past = new Date(Date.now() - 60 * 1000)
        await User.updateOne({ _id: user._id }, { otpExpires: past, otpAttempts: undefined })

        const res = await verifyResetOtp(user.email, otp)
        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "invalid/expired otp")

        const state = await resetState(user)
        assert.strictEqual(state.otpAttempts || 0, 0, "an expired window must not count wrong attempts")

        const wrong = await verifyResetOtp(user.email, "0000")
        assert.strictEqual(wrong.status, 400)
        assert.strictEqual((await resetState(user)).otpAttempts || 0, 0)
    })

    test("issuing a new OTP resets the previous attempt counter and invalidates the old code", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const firstOtp = (await resetState(user)).otp

        for (let i = 0; i < MAX_RESET_OTP_ATTEMPTS; i++) {
            await verifyResetOtp(user.email, "0000")
        }
        assert.strictEqual((await resetState(user)).otpAttempts, MAX_RESET_OTP_ATTEMPTS)

        const resent = await sendResetOtp(user.email)
        assert.strictEqual(resent.status, 200)
        const afterResend = await resetState(user)
        assert.strictEqual(afterResend.otpAttempts, 0, "a freshly issued OTP starts a fresh attempt budget")
        assert.notStrictEqual(afterResend.otp, firstOtp, "the new OTP must differ from the exhausted one")

        const staleFirst = await verifyResetOtp(user.email, firstOtp)
        assert.strictEqual(staleFirst.status, 400)
        assert.strictEqual(staleFirst.body.message, "invalid/expired otp")

        const verified = await verifyResetOtp(user.email, afterResend.otp)
        assert.strictEqual(verified.status, 200)
        assert.strictEqual(verified.body.message, "otp verify successfully")
        assert.ok(verified.body.resetToken, "successful OTP verification issues a reset token")

        const consumed = await rawUserState(user)
        assert.strictEqual(consumed.resetOtp, undefined)
        assert.strictEqual(consumed.otpExpires, undefined)
        assert.strictEqual(consumed.otpAttempts, undefined)
        assert.strictEqual(consumed.isOtpVerified, false, "the legacy flag no longer records authorization")
        assert.strictEqual(consumed.resetPasswordTokenHash, hashResetToken(verified.body.resetToken))
        assert.ok(consumed.resetPasswordExpires > new Date(), "the reset authorization expires in the future")

        const repeat = await verifyResetOtp(user.email, afterResend.otp)
        assert.strictEqual(repeat.status, 400, "a consumed OTP must no longer verify")
    })

    test("the password reset requires the single-use reset token and clears every reset trace", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)

        const blocked = await doResetPassword(user.email, "second-password")
        assert.strictEqual(blocked.status, 400)
        assert.strictEqual(blocked.body.message, INVALID_RESET_TOKEN_MESSAGE)
        assert.strictEqual(await rawUserState(user).then((s) => s.otpAttempts), 0, "unverified resets never consume the attempt budget")

        const { otp } = await resetState(user)
        const verified = await verifyResetOtp(user.email, otp)
        assert.strictEqual(verified.status, 200)
        const resetToken = verified.body.resetToken
        assert.ok(resetToken)

        const wrongToken = await doResetPassword(user.email, "second-password", "x".repeat(43))
        assert.strictEqual(wrongToken.status, 400)
        assert.strictEqual(wrongToken.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const done = await doResetPassword(user.email, "second-password", resetToken)
        assert.strictEqual(done.status, 200)
        assert.strictEqual(done.body.message, "password reset successfully")

        const raw = await rawUserState(user)
        assert.strictEqual(raw.resetOtp, undefined, "consumed OTP state is cleared")
        assert.strictEqual(raw.otpExpires, undefined)
        assert.strictEqual(raw.otpAttempts, undefined, "the attempt counter is cleared with the password reset")
        assert.strictEqual(raw.resetPasswordTokenHash, undefined, "the reset token hash is consumed")
        assert.strictEqual(raw.resetPasswordExpires, undefined, "the reset token expiry is consumed")
        assert.strictEqual(raw.isOtpVerified, false, "the legacy flag remains false")

        const bufferPassword = raw.password
        assert.ok(await bcrypt.compare("second-password", bufferPassword), "the new password verifies")
        assert.ok(!(await bcrypt.compare("first-password", bufferPassword)), "the old password no longer verifies")

        const reuse = await doResetPassword(user.email, "third-password", resetToken)
        assert.strictEqual(reuse.status, 400)
        assert.strictEqual(reuse.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const goodSignIn = await authPost("/api/auth/signin", { email: user.email, password: "second-password" })
        assert.strictEqual(goodSignIn.status, 200)
        assert.strictEqual(goodSignIn.body.user.email, user.email)

        const badSignIn = await authPost("/api/auth/signin", { email: user.email, password: "first-password" })
        assert.strictEqual(badSignIn.status, 400)
    })

    test("a redelivered OTP for an unrelated user never verifies against the wrong account", async () => {
        const userA = await seedResetUser()
        const userB = await seedResetUser()

        await sendResetOtp(userA.email)
        await sendResetOtp(userB.email)
        const otpA = (await resetState(userA)).otp
        const otpB = (await resetState(userB)).otp
        assert.strictEqual(otpA !== otpB, true)

        const crossed = await verifyResetOtp(userB.email, otpA)
        assert.strictEqual(crossed.status, 400)
        assert.strictEqual((await resetState(userB)).otpAttempts || 0, 1, "the crossed attempt belongs only to userB")
        assert.strictEqual((await resetState(userA)).otpAttempts || 0, 0)

        const direct = await verifyResetOtp(userB.email, otpB)
        assert.strictEqual(direct.status, 200)
        assert.ok(direct.body.resetToken)
        assert.strictEqual(await rawUserState(userB).then((s) => s.isOtpVerified), false)
        assert.strictEqual(
            await rawUserState(userB).then((s) => s.resetPasswordTokenHash),
            hashResetToken(direct.body.resetToken)
        )
    })
})

describe("authentication account-enumeration responses (Stage 7A.6)", () => {
    test("unknown, wrong-password, and Google-only sign-ins return the same failure without issuing cookies", async () => {
        const passwordUser = await seedResetUser()
        const googleOnly = await User.create({
            fullName: "Google Only",
            email: `googleonly-${Date.now()}@t.com`,
            mobile: "9000000111",
            role: "user",
            firebaseUid: `uid-${Date.now()}`
        })
        const missingEmail = `missing-signin-${Date.now()}@t.com`

        const wrong = await authPost("/api/auth/signin", { email: passwordUser.email, password: "wrong-password" })
        const missing = await authPost("/api/auth/signin", { email: missingEmail, password: "wrong-password" })
        const passwordless = await authPost("/api/auth/signin", { email: googleOnly.email, password: "wrong-password" })

        for (const response of [wrong, missing, passwordless]) {
            assert.strictEqual(response.status, 400)
            assert.deepStrictEqual(response.body, { message: INVALID_SIGN_IN_MESSAGE })
            assert.strictEqual(tokenCookieFrom(response), null)
        }
        assert.strictEqual(await User.exists({ email: missingEmail }), null)
    })

    test("duplicate registration cannot authenticate or mutate the existing account", async () => {
        const existing = await seedResetUser()
        const newEmail = `new-signup-${Date.now()}@t.com`

        const created = await authPost("/api/auth/signup", {
            fullName: "New Person",
            email: newEmail,
            password: "new-person-password",
            mobile: "9000000123",
            role: "user"
        })
        assert.strictEqual(created.status, 201)
        assert.strictEqual(created.body.user.email, newEmail)
        assert.ok(tokenCookieFrom(created), "new registration still authenticates normally")

        const duplicate = await authPost("/api/auth/signup", {
            fullName: "Duplicate Attempt",
            email: existing.email,
            password: "replacement-password",
            mobile: "9000000124",
            role: "user"
        })
        assert.strictEqual(duplicate.status, 400)
        assert.strictEqual(duplicate.body.user, undefined)
        assert.strictEqual(tokenCookieFrom(duplicate), null)

        const stored = await User.findById(existing._id).select("+password")
        assert.strictEqual(stored.fullName, "Reset Person")
        assert.ok(await bcrypt.compare("first-password", stored.password), "the existing password is unchanged")
        assert.ok(!(await bcrypt.compare("replacement-password", stored.password)))
        assert.strictEqual(await User.countDocuments({ email: existing.email }), 1)
    })

    test("send-otp returns the same response for existing and unknown accounts without mailing unknown addresses", async () => {
        const user = await seedResetUser()
        const unknownEmail = `missing-otp-${Date.now()}@t.com`
        const existing = await sendResetOtp(user.email)
        const unknown = await sendResetOtp(unknownEmail)

        assert.strictEqual(existing.status, 200)
        assert.strictEqual(unknown.status, 200)
        assert.deepStrictEqual(existing.body, { message: GENERIC_RESET_OTP_SENT_MESSAGE })
        assert.deepStrictEqual(unknown.body, existing.body)
        assert.ok(authMailCaptures.some((mail) => mail.to === user.email))
        assert.ok(!authMailCaptures.some((mail) => mail.to === unknownEmail))
        assert.strictEqual(await User.exists({ email: unknownEmail }), null)
    })
})

describe("password-reset authorization token (Stage 6J)", () => {
    test("OTP verification issues a high-entropy token and stores only its hash", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp } = await resetState(user)

        const verified = await verifyResetOtp(user.email, otp)
        assert.strictEqual(verified.status, 200)
        assert.strictEqual(verified.body.message, "otp verify successfully")
        assert.deepStrictEqual(Object.keys(verified.body).sort(), ["message", "resetToken"])

        const resetToken = verified.body.resetToken
        assert.match(resetToken, /^[A-Za-z0-9_-]{43}$/, "the token has 256 bits of cryptographically random material")
        assert.ok(RESET_TOKEN_TTL_MS > 0 && RESET_TOKEN_TTL_MS <= 15 * 60 * 1000, "the reset authorization lifetime is short")

        const raw = await rawUserState(user)
        assert.strictEqual(raw.resetPasswordTokenHash, hashResetToken(resetToken), "only the SHA-256 hash is stored")
        assert.notStrictEqual(raw.resetPasswordTokenHash, resetToken)
        assert.strictEqual(raw.resetPasswordToken, undefined, "the raw reset token is never stored")
        assert.strictEqual(raw.resetOtp, undefined)
        assert.strictEqual(raw.otpExpires, undefined)
        assert.strictEqual(raw.otpAttempts, undefined)
        assert.strictEqual(raw.isOtpVerified, false)
        assert.ok(raw.resetPasswordExpires instanceof Date)
        assert.ok(raw.resetPasswordExpires > new Date())
        assert.ok(raw.resetPasswordExpires.getTime() <= Date.now() + RESET_TOKEN_TTL_MS + 5000)
    })

    test("missing, malformed, incorrect, expired, and cross-account tokens are rejected without enumeration", async () => {
        const user = await seedResetUser()
        const other = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp } = await resetState(user)
        const verified = await verifyResetOtp(user.email, otp)
        assert.strictEqual(verified.status, 200)
        const resetToken = verified.body.resetToken

        const missing = await doResetPassword(user.email, "new-password")
        assert.strictEqual(missing.status, 400)
        assert.strictEqual(missing.body.message, INVALID_RESET_TOKEN_MESSAGE, "a missing token gets the generic rejection before any account lookup")

        const malformed = await doResetPassword(user.email, "new-password", "too-short")
        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(malformed.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const nonString = await doResetPassword(user.email, "new-password", { token: resetToken })
        assert.strictEqual(nonString.status, 400)
        assert.strictEqual(nonString.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const wrong = await doResetPassword(user.email, "new-password", "x".repeat(43))
        assert.strictEqual(wrong.status, 400)
        assert.strictEqual(wrong.body.message, INVALID_RESET_TOKEN_MESSAGE)
        assert.deepStrictEqual(Object.keys(wrong.body), ["message"])
        assert.ok(!JSON.stringify(wrong.body).includes(resetToken), "errors never echo the valid token")

        const absent = await doResetPassword(`absent-${Date.now()}@t.com`, "new-password", "x".repeat(43))
        assert.strictEqual(absent.status, 400)
        assert.strictEqual(absent.body.message, wrong.body.message, "existing and absent accounts get the same message")

        const crossed = await doResetPassword(other.email, "new-password", resetToken)
        assert.strictEqual(crossed.status, 400)
        assert.strictEqual(crossed.body.message, wrong.body.message, "a token cannot be used for another account")

        await User.updateOne({ _id: user._id }, { resetPasswordExpires: new Date(Date.now() - 1000) })
        const expired = await doResetPassword(user.email, "new-password", resetToken)
        assert.strictEqual(expired.status, 400)
        assert.strictEqual(expired.body.message, wrong.body.message)

        const current = await User.findById(user._id).select("+password")
        assert.ok(await bcrypt.compare("first-password", current.password), "rejected attempts never change the password")
    })

    test("concurrent reset attempts cannot consume the same token twice", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp } = await resetState(user)
        const verified = await verifyResetOtp(user.email, otp)
        const resetToken = verified.body.resetToken

        const [first, second] = await Promise.all([
            doResetPassword(user.email, "concurrent-a", resetToken),
            doResetPassword(user.email, "concurrent-b", resetToken)
        ])
        const successes = [first, second].filter((response) => response.status === 200)
        assert.strictEqual(successes.length, 1, "exactly one concurrent request consumes the token")
        const winnerPassword = first.status === 200 ? "concurrent-a" : "concurrent-b"
        const loserPassword = first.status === 200 ? "concurrent-b" : "concurrent-a"

        const stored = await User.findById(user._id).select("+password")
        assert.ok(await bcrypt.compare(winnerPassword, stored.password))
        assert.ok(!(await bcrypt.compare(loserPassword, stored.password)))

        const raw = await rawUserState(user)
        assert.strictEqual(raw.resetPasswordTokenHash, undefined)
        assert.strictEqual(raw.resetPasswordExpires, undefined)
        assert.strictEqual((await User.findById(user._id).select("authVersion")).authVersion, 1)

        const reuse = await doResetPassword(user.email, "third-password", resetToken)
        assert.strictEqual(reuse.status, 400)
        assert.strictEqual(reuse.body.message, INVALID_RESET_TOKEN_MESSAGE)
    })

    test("requesting a new OTP invalidates the previous reset token", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const firstOtp = (await resetState(user)).otp
        const firstVerify = await verifyResetOtp(user.email, firstOtp)
        const firstToken = firstVerify.body.resetToken
        assert.ok(firstToken)

        const resent = await sendResetOtp(user.email)
        assert.strictEqual(resent.status, 200)

        const stale = await doResetPassword(user.email, "second-password", firstToken)
        assert.strictEqual(stale.status, 400)
        assert.strictEqual(stale.body.message, INVALID_RESET_TOKEN_MESSAGE)
        assert.strictEqual(await rawUserState(user).then((s) => s.resetPasswordTokenHash), undefined)

        const secondOtp = (await resetState(user)).otp
        const secondVerify = await verifyResetOtp(user.email, secondOtp)
        assert.strictEqual(secondVerify.status, 200)
        assert.notStrictEqual(secondVerify.body.resetToken, firstToken)

        const done = await doResetPassword(user.email, "second-password", secondVerify.body.resetToken)
        assert.strictEqual(done.status, 200)
        assert.ok(await bcrypt.compare("second-password", (await User.findById(user._id).select("+password")).password))
    })

    test("a stale isOtpVerified flag cannot authorize a reset", async () => {
        const user = await seedResetUser()
        await sendResetOtp(user.email)
        const { otp } = await resetState(user)
        await verifyResetOtp(user.email, otp)

        await User.updateOne(
            { _id: user._id },
            {
                $set: { isOtpVerified: true },
                $unset: { resetPasswordTokenHash: 1, resetPasswordExpires: 1 }
            }
        )

        const noToken = await doResetPassword(user.email, "new-password")
        assert.strictEqual(noToken.status, 400)
        assert.strictEqual(noToken.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const wrongToken = await doResetPassword(user.email, "new-password", "y".repeat(43))
        assert.strictEqual(wrongToken.status, 400)
        assert.strictEqual(wrongToken.body.message, INVALID_RESET_TOKEN_MESSAGE)

        const stored = await User.findById(user._id).select("+password")
        assert.ok(await bcrypt.compare("first-password", stored.password), "the legacy flag alone never changes the password")
        assert.strictEqual(await rawUserState(user).then((s) => s.isOtpVerified), true)
    })

    test("ForgotPassword passes the issued reset token and never logs reset responses", async () => {
        const source = await readFile(path.resolve(here, "..", "..", "frontend", "src", "pages", "ForgotPassword.jsx"), "utf8")

        assert.match(source, /const issuedResetToken=result\.data\?\.resetToken/)
        assert.match(source, /setResetToken\(issuedResetToken\)/)

        const resetEndpointIndex = source.indexOf("/api/auth/reset-password")
        assert.ok(resetEndpointIndex > -1)
        assert.match(source.slice(resetEndpointIndex, resetEndpointIndex + 200), /resetToken/)
        assert.ok(!source.includes("console.log"), "reset responses containing tokens must never be logged")
    })
})

describe("password-reset session revocation", () => {
    test("resetting a password invalidates existing HTTP sessions and scopes the revocation to that user", async () => {
        const user = await seedResetUser()
        const other = await seedResetUser()

        const initialSignIn = await authPost("/api/auth/signin", { email: user.email, password: "first-password" })
        assert.strictEqual(initialSignIn.status, 200)
        const oldCookie = tokenCookieFrom(initialSignIn)
        assert.ok(oldCookie, "sign-in issues an auth cookie")

        const beforeReset = await getProtected(oldCookie)
        assert.strictEqual(beforeReset.status, 200)
        assert.strictEqual(beforeReset.body.userId, String(user._id))

        const otherToken = jwt.sign({ userId: String(other._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })
        const otherBefore = await getProtected(`token=${otherToken}`)
        assert.strictEqual(otherBefore.status, 200)

        await sendResetOtp(user.email)
        const { otp } = await resetState(user)
        const verified = await verifyResetOtp(user.email, otp)
        assert.strictEqual(verified.status, 200)

        const reset = await doResetPassword(user.email, "second-password", verified.body.resetToken)
        assert.strictEqual(reset.status, 200)

        const afterReset = await getProtected(oldCookie)
        assert.strictEqual(afterReset.status, 401, "the pre-reset session must be rejected")
        assert.strictEqual(afterReset.body.userId, undefined)

        const stored = await User.findById(user._id).select("authVersion")
        assert.strictEqual(stored.authVersion, 1)

        const otherAfter = await getProtected(`token=${otherToken}`)
        assert.strictEqual(otherAfter.status, 200, "another user's session must remain valid")

        const freshSignIn = await authPost("/api/auth/signin", { email: user.email, password: "second-password" })
        assert.strictEqual(freshSignIn.status, 200)
        const freshCookie = tokenCookieFrom(freshSignIn)
        const freshPayload = jwt.decode(freshCookie.slice("token=".length))
        assert.strictEqual(freshPayload.authVersion, 1)

        const freshSession = await getProtected(freshCookie)
        assert.strictEqual(freshSession.status, 200)
        assert.strictEqual(freshSession.body.userId, String(user._id))
    })
})
