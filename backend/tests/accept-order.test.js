import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.JWT_SECRET = "test_csrf_secret_key_for_unit_testing"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import orderRouter from "../routes/order.routes.js"
import isAuth from "../middlewares/isAuth.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import User from "../models/user.model.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const TRUSTED_ORIGIN = "http://localhost:5173"
const ACCEPT_PATH = "/api/order/accept-order/assignment123"

const signCsrf = (purpose = "initial") => jwt.sign(
    { csrf: "accept-order-csrf-id", purpose },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
)

const signAuth = (userId) => jwt.sign(
    { userId: String(userId) },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
)

let mongo

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await User.deleteMany({})
})

const makeRes = () => {
    const recorded = { statusCode: null, jsonData: null, cookieCalls: [] }
    const res = {
        status(code) {
            recorded.statusCode = code
            return this
        },
        json(body) {
            recorded.jsonData = body
            return this
        },
        cookie(name, value, options) {
            recorded.cookieCalls.push({ name, value, options })
            return this
        },
    }
    return { res, recorded }
}

const makeNext = () => {
    const next = () => { next.nextCalled = true }
    next.nextCalled = false
    return next
}

const reqFor = (overrides, path = ACCEPT_PATH) => ({
    method: "POST",
    headers: {
        origin: TRUSTED_ORIGIN,
        ...(overrides.headers || {}),
    },
    originalUrl: path,
    cookies: { ...(overrides.cookies || {}) },
})

