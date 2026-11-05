import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"
import express from "express"
import cookieParser from "cookie-parser"

process.env.JWT_SECRET = "test_admin_role_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import adminRouter from "../routes/admin.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { provisionAdmin } from "../utils/provisionAdmin.js"
import { validateSignUp, validateGoogleAuth } from "../utils/validate.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(path.resolve(here, "../index.js"), "utf8")

let mongo
let app
let seq = 0

const tokenFor = (user) => jwt.sign(
    { userId: String(user._id), authVersion: user.authVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
)

const getSummary = (token) => {
    const req = request(app).get("/api/admin/summary")
    return token ? req.set("Cookie", `token=${token}`) : req
}

const runMiddleware = (middleware, body) => new Promise((resolve) => {
    const req = { body }
    let statusCode = null
    let message = null
    const res = {
        status(code) {
            statusCode = code
            return this
        },
        json(payload) {
            message = payload?.message
        }
    }
    let nextCalled = false
    middleware(req, res, () => { nextCalled = true })
    Promise.resolve().then(() => resolve({ nextCalled, statusCode, message }))
})

const makeUser = (role, overrides = {}) => {
    seq += 1
    return User.create({
        fullName: `${role} ${seq}`,
        email: `${role}${seq}@admin.test`,
        mobile: `92000000${String(seq).padStart(2, "0")}`,
        role,
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
    app.use("/api/admin", csrfMiddleware, adminRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await User.deleteMany({})
    seq = 0
})

describe("Admin role and provisioning", () => {
    test("the user model accepts admin for provisioned accounts and rejects unknown roles", async () => {
        const admin = await makeUser("admin")
        assert.strictEqual(admin.role, "admin")

        await assert.rejects(
            () => User.create({
                fullName: "Unknown Role",
                email: "unknown@admin.test",
                mobile: "9200000099",
                role: "superadmin"
            }),
            /validation|enum/i
        )
    })

    test("public signup schemas never accept the admin role", async () => {
        const signup = {
            fullName: "Public User",
            email: "public@example.com",
            password: "secret-password",
            mobile: "9876543210",
            role: "admin"
        }
        const signupResult = await runMiddleware(validateSignUp, signup)
        assert.strictEqual(signupResult.nextCalled, false)
        assert.strictEqual(signupResult.statusCode, 400)
        assert.match(signupResult.message, /role.*(not allowed|must be one of)/i)

        for (const role of ["user", "owner", "deliveryBoy"]) {
            const accepted = await runMiddleware(validateSignUp, { ...signup, role })
            assert.strictEqual(accepted.nextCalled, true, `${role} must be accepted`)
        }

        const googleAdmin = await runMiddleware(validateGoogleAuth, {
            firebaseToken: "some.firebase.jwt.token",
            role: "admin"
        })
        assert.strictEqual(googleAdmin.nextCalled, false)
        assert.strictEqual(googleAdmin.statusCode, 400)
    })

    test("admin summary requires authentication", async () => {
        const res = await getSummary()
        assert.strictEqual(res.status, 401)
    })

    test("non-admin roles cannot access the admin summary", async () => {
        for (const role of ["user", "owner", "deliveryBoy"]) {
            const user = await makeUser(role)
            const res = await getSummary(tokenFor(user))
            assert.strictEqual(res.status, 403, `${role} must not access admin data`)
            assert.match(res.body.message, /admin access/i)
        }
    })

    test("an admin can read aggregate role counts without account details", async () => {
        const admin = await makeUser("admin")
        await makeUser("user")
        await makeUser("user")
        await makeUser("owner")
        await makeUser("deliveryBoy")

        const res = await getSummary(tokenFor(admin))

        assert.strictEqual(res.status, 200)
        assert.deepEqual(res.body.users, {
            total: 5,
            user: 2,
            owner: 1,
            deliveryBoy: 1,
            admin: 1
        })
        const serialized = JSON.stringify(res.body)
        assert.ok(!serialized.includes("@admin.test"), "admin response must not expose account emails")
        assert.ok(!serialized.includes("password"), "admin response must not expose credentials")
    })

    test("the admin router is mounted in the production application", () => {
        assert.match(
            indexSource,
            /app\.use\("\/api\/admin",\s*csrfMiddleware,\s*adminRouter\)/
        )
    })
})

describe("Trusted admin provisioning", () => {
    test("promotes an existing account idempotently without changing its credentials or session version", async () => {
        const passwordHash = await bcrypt.hash("existing-secret", 10)
        const user = await makeUser("owner", {
            email: "Provision.Me@admin.test",
            password: passwordHash,
            authVersion: 3,
            firebaseUid: "existing-firebase-uid"
        })

        const first = await provisionAdmin({ email: "provision.me@admin.test" })

        assert.strictEqual(first.ok, true)
        assert.strictEqual(first.role, "admin")
        assert.strictEqual(first.alreadyAdmin, false)
        assert.strictEqual(String(first.id), String(user._id))

        const stored = await User.findById(user._id).select("+password +firebaseUid")
        assert.strictEqual(stored.role, "admin")
        assert.strictEqual(stored.password, passwordHash)
        assert.strictEqual(stored.authVersion, 3)
        assert.strictEqual(stored.firebaseUid, "existing-firebase-uid")

        const second = await provisionAdmin({ email: "Provision.Me@admin.test" })
        assert.strictEqual(second.ok, true)
        assert.strictEqual(second.alreadyAdmin, true)
        assert.strictEqual(await User.countDocuments({ email: "Provision.Me@admin.test" }), 1)
    })

    test("never creates an account for a missing email", async () => {
        const missing = await provisionAdmin({ email: "missing@admin.test" })
        assert.deepEqual(missing, { ok: false, reason: "not-found", email: "missing@admin.test" })
        assert.strictEqual(await User.countDocuments({}), 0)
    })

    test("requires an email address", async () => {
        assert.deepEqual(await provisionAdmin({ email: "   " }), { ok: false, reason: "email-required" })
        assert.deepEqual(await provisionAdmin(), { ok: false, reason: "email-required" })
        assert.strictEqual(await User.countDocuments({}), 0)
    })

    test("refuses ambiguous case-insensitive matches instead of promoting the wrong account", async () => {
        const one = await makeUser("user", { email: "Case@admin.test" })
        const two = await makeUser("user", { email: "case@admin.test" })

        const result = await provisionAdmin({ email: "CASE@admin.test" })

        assert.deepEqual(result, { ok: false, reason: "ambiguous-email", email: "CASE@admin.test" })
        const stored = await User.find({ _id: { $in: [one._id, two._id] } }).select("role")
        assert.deepEqual(stored.map(user => user.role).sort(), ["user", "user"])
    })
})
