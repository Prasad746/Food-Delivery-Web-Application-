import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import request from "supertest"

import { createApplication } from "../index.js"
import { loadRateLimitConfig } from "../config/rateLimit.js"
import { createTrustedProxyChecker, loadSecurityConfig } from "../config/security.js"
import { createOrderRateLimiter, ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, "..")
const TEST_ORIGIN = "http://localhost:5173"
const TEST_SECRET = "rate-limit-test-secret-0123456789-abcdef"

process.env.JWT_SECRET = TEST_SECRET

const readSource = (relativePath) => fs.readFileSync(path.join(backendRoot, relativePath), "utf8")

const testConfig = (overrides = {}) => loadSecurityConfig({
    NODE_ENV: "test",
    JWT_SECRET: TEST_SECRET,
    ALLOWED_ORIGIN: TEST_ORIGIN,
    ...overrides
})

const bootstrapCsrf = async (app) => {
    const response = await request(app)
        .get("/api/csrf-token")
        .set("Origin", TEST_ORIGIN)

    assert.equal(response.status, 200)
    const setCookie = response.headers["set-cookie"]?.[0]
    assert.ok(setCookie, "CSRF bootstrap must set a cookie")

    return {
        csrfToken: response.body.csrfToken,
        cookie: setCookie.split(";")[0]
    }
}

const postWithCsrf = (app, route, csrf, body = {}) =>
    request(app)
        .post(route)
        .set("Origin", TEST_ORIGIN)
        .set("Cookie", csrf.cookie)
        .set("X-XSRF-TOKEN", csrf.csrfToken)
        .send(body)

const buildLimiterApp = (limiter, { trustProxy = false } = {}) => {
    const app = express()
    app.set("trust proxy", trustProxy)
    app.use((req, res, next) => {
        if (req.headers["x-user-id"]) {
            req.userId = req.headers["x-user-id"]
        }
        next()
    })
    app.get("/limited", limiter, (req, res) => res.status(200).json({ ip: req.ip }))
    return app
}

describe("rate-limit coverage for sensitive endpoints", () => {
    test("upload limiter is enforced per authenticated user", async () => {
        const app = buildLimiterApp(createOrderRateLimiter(ORDER_RATE_LIMITS.upload))

        for (let i = 0; i < ORDER_RATE_LIMITS.upload.limit; i++) {
            const allowed = await request(app).get("/limited").set("X-User-Id", "owner-a")
            assert.equal(allowed.status, 200)
        }

        const blocked = await request(app).get("/limited").set("X-User-Id", "owner-a")
        assert.equal(blocked.status, 429)
        assert.deepEqual(blocked.body, { message: "Too many requests. Please try again later." })

        const otherUser = await request(app).get("/limited").set("X-User-Id", "owner-b")
        assert.equal(otherUser.status, 200)
    })

    test("upload routes are wired to the upload limiter before multer runs", () => {
        const itemSource = readSource("routes/item.routes.js")
        const shopSource = readSource("routes/shop.routes.js")

        assert.match(itemSource, /add-item[^\n]*createOrderRateLimiter\(ORDER_RATE_LIMITS\.upload,\{ name: "upload-add-item" \}\)/)
        assert.match(itemSource, /edit-item[^\n]*createOrderRateLimiter\(ORDER_RATE_LIMITS\.upload,\{ name: "upload-edit-item" \}\)/)
        assert.match(shopSource, /create-edit[^\n]*createOrderRateLimiter\(ORDER_RATE_LIMITS\.upload,\{ name: "upload-shop-create-edit" \}\)/)

        assert.match(itemSource, /add-item[^\n]*ORDER_RATE_LIMITS\.upload[^\n]*secureImageUpload/)
        assert.match(itemSource, /edit-item[^\n]*ORDER_RATE_LIMITS\.upload[^\n]*secureImageUpload/)
        assert.match(shopSource, /create-edit[^\n]*ORDER_RATE_LIMITS\.upload[^\n]*secureImageUpload/)
    })

    test("payment, delivery OTP, and rating routes remain limited", () => {
        const orderSource = readSource("routes/order.routes.js")
        const itemSource = readSource("routes/item.routes.js")

        assert.match(orderSource, /place-order[^\n]*ORDER_RATE_LIMITS\.placeOrder/)
        assert.match(orderSource, /verify-payment[^\n]*ORDER_RATE_LIMITS\.verifyPayment/)
        assert.match(orderSource, /send-delivery-otp[^\n]*ORDER_RATE_LIMITS\.sendDeliveryOtp/)
        assert.match(orderSource, /verify-delivery-otp[^\n]*ORDER_RATE_LIMITS\.verifyDeliveryOtp/)
        assert.match(itemSource, /rating[^\n]*ORDER_RATE_LIMITS\.rating/)
    })

    test("authentication and OTP endpoints share the enforced auth limiter", async () => {
        const { app } = createApplication(testConfig())
        const csrf = await bootstrapCsrf(app)

        for (let i = 0; i < 10; i++) {
            const response = await postWithCsrf(app, "/api/auth/signin", csrf, {})
            assert.equal(response.status, 400)
        }

        const otp = await postWithCsrf(app, "/api/auth/send-otp", csrf, { email: "user@example.com" })
        assert.equal(otp.status, 429)

        const google = await postWithCsrf(app, "/api/auth/google-auth", csrf, {})
        assert.equal(google.status, 429)
    })
})

describe("trusted proxy and forwarded-header rate-limit behavior", () => {
    test("spoofed X-Forwarded-For cannot bypass a limiter when no proxy is trusted", async () => {
        const app = buildLimiterApp(
            createOrderRateLimiter({ limit: 3, windowMs: 60 * 1000 }),
            { trustProxy: createTrustedProxyChecker([]) }
        )

        for (let i = 0; i < 3; i++) {
            const response = await request(app)
                .get("/limited")
                .set("X-Forwarded-For", `203.0.113.${i + 1}`)
            assert.equal(response.status, 200)
            assert.equal(response.body.ip, "127.0.0.1")
        }

        const blocked = await request(app)
            .get("/limited")
            .set("X-Forwarded-For", "198.51.100.200")
        assert.equal(blocked.status, 429)
    })
})

describe("memory rate-limit mode", () => {
    test("memory limiter state is per instance and does not coordinate", async () => {
        const config = loadRateLimitConfig({ NODE_ENV: "test" })
        assert.equal(config.store, "memory", "development and test mode must default to memory")

        const firstLimiter = createOrderRateLimiter({ limit: 2, windowMs: 60 * 1000 })
        const firstApp = buildLimiterApp(firstLimiter)

        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-a")).status, 200)
        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-a")).status, 200)
        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-a")).status, 429)

        const secondLimiter = createOrderRateLimiter({ limit: 2, windowMs: 60 * 1000 })
        const secondApp = buildLimiterApp(secondLimiter)
        assert.equal(
            (await request(secondApp).get("/limited").set("X-User-Id", "user-a")).status,
            200,
            "a new limiter instance starts with fresh state instead of sharing counters"
        )
    })
})