describe("Accept-order endpoint integrity", () => {
    test("accept-order is routed as POST with isAuth and acceptOrder, with no GET handler left", () => {
        const layer = orderRouter.stack.find(l => l.route && l.route.path === "/accept-order/:assignmentId")
        assert.ok(layer, "accept-order route is registered")
        assert.strictEqual(layer.route.methods.post, true)
        assert.ok(!("get" in layer.route.methods), "GET handler must be removed")
        const handlerNames = layer.route.stack.map(h => h.name)
        assert.ok(handlerNames.includes("isAuth"), "isAuth middleware is on the route")
        assert.ok(handlerNames.includes("acceptOrder"), "acceptOrder controller is on the route")
    })

    test("successful assignment request: valid auth + matching CSRF tokens pass both middleware", async () => {
        const deliveryBoy = await User.create({
            fullName: "Accept Order Boy",
            email: `accept-order-${Date.now()}@t.com`,
            mobile: "9000000077",
            role: "deliveryBoy"
        })
        const csrfToken = signCsrf("post-login")
        const authToken = signAuth(deliveryBoy._id)

        const csrfReq = reqFor({
            headers: { "x-xsrf-token": csrfToken },
            cookies: { "XSRF-TOKEN": csrfToken },
        })
        const csrfRes = makeRes()
        const csrfNext = makeNext()
        csrfMiddleware(csrfReq, csrfRes.res, csrfNext)
        assert.strictEqual(csrfNext.nextCalled, true)
        assert.strictEqual(csrfRes.recorded.statusCode, null)

        const authReq = {
            headers: {},
            cookies: { token: authToken },
        }
        const authRes = makeRes()
        const authNext = makeNext()
        await isAuth(authReq, authRes.res, authNext)
        assert.strictEqual(authNext.nextCalled, true)
        assert.strictEqual(authRes.recorded.statusCode, null)
        assert.strictEqual(authReq.userId, String(deliveryBoy._id))
    })

    test("unauthorized access: accept-order without an auth token is rejected with 401", async () => {
        const req = { headers: {}, cookies: {} }
        const { res, recorded } = makeRes()
        const next = makeNext()

        await isAuth(req, res, next)

        assert.strictEqual(recorded.statusCode, 401)
        assert.strictEqual(recorded.jsonData.message, "Authentication token required")
        assert.strictEqual(next.nextCalled, false)
    })

    test("atomic claim and eligibility guards remain in the controller and model", () => {
        const source = readFileSync(
            path.resolve(here, "../controllers/order.controllers.js"),
            "utf8"
        )
        assert.match(source, /assignment not found/)
        assert.match(source, /Assignment is no longer available/)
        assert.match(source, /status: "brodcasted", assignedTo: null/)
        assert.match(source, /eligibilityCheck = await DeliveryAssignment\.findOne\(/)
        assert.match(source, /status: \{ \$nin: \["brodcasted", "completed"\] \}/)
        assert.match(source, /You are already assigned to another order/)
        assert.match(source, /claimError && claimError\.code === 11000/)
        assert.match(source, /arrayFilters: \[\{ "so\._id": claimed\.shopOrderId \}\]/)
        assert.match(source, /\$unset: \{ assignedTo: 1 \}/)
        assert.match(source, /shopOrders\.\$\[so\]\.assignedDeliveryBoy/)
        assert.match(source, /shop: claimed\.shop/)
        assert.match(source, /status: DELIVERY_OTP_STATUS/)
        assert.match(source, /assignedDeliveryBoy: null/)
        assert.match(source, /\{ assignment: \{ \$exists: false \} \}/)
        assert.match(source, /\{ assignment: null \}/)
        assert.match(source, /\{ assignment: claimed\._id \}/)
        assert.match(source, /const relationshipIsValid = shopOrder/)
        assert.match(source, /String\(assignmentShopId\) === String\(shopOrderShopId\)/)
        assert.match(source, /String\(shopOrder\.assignedDeliveryBoy\) === String\(assignedDeliveryBoyId\)/)
        assert.match(source, /String\(shopOrder\.assignment\) === String\(assignment\._id\)/)

        const modelSource = readFileSync(
            path.resolve(here, "../models/deliveryAssignment.model.js"),
            "utf8"
        )
        assert.match(modelSource, /unique_active_assignment_per_worker/)
        assert.match(modelSource, /partialFilterExpression: \{ assignedTo: \{ \$type: "objectId" \} \}/)
    })

    test("missing CSRF token is rejected with 403", () => {
        const { res, recorded } = makeRes()
        const next = makeNext()
        const req = reqFor({ cookies: { "XSRF-TOKEN": signCsrf("post-login") } })

        csrfMiddleware(req, res, next)

        assert.strictEqual(recorded.statusCode, 403)
        assert.strictEqual(recorded.jsonData.message, "Missing CSRF token")
        assert.strictEqual(next.nextCalled, false)
    })

    test("mismatched CSRF tokens are rejected with 403", () => {
        const headerToken = jwt.sign({ csrf: "header-csrf-id", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
        const cookieToken = jwt.sign({ csrf: "cookie-csrf-id", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
        assert.notStrictEqual(headerToken, cookieToken)

        const { res, recorded } = makeRes()
        const next = makeNext()
        const req = reqFor({
            headers: { "x-xsrf-token": headerToken },
            cookies: { "XSRF-TOKEN": cookieToken },
        })

        csrfMiddleware(req, res, next)

        assert.strictEqual(recorded.statusCode, 403)
        assert.strictEqual(recorded.jsonData.message, "CSRF token mismatch")
        assert.strictEqual(next.nextCalled, false)
    })

    test("invalid or expired CSRF token is rejected with 403", () => {
        const expiredToken = jwt.sign(
            { csrf: "accept-order-csrf-id", purpose: "post-login", exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET
        )

        const { res, recorded } = makeRes()
        const next = makeNext()
        const req = reqFor({
            headers: { "x-xsrf-token": expiredToken },
            cookies: { "XSRF-TOKEN": expiredToken },
        })

        csrfMiddleware(req, res, next)

        assert.strictEqual(recorded.statusCode, 403)
        assert.strictEqual(recorded.jsonData.message, "Invalid or expired CSRF token")
        assert.strictEqual(next.nextCalled, false)
    })
})
