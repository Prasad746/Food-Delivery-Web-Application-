import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_logout_session_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import RevokedSession from "../models/revokedSession.model.js"
import authRouter from "../routes/auth.routes.js"
import isAuth from "../middlewares/isAuth.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import genToken from "../utils/token.js"
import { hashSessionToken } from "../utils/sessionRevocation.js"
import { roomForSession } from "../socket.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const UNTRUSTED_ORIGIN = "http://evil.example"

let mongo
let app
let userSeq = 0
let csrfSeq = 0
let disconnectCalls = []

const seedUser = async (authVersion = 0) => {
    userSeq += 1
    return User.create({
        fullName: "Logout Person",
        email: `logout${userSeq}${Date.now()}@t.com`,
        mobile: `91000${String(userSeq).padStart(5, "0")}`,
        role: "user",
        authVersion
    })
}

const tokenForUser = async (user) => {
    const token = await genToken(user._id, user.authVersion ?? 0)
    assert.ok(token, "token generation must succeed")
    return token
}

const getProtected = (token) =>
    request(app)
        .get("/api/protected")
        .set("Cookie", `token=${token}`)

const makeCsrfToken = () => {
    csrfSeq += 1
    return jwt.sign(
        { csrf: `logout-csrf-${csrfSeq}`, purpose: "initial" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    )
}

const logout = (token, {
    useAuthorizationHeader = false,
    method = "post",
    origin = TRUSTED_ORIGIN,
    csrfToken = makeCsrfToken(),
    csrfCookie = csrfToken,
    sendCsrfHeader = true
} = {}) => {
    const req = request(app)[method]("/api/auth/signout")
    if (origin) {
        req.set("Origin", origin)
    }

    const cookies = []
    if (token && !useAuthorizationHeader) {
        cookies.push(`token=${token}`)
    }
    if (csrfCookie !== null && csrfCookie !== undefined) {
        cookies.push(`XSRF-TOKEN=${csrfCookie}`)
    }
    if (cookies.length) {
        req.set("Cookie", cookies.join("; "))
    }
    if (token && useAuthorizationHeader) {
        req.set("Authorization", `Bearer ${token}`)
    }
    if (sendCsrfHeader && csrfToken) {
        req.set("X-XSRF-TOKEN", csrfToken)
    }
    return req
}

const assertSessionUntouched = async (token) => {
    assert.equal((await getProtected(token)).status, 200)
    assert.equal(await RevokedSession.countDocuments({}), 0)
    assert.deepEqual(disconnectCalls, [])
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await User.init()
    await RevokedSession.init()

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.set("io", {
        in(room) {
            return {
                disconnectSockets(close) {
                    disconnectCalls.push({ room, close })
                }
            }
        }
    })
    app.use("/api/auth", csrfMiddleware, authRouter)
    app.get("/api/protected", isAuth, (req, res) => res.json({ userId: String(req.userId) }))
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await User.deleteMany({})
    await RevokedSession.deleteMany({})
    disconnectCalls = []
})

