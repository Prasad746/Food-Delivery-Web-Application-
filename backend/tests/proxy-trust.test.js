import { describe, test } from "node:test"
import assert from "node:assert/strict"
import request from "supertest"

import { loadSecurityConfig } from "../config/security.js"
import { createApplication } from "../index.js"

const TEST_ORIGIN = "http://localhost:5173"
const TEST_SECRET = "proxy-trust-test-secret-0123456789-abcdef"
const STRONG_PRODUCTION_SECRET = "proxy-trust-production-secret-0123456789-abcdef"

process.env.JWT_SECRET = TEST_SECRET

const testConfig = (overrides = {}) => loadSecurityConfig({
    NODE_ENV: "test",
    JWT_SECRET: TEST_SECRET,
    ALLOWED_ORIGIN: TEST_ORIGIN,
    ...overrides
})

const withEnv = async (values, run) => {
    const previous = new Map()
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key])
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }

    try {
        return await run()
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
    }
}

const bootstrapCsrf = async (app, origin = TEST_ORIGIN) => {
    const response = await request(app)
        .get("/api/csrf-token")
        .set("Origin", origin)

    assert.equal(response.status, 200)
    const setCookie = response.headers["set-cookie"]?.[0]
    assert.ok(setCookie, "CSRF bootstrap must set a cookie")

    return {
        csrfToken: response.body.csrfToken,
        cookie: setCookie.split(";")[0]
    }
}

const signInWithInvalidBody = (app, csrf, forwardedFor) => {
    const pending = request(app)
        .post("/api/auth/signin")
        .set("Origin", TEST_ORIGIN)
        .set("Cookie", csrf.cookie)
        .set("X-XSRF-TOKEN", csrf.csrfToken)
        .send({})

    if (forwardedFor !== undefined) {
        pending.set("X-Forwarded-For", forwardedFor)
    }

    return pending
}

describe("reverse-proxy trust boundary (Stage 7A.7)", () => {
    test("forwarded headers from an untrusted peer cannot bypass the auth rate limit", async () => {
        const config = testConfig({ TRUST_PROXY_CIDRS: "10.0.0.0/8" })
        const { app } = createApplication(config)
        const csrf = await bootstrapCsrf(app)

        const statuses = []
        for (let i = 0; i < 10; i++) {
            const response = await signInWithInvalidBody(app, csrf, `203.0.113.${i + 1}`)
            statuses.push(response.status)
        }

        assert.deepEqual(statuses, Array(10).fill(400))
        const blocked = await signInWithInvalidBody(app, csrf, "203.0.113.200")
        assert.equal(blocked.status, 429)
    })

    test("a trusted proxy supplies a per-client IP that drives the auth rate limit", async () => {
        const config = testConfig({ TRUST_PROXY_CIDRS: "127.0.0.1/32, ::1/128" })
        const { app } = createApplication(config)
        assert.notEqual(app.get("trust proxy"), true)
        const csrf = await bootstrapCsrf(app)

        for (let i = 0; i < 10; i++) {
            const response = await signInWithInvalidBody(app, csrf, "198.51.100.10")
            assert.equal(response.status, 400)
        }

        const blocked = await signInWithInvalidBody(app, csrf, "198.51.100.10")
        assert.equal(blocked.status, 429)

        const otherClient = await signInWithInvalidBody(app, csrf, "198.51.100.11")
        assert.equal(otherClient.status, 400)
    })

    test("a trusted proxy's rightmost client address drives limiting, not client-supplied leftmost entries", async () => {
        const config = testConfig({ TRUST_PROXY_CIDRS: "127.0.0.1/32, ::1/128" })
        const { app } = createApplication(config)
        const csrf = await bootstrapCsrf(app)

        for (let i = 0; i < 10; i++) {
            const response = await signInWithInvalidBody(app, csrf, `203.0.113.${i + 1}, 198.51.100.50`)
            assert.equal(response.status, 400)
        }

        const blocked = await signInWithInvalidBody(app, csrf, "203.0.113.200, 198.51.100.50")
        assert.equal(blocked.status, 429)
    })

    test("proxy trust defaults to an explicit checker that trusts nothing", () => {
        const { app } = createApplication(testConfig())
        const trustProxy = app.get("trust proxy")

        assert.equal(typeof trustProxy, "function")
        assert.equal(trustProxy("127.0.0.1"), false)
        assert.equal(trustProxy("::1"), false)
        assert.equal(trustProxy("203.0.113.9"), false)
    })

    test("forwarded protocol headers cannot weaken production cookies", async () => {
        await withEnv({
            NODE_ENV: "production",
            JWT_SECRET: STRONG_PRODUCTION_SECRET
        }, async () => {
            const config = loadSecurityConfig({
                NODE_ENV: "production",
                JWT_SECRET: STRONG_PRODUCTION_SECRET,
                ALLOWED_ORIGIN: "https://app.example.com",
                TRUST_PROXY_CIDRS: "127.0.0.1/32, ::1/128"
            })
            const { app } = createApplication(config)

            const response = await request(app)
                .get("/api/csrf-token")
                .set("Origin", "https://app.example.com")
                .set("X-Forwarded-Proto", "http")

            assert.equal(response.status, 200)
            const setCookie = response.headers["set-cookie"]?.[0]
            assert.match(setCookie, /;\s*Secure/i)
            assert.match(setCookie, /;\s*SameSite=None/i)
        })
    })
})
