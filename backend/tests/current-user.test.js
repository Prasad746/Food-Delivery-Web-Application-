import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import bcrypt from "bcryptjs"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_current_user_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import authRouter from "../routes/auth.routes.js"
import userRouter from "../routes/user.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { setAuthOtpMailSenderForTesting } from "../utils/mail.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app
let authMailCaptures

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-current-user", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const get = (path, whichToken) =>
    request(app)
        .get(path)
        .set("Cookie", whichToken ? `token=${whichToken}; XSRF-TOKEN=${csrfToken()}` : `XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)

const authPost = (path, body) =>
    request(app)
        .post(path)
        .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

let seq = 0
const seedProfileUser = async (overrides = {}) => {
    seq += 1
    return User.create({
        fullName: "Profile Person",
        email: `profile${seq}${Date.now()}@t.com`,
        mobile: "9000000011",
        role: "user",
        location: { type: "Point", coordinates: [73.8, 18.5] },
        ...overrides
    })
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await User.init()

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/user", csrfMiddleware, userRouter)
    app.use("/api/auth", csrfMiddleware, authRouter)

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
})

const SENSITIVE_FIELDS = ["password", "authVersion", "resetOtp", "otpExpires", "isOtpVerified", "resetPasswordTokenHash", "resetPasswordExpires", "socketId", "firebaseUid", "isOnline"]
const PROFILE_KEYS = ["_id", "fullName", "email", "mobile", "role", "location"]

describe("current-user profile exposure (Stage 6B)", () => {
    test("the current-user endpoint returns the allowlisted profile and never sensitive fields", async () => {
        const user = await seedProfileUser()
        await User.updateOne({ _id: user._id }, {
            resetOtp: "4321",
            otpExpires: new Date(Date.now() + 5 * 60 * 1000),
            isOtpVerified: true,
            resetPasswordTokenHash: "reset-token-hash",
            resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000),
            socketId: "socket-xyz-1",
            isOnline: true
        })

        const res = await get("/api/user/current", tokenFor(user._id))

        assert.strictEqual(res.status, 200)
        assert.strictEqual(String(res.body._id), String(user._id))
        assert.strictEqual(res.body.fullName, "Profile Person")
        assert.strictEqual(res.body.email, user.email)
        assert.strictEqual(res.body.mobile, "9000000011")
        assert.strictEqual(res.body.role, "user")
        assert.deepStrictEqual([...res.body.location.coordinates], [73.8, 18.5])

        const responseKeys = Object.keys(res.body)
        for (const field of PROFILE_KEYS) {
            assert.ok(responseKeys.includes(field), `current-user must expose ${field}`)
        }
        for (const key of responseKeys) {
            assert.ok(PROFILE_KEYS.includes(key), `current-user returns an unexpected key: ${key}`)
        }
        for (const field of SENSITIVE_FIELDS) {
            assert.strictEqual(res.body[field], undefined, `current-user must never return ${field}`)
        }
    })

    test("a user cannot read another user's profile through this endpoint", async () => {
        const userA = await seedProfileUser()
        const userB = await seedProfileUser({ fullName: "Other Person" })

        const res = await get(`/api/user/current?userId=${userB._id}`, tokenFor(userA._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(String(res.body._id), String(userA._id), "identity must come from the verified token, not the query string")
        assert.strictEqual(res.body.fullName, "Profile Person")

        const anon = await get("/api/user/current", null)
        assert.strictEqual(anon.status, 401)
        assert.strictEqual(anon.body._id, undefined)
    })

    test("password verification still works and auth responses expose no credentials", async () => {
        const email = `signin${Date.now()}@t.com`
        const signup = await authPost("/api/auth/signup", { fullName: "Sign In Person", email, password: "secret-password", mobile: "9000000021", role: "user" })
        assert.strictEqual(signup.status, 201)
        assert.strictEqual(signup.body.user.email, email)
        for (const field of SENSITIVE_FIELDS) {
            assert.strictEqual(signup.body.user[field], undefined, `signup response must not include ${field}`)
        }

        const good = await authPost("/api/auth/signin", { email, password: "secret-password" })
        assert.strictEqual(good.status, 200)
        assert.strictEqual(good.body.user.email, email)
        assert.strictEqual(good.body.user.fullName, "Sign In Person")
        for (const field of SENSITIVE_FIELDS) {
            assert.strictEqual(good.body.user[field], undefined, `signin response must not include ${field}`)
        }

        const bad = await authPost("/api/auth/signin", { email, password: "wrong-password" })
        assert.strictEqual(bad.status, 400)
        assert.strictEqual(bad.body.message, "Invalid email or password")

        const stored = await User.findOne({ email }).select("+password")
        assert.ok(await bcrypt.compare("secret-password", stored.password), "the stored password hash still verifies the original password")
    })

    test("the password-reset flow still works end to end", async () => {
        const email = `reset${Date.now()}@t.com`
        await User.create({
            fullName: "Reset Person",
            email,
            mobile: "9000000031",
            role: "user",
            password: await bcrypt.hash("first-password", 10)
        })

        const send = await authPost("/api/auth/send-otp", { email })
        assert.strictEqual(send.status, 200)
        assert.ok(authMailCaptures.some((mail) => mail.to === email), "the reset OTP is delivered through the mail channel")

        const otpDoc = await User.findOne({ email }).select("+resetOtp +otpExpires +isOtpVerified")
        assert.strictEqual(otpDoc.resetOtp, authMailCaptures[authMailCaptures.length - 1].otp)
        assert.ok(otpDoc.otpExpires > Date.now(), "the reset OTP carries a fresh expiry")
        assert.strictEqual(otpDoc.isOtpVerified, false)

        const verify = await authPost("/api/auth/verify-otp", { email, otp: otpDoc.resetOtp })
        assert.strictEqual(verify.status, 200)

        const verifiedDoc = await User.findOne({ email }).select("+resetOtp +otpExpires +isOtpVerified +resetPasswordTokenHash +resetPasswordExpires")
        assert.strictEqual(verifiedDoc.resetOtp, undefined, "the consumed OTP is cleared")
        assert.strictEqual(verifiedDoc.otpExpires, undefined)
        assert.strictEqual(verifiedDoc.isOtpVerified, false, "the legacy flag never records authorization")
        assert.ok(verifiedDoc.resetPasswordTokenHash, "the reset authorization is stored as a hash")
        assert.ok(verifiedDoc.resetPasswordExpires > Date.now())
        assert.ok(verify.body.resetToken, "the reset token is returned once after OTP verification")

        const reset = await authPost("/api/auth/reset-password", {
            email,
            newPassword: "second-password",
            resetToken: verify.body.resetToken
        })
        assert.strictEqual(reset.status, 200)

        const after = await User.findOne({ email }).select("+password +isOtpVerified +resetPasswordTokenHash +resetPasswordExpires")
        assert.ok(!(await bcrypt.compare("first-password", after.password)), "the old password must stop verifying")
        assert.ok(await bcrypt.compare("second-password", after.password), "the new password verifies")
        assert.strictEqual(after.isOtpVerified, false, "the legacy flag remains false")
        assert.strictEqual(after.resetPasswordTokenHash, undefined, "the reset token hash is consumed")
        assert.strictEqual(after.resetPasswordExpires, undefined, "the reset token expiry is consumed")

        const fresh = await authPost("/api/auth/signin", { email, password: "second-password" })
        assert.strictEqual(fresh.status, 200)
        assert.strictEqual(fresh.body.user.email, email)
    })

    test("a wrong OTP is rejected and never flips the verification flag", async () => {
        const email = `wrongotp${Date.now()}@t.com`
        await User.create({ fullName: "Wrong OTP Person", email, mobile: "9000000041", role: "user" })
        await authPost("/api/auth/send-otp", { email })

        const wrong = await authPost("/api/auth/verify-otp", { email, otp: "9999" })
        assert.strictEqual(wrong.status, 400)
        assert.match(wrong.body.message, /invalid/i)

        const doc = await User.findOne({ email }).select("+isOtpVerified +resetOtp")
        assert.strictEqual(doc.isOtpVerified, false)
        assert.strictEqual(doc.resetOtp, authMailCaptures[authMailCaptures.length - 1].otp, "the correct OTP is still the only accepted code")
    })
})