describe("Stage 6K/6N logout session revocation and CSRF protection", () => {
    test("auth routes register signout as POST only, with no GET handler left", () => {
        const layer = authRouter.stack.find((entry) => entry.route && entry.route.path === "/signout")
        assert.ok(layer, "signout route is registered")
        assert.equal(layer.route.methods.post, true)
        assert.ok(!("get" in layer.route.methods), "GET signout handler must be removed")
    })

    test("a valid CSRF-protected POST logout clears cookies, revokes the presented token, and disconnects its socket room", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        assert.equal((await getProtected(token)).status, 200)

        const res = await logout(token)
        assert.equal(res.status, 200)
        assert.equal(res.body.message, "log out successfully")

        const setCookie = res.headers["set-cookie"] || []
        const clearedCookies = setCookie.join(";")
        assert.match(clearedCookies, /token=;/)
        assert.match(clearedCookies, /XSRF-TOKEN=;/)
        assert.match(clearedCookies, /HttpOnly/)

        const revoked = await RevokedSession.findOne({ tokenHash: hashSessionToken(token) })
        assert.ok(revoked, "the exact presented token must be recorded as revoked")
        assert.ok(revoked.expiresAt > Date.now(), "the revocation must outlive the token")
        assert.deepEqual(disconnectCalls, [{
            room: roomForSession(hashSessionToken(token)),
            close: true
        }])

        assert.equal((await getProtected(token)).status, 401)
    })

    test("POST logout without a CSRF token is rejected before the session is touched", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, { sendCsrfHeader: false })
        assert.equal(res.status, 403)
        assert.equal(res.body.message, "Missing CSRF token")
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("POST logout with a missing CSRF cookie is rejected before the session is touched", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, { csrfToken: makeCsrfToken(), csrfCookie: null })
        assert.equal(res.status, 403)
        assert.equal(res.body.message, "CSRF token cookie missing")
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("POST logout with mismatched CSRF cookie and header is rejected before the session is touched", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, {
            csrfToken: makeCsrfToken(),
            csrfCookie: makeCsrfToken()
        })
        assert.equal(res.status, 403)
        assert.equal(res.body.message, "CSRF token mismatch")
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("POST logout with an invalid CSRF token is rejected before the session is touched", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)
        const invalidCsrf = "not-a-valid-csrf-token"

        const res = await logout(token, {
            csrfToken: invalidCsrf,
            csrfCookie: invalidCsrf
        })
        assert.equal(res.status, 403)
        assert.equal(res.body.message, "Invalid or expired CSRF token")
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("POST logout from an untrusted origin is rejected before the session is touched", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, { origin: UNTRUSTED_ORIGIN })
        assert.equal(res.status, 403)
        assert.equal(res.body.message, "Invalid origin")
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("GET signout cannot log the user out, revoke the session, or clear cookies", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, { method: "get" })
        assert.equal(res.status, 404)
        assert.equal(res.headers["set-cookie"], undefined)
        await assertSessionUntouched(token)
    })

    test("a copied token stays rejected and repeated logout is safe", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        assert.equal((await logout(token)).status, 200)
        assert.equal((await getProtected(token)).status, 401)

        const again = await logout(token)
        assert.equal(again.status, 200)
        assert.equal((await getProtected(token)).status, 401)
        assert.equal(await RevokedSession.countDocuments({}), 1)

        const noToken = await logout(null)
        assert.equal(noToken.status, 200)
        assert.equal(await RevokedSession.countDocuments({}), 1)
    })

    test("logging out one session does not revoke another session or another user", async () => {
        const user = await seedUser()
        const otherUser = await seedUser()
        const tokenA = await tokenForUser(user)
        const tokenB = await tokenForUser(user)
        const otherToken = await tokenForUser(otherUser)
        assert.notEqual(tokenA, tokenB)

        assert.equal((await logout(tokenA)).status, 200)
        assert.equal((await getProtected(tokenA)).status, 401)
        assert.equal((await getProtected(tokenB)).status, 200)
        assert.equal((await getProtected(otherToken)).status, 200)
        assert.equal(await RevokedSession.countDocuments({}), 1)
        assert.deepEqual(disconnectCalls.map((call) => call.room), [roomForSession(hashSessionToken(tokenA))])
    })

    test("an invalid logout request cannot revoke a valid session", async () => {
        const user = await seedUser()
        const otherUser = await seedUser()
        const userToken = await tokenForUser(user)
        const otherToken = await tokenForUser(otherUser)

        const res = await logout("not-a-valid-token")
        assert.equal(res.status, 200)
        assert.equal(await RevokedSession.countDocuments({}), 0)
        assert.equal((await getProtected(userToken)).status, 200)
        assert.equal((await getProtected(otherToken)).status, 200)
    })

    test("a legacy token without a jti can still be revoked by its exact token hash", async () => {
        const user = await seedUser()
        const legacyToken = jwt.sign(
            { userId: String(user._id) },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        )

        assert.equal((await getProtected(legacyToken)).status, 200)
        assert.equal((await logout(legacyToken)).status, 200)
        assert.equal((await getProtected(legacyToken)).status, 401)
        assert.ok(await RevokedSession.exists({ tokenHash: hashSessionToken(legacyToken) }))
    })

    test("a token supplied through the Authorization header is also revoked", async () => {
        const user = await seedUser()
        const token = await tokenForUser(user)

        const res = await logout(token, { useAuthorizationHeader: true })
        assert.equal(res.status, 200)
        assert.equal((await getProtected(token)).status, 401)
    })
})
