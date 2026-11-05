import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_google_auth_secret_for_integration_testing"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""
process.env.FIREBASE_PROJECT_ID = "integration-stub-project"
process.env.FIREBASE_PRIVATE_KEY = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
}).privateKey
process.env.FIREBASE_CLIENT_EMAIL = "integration-stub@example.iam.gserviceaccount.com"

import User from "../models/user.model.js"
import authRouter from "../routes/auth.routes.js"
import { googleAuth } from "../controllers/auth.controllers.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { initializeFirebaseAdmin } from "../utils/firebase-admin.js"
import { getAuth } from "firebase-admin/auth"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

let stubbedDecoded = null
let stubbedError = null
let authInstance = null
let originalVerifyIdToken = null

const authRequest = (path, body, { purpose = "post-login" } = {}) => {
    const csrf = jwt.sign({ csrf: "g-shared", purpose }, process.env.JWT_SECRET, { expiresIn: "1h" })
    return request(app)
        .post(path)
        .set("Origin", TRUSTED_ORIGIN)
        .set("X-XSRF-TOKEN", csrf)
        .set("Cookie", [`XSRF-TOKEN=${csrf}`])
        .send(body)
}

const fixture = ({ uid, email = `g${Date.now()}${Math.floor(Math.random()*1000)}@example.com`, name, email_verified = true, omitEmailVerified = false }) => {
    stubbedDecoded = { uid, email, ...(name ? { name } : {}) }
    if (!omitEmailVerified) {
        stubbedDecoded.email_verified = email_verified
    }
    return `google-api-id-token:${uid}`
}

const invokeGoogleAuth = async (body) => {
    const result = { statusCode: null, body: null, cookies: [] }
    const req = { body }
    const res = {
        status(code) {
            result.statusCode = code
            return this
        },
        json(payload) {
            result.body = payload
            return this
        },
        cookie(name, value, options) {
            result.cookies.push({ name, value, options })
            return this
        }
    }

    await googleAuth(req, res)
    return result
}

const xsrfFromCookie = (res) => {
    const cookie = (res.headers["set-cookie"] || []).find(c => c.startsWith("XSRF-TOKEN="))
    assert.ok(cookie, `XSRF-TOKEN cookie missing; status=${res.status} set-cookie=${JSON.stringify(res.headers["set-cookie"])}`)
    return cookie.slice("XSRF-TOKEN=".length).split(";")[0]
}

const tokenCookie = (res) => (res.headers["set-cookie"] || []).find(c => c.startsWith("token="))

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await User.init()

    const initialized = initializeFirebaseAdmin()
    assert.strictEqual(initialized, true, "stub Firebase credentials must initialize the Admin SDK")

    authInstance = getAuth()
    assert.ok(authInstance, "Auth service must be available")
    originalVerifyIdToken = authInstance.verifyIdToken.bind(authInstance)
    authInstance.verifyIdToken = async () => {
        if (stubbedError) throw stubbedError
        if (!stubbedDecoded) {
            throw new Error("google-auth-integration test forgot to configure a token fixture")
        }
        return { ...stubbedDecoded }
    }

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/auth", csrfMiddleware, authRouter)
})

after(async () => {
    if (authInstance && originalVerifyIdToken) {
        authInstance.verifyIdToken = originalVerifyIdToken
    }
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await User.deleteMany({})
    stubbedDecoded = null
    stubbedError = null
})

describe("Google authentication live integration (real DB + CSRF middleware)", () => {
    test("firebaseUid gets a unique sparse index and password-only users stay unaffected", async () => {
        const indexes = await User.listIndexes()
        const index = indexes.find(i => JSON.stringify(i.key).includes("firebaseUid") && i.name !== "_id_")
        assert.ok(index, `firebaseUid index must exist among ${JSON.stringify(indexes.map(i => i.name))}`)
        assert.ok(index.unique, `unique flag missing in ${JSON.stringify(index)}`)
        assert.ok(index.sparse, `sparse flag missing in ${JSON.stringify(index)}`)

        const a = await User.create({ fullName: "A", email: `a${Date.now()}@t.com`, mobile: "9000000000", role: "user" })
        const b = await User.create({ fullName: "B", email: `b${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
        assert.ok(a._id && b._id, "users without firebaseUid coexist under the sparse index")
    })

    test("normal email/password registration keeps issuing cookies, initial CSRF token, and stored password", async () => {
        const res = await authRequest("/api/auth/signup", {
            fullName: "Normal User",
            email: `normal${Date.now()}@example.com`,
            password: "secret-password",
            mobile: "9876543210",
            role: "owner"
        }, { purpose: "initial" })

        assert.strictEqual(res.status, 201, `signup failed with ${JSON.stringify(res.body)}`)
        assert.strictEqual(res.body.user.role, "owner")
        assert.strictEqual(xsrfFromCookie(res), res.body.csrfToken, "body token must equal the XSRF-TOKEN cookie")
        assert.match(tokenCookie(res), /HttpOnly/)

        const stored = await User.findOne({ email: res.body.user.email }).select("+password")
        assert.ok(stored.password && stored.password.length > 0, "password account persists unmodified")
        assert.strictEqual(stored.firebaseUid, undefined, "password accounts have no firebaseUid")
    })

    test("new Google user registers with a collected mobile, defaults to the user role, and rotates CSRF", async () => {
        const uid = `google-register-${Date.now()}`
        fixture({ uid, name: "Full Google Name", email_verified: true })
        const res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(res.status, 200, `google registration failed with ${JSON.stringify(res.body)}`)
        assert.strictEqual(res.body.user.role, "user")
        assert.strictEqual(res.body.user.mobile, "9876543210")
        assert.strictEqual(res.body.user.fullName, "Full Google Name", "fullName comes from the verified name claim")
        assert.strictEqual(xsrfFromCookie(res), res.body.csrfToken)
        assert.match(tokenCookie(res), /HttpOnly/)

        const stored = await User.findOne({ firebaseUid: uid })
        assert.ok(stored, "google user document created")
        assert.strictEqual(stored.email, stubbedDecoded.email)
        assert.strictEqual(stored.mobile, "9876543210")
    })

    test("public Google signup honors customer, owner, and delivery roles", async () => {
        for (const selectedRole of ["user", "owner", "deliveryBoy"]) {
            const uid = `google-role-${selectedRole}-${Date.now()}`
            const email = `role-${selectedRole}-${Date.now()}@example.com`
            fixture({ uid, email, name: "Verified Name" })

            const result = await invokeGoogleAuth({
                firebaseToken: "google-api-id-token",
                mobile: "9876543210",
                role: selectedRole
            })

            assert.strictEqual(result.statusCode, 200, `${selectedRole} signup should succeed`)
            assert.strictEqual(result.body.user.role, selectedRole)
            const stored = await User.findOne({ firebaseUid: uid })
            assert.ok(stored, "the Google account must be created")
            assert.strictEqual(stored.role, selectedRole)
            assert.strictEqual(stored.email, email)
        }
    })

    test("client-supplied admin role cannot create an admin through Google signup", async () => {
        const uid = `google-admin-${Date.now()}`
        const email = `role-admin-${Date.now()}@example.com`
        fixture({ uid, email, name: "Verified Name" })

        const result = await invokeGoogleAuth({
            firebaseToken: "google-api-id-token",
            mobile: "9876543210",
            role: "admin"
        })

        assert.strictEqual(result.statusCode, 400)
        assert.match(result.body.message, /Invalid role/i)
        assert.deepEqual(result.cookies, [])
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 0)
        assert.strictEqual(await User.countDocuments({ email }), 0)
    })

    test("an existing owner account keeps its owner role when signing in with Google", async () => {
        const uid = `google-owner-${Date.now()}`
        const email = `owner${Date.now()}@example.com`
        const owner = await User.create({
            fullName: "Existing Owner",
            email,
            mobile: "9000000081",
            role: "owner",
            firebaseUid: uid
        })
        fixture({ uid, email, name: "Owner Display Name" })

        const res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token" })

        assert.strictEqual(res.status, 200, `owner google login failed with ${JSON.stringify(res.body)}`)
        assert.strictEqual(String(res.body.user._id), String(owner._id))
        assert.strictEqual(res.body.user.role, "owner")
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 1)
    })

    test("an existing provisioned admin keeps the admin role when signing in with Google", async () => {
        const uid = `google-admin-preserve-${Date.now()}`
        const email = `admin${Date.now()}@example.com`
        const admin = await User.create({
            fullName: "Existing Admin",
            email,
            mobile: "9000000082",
            role: "admin",
            firebaseUid: uid
        })
        fixture({ uid, email, name: "Admin Display Name" })

        const result = await invokeGoogleAuth({
            firebaseToken: "google-api-id-token",
            role: "user"
        })

        assert.strictEqual(result.statusCode, 200)
        assert.strictEqual(String(result.body.user._id), String(admin._id))
        assert.strictEqual(result.body.user.role, "admin")
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 1)
    })

    test("repeated Google sign-in finds the same account instead of creating duplicates", async () => {
        const uid = `google-repeat-${Date.now()}`
        fixture({ uid })
        const first = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543210" })
        assert.strictEqual(first.status, 200, `first google login failed with ${JSON.stringify(first.body)}`)
        assert.strictEqual(first.body.user.fullName, stubbedDecoded.email, "no name claim falls back safely to the verified email")

        fixture({ uid, name: "Renamed Google User" })
        const second = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token" })
        assert.strictEqual(second.status, 200, `second google login failed with ${JSON.stringify(second.body)}`)
        assert.strictEqual(second.body.user._id, first.body.user._id)

        const count = await User.countDocuments({ firebaseUid: uid })
        assert.strictEqual(count, 1)
    })

    test("missing mobile returns needsMobile without creating an invalid user document", async () => {
        const email = `nomobile${Date.now()}@example.com`
        fixture({ uid: `google-nomobile-${Date.now()}`, email })
        const res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token" })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.needsMobile, true)
        assert.match(res.body.message, /Mobile/i)

        const count = await User.countDocuments({ email })
        assert.strictEqual(count, 0, "no invalid user must be created")
    })

    test("an unverified Google email is rejected before creating an account", async () => {
        const uid = `google-unverified-${Date.now()}`
        const email = `unverified${Date.now()}@example.com`
        fixture({ uid, email, email_verified: false })

        const result = await invokeGoogleAuth({ firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(result.statusCode, 401)
        assert.deepEqual(result.body, { message: "Google authentication failed" })
        assert.deepEqual(result.cookies, [], "no authentication or CSRF cookie may be issued")
        assert.strictEqual(await User.countDocuments({ email }), 0)
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 0)
    })

    test("a missing email_verified claim is rejected before creating an account", async () => {
        const uid = `google-missing-verification-${Date.now()}`
        const email = `missingverification${Date.now()}@example.com`
        fixture({ uid, email, omitEmailVerified: true })

        const result = await invokeGoogleAuth({ firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(result.statusCode, 401)
        assert.deepEqual(result.body, { message: "Google authentication failed" })
        assert.deepEqual(result.cookies, [], "no authentication or CSRF cookie may be issued")
        assert.strictEqual(await User.countDocuments({ email }), 0)
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 0)
    })

    test("malformed email_verified claims are rejected before creating an account", async () => {
        const malformedClaims = ["true", "false", 1, null, {}]

        for (const [index, claim] of malformedClaims.entries()) {
            const uid = `google-malformed-${Date.now()}-${index}`
            const email = `malformed${Date.now()}-${index}@example.com`
            fixture({ uid, email, email_verified: claim })

            const result = await invokeGoogleAuth({ firebaseToken: "google-api-id-token", mobile: "9876543210" })

            assert.strictEqual(result.statusCode, 401, `claim ${JSON.stringify(claim)} must be rejected`)
            assert.deepEqual(result.body, { message: "Google authentication failed" })
            assert.deepEqual(result.cookies, [], "no authentication or CSRF cookie may be issued")
            assert.strictEqual(await User.countDocuments({ email }), 0)
            assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 0)
        }
    })

    test("an existing Google account cannot authenticate without explicit email verification", async () => {
        const uid = `google-existing-unverified-${Date.now()}`
        const email = `existingunverified${Date.now()}@example.com`
        const existing = await User.create({
            fullName: "Existing Google User",
            email,
            mobile: "9000000071",
            role: "user",
            firebaseUid: uid
        })
        fixture({ uid, email, omitEmailVerified: true })

        const result = await invokeGoogleAuth({ firebaseToken: "google-api-id-token" })

        assert.strictEqual(result.statusCode, 401)
        assert.deepEqual(result.body, { message: "Google authentication failed" })
        assert.deepEqual(result.cookies, [], "no authentication or CSRF cookie may be issued")
        assert.ok(await User.findById(existing._id), "the existing account must remain")
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 1)
    })

    test("an unverified identity cannot link itself to an existing password account", async () => {
        const uid = `google-unverified-link-${Date.now()}`
        const email = `unverifiedlink${Date.now()}@example.com`
        await User.create({
            fullName: "Existing Password User",
            email,
            password: await import("bcryptjs").then(m => m.hash("existing-secret", 10)),
            mobile: "9000000072",
            role: "user"
        })
        fixture({ uid, email, email_verified: false })

        const result = await invokeGoogleAuth({ firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(result.statusCode, 401)
        assert.deepEqual(result.body, { message: "Google authentication failed" })
        assert.deepEqual(result.cookies, [], "no authentication or CSRF cookie may be issued")
        const untouched = await User.findOne({ email }).select("+password")
        assert.ok(untouched.password && untouched.password.length > 0, "password hash remains")
        assert.strictEqual(untouched.firebaseUid, undefined, "account must not be linked")
        assert.strictEqual(untouched.mobile, "9000000072")
        assert.strictEqual(await User.countDocuments({ firebaseUid: uid }), 0)
    })

    test("an existing password account with the same email conflicts instead of being auto-linked", async () => {
        const email = `conflict${Date.now()}@example.com`
        await User.create({
            fullName: "Existing Account",
            email,
            password: await import("bcryptjs").then(m => m.hash("existing-secret", 10)),
            mobile: "9000000042",
            role: "user"
        })

        fixture({ uid: `google-other-${Date.now()}`, email })
        const res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(res.status, 409)
        assert.match(res.body.message, /already exists/i)
        assert.match(res.body.message, /email and password/i)

        const untouched = await User.findOne({ email }).select("+password")
        assert.ok(untouched.password && untouched.password.length > 0, "password hash remains")
        assert.strictEqual(untouched.firebaseUid, undefined, "account must not be linked automatically")
        assert.strictEqual(untouched.mobile, "9000000042")

        const linkedAny = await User.countDocuments({ firebaseUid: { $exists: true } })
        assert.strictEqual(linkedAny, 0)
    })

    test("an invalid Firebase ID token returns 401 and creates nothing", async () => {
        fixture({ uid: `google-invalid-${Date.now()}` })
        stubbedError = Object.assign(new Error("auth/argument-error"), { code: "auth/argument-error" })
        const email = stubbedDecoded.email

        const res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543210" })

        assert.strictEqual(res.status, 401)
        assert.strictEqual(res.body.message, "Invalid or expired Firebase ID token")

        const count = await User.countDocuments({ email })
        assert.strictEqual(count, 0)
    })

    test("duplicate firebaseUid creation attempts are rejected by the unique index with a 409 response", async () => {
        const uid = `google-dup-${Date.now()}`
        fixture({ uid, email: `first${Date.now()}@example.com` })
        const first = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543210" })
        assert.strictEqual(first.status, 200)

        const realFindOne = User.findOne.bind(User)
        let claimCalls = 0
        User.findOne = (...args) => {
            if (args[0] && args[0].firebaseUid) {
                claimCalls++
                return Promise.resolve(null)
            }
            return realFindOne(...args)
        }
        let res
        try {
            fixture({ uid, email: `second${Date.now()}@example.com` })
            res = await authRequest("/api/auth/google-auth", { firebaseToken: "google-api-id-token", mobile: "9876543211" })
        } finally {
            User.findOne = realFindOne
        }

        assert.strictEqual(claimCalls, 1, "collision simulated by forcing the first lookup to miss")
        assert.strictEqual(res.status, 409)
        assert.match(res.body.message, /already registered/i)

        const count = await User.countDocuments({ firebaseUid: uid })
        assert.strictEqual(count, 1)
    })
})
