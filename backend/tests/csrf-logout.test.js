import { test, describe } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"

process.env.JWT_SECRET = "test_csrf_secret_key_for_unit_testing"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import { signOut } from "../controllers/auth.controllers.js"
import { csrfBootstrap, csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

const makeReq = (overrides = {}) => ({
    headers: { origin: TRUSTED_ORIGIN, ...(overrides.headers || {}) },
    cookies: { ...(overrides.cookies || {}) },
})

const makeRes = () => {
    const recorded = {
        statusCode: null,
        jsonData: null,
        cookieCalls: [],
        clearCookieCalls: [],
    }
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
        clearCookie(name, options) {
            recorded.clearCookieCalls.push({ name, options })
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

describe("Logout re-login CSRF flow", () => {
    test("signOut clears both the auth token cookie and the XSRF-TOKEN cookie", async () => {
        const { res, recorded } = makeRes()
        await signOut({}, res)

        assert.strictEqual(recorded.statusCode, 200)
        assert.deepStrictEqual(
            recorded.clearCookieCalls.map(c => c.name),
            ["token", "XSRF-TOKEN"]
        )
        const tokenClear = recorded.clearCookieCalls[0]
        assert.strictEqual(tokenClear.options.httpOnly, true)
        const xsrfClear = recorded.clearCookieCalls[1]
        assert.strictEqual(xsrfClear.options.httpOnly, false)
    })

    test("XSRF-TOKEN clearing attributes match the attributes used when setting the cookie", async () => {
        const bootstrap = makeRes()
        csrfBootstrap(makeReq(), bootstrap.res)
        const setOptions = bootstrap.recorded.cookieCalls[0].options

        const { res, recorded } = makeRes()
        await signOut({}, res)
        const xsrfClear = recorded.clearCookieCalls.find(c => c.name === "XSRF-TOKEN")

        assert.ok(xsrfClear, "XSRF-TOKEN clearCookie was called")
        assert.strictEqual(xsrfClear.options.sameSite, setOptions.sameSite)
        assert.strictEqual(xsrfClear.options.secure, setOptions.secure)
        assert.strictEqual(xsrfClear.options.httpOnly, false)
    })

    test("after signout a fresh bootstrap mints a token that csrfMiddleware accepts", () => {
        const boot = makeRes()
        csrfBootstrap(makeReq(), boot.res)
        const freshToken = boot.recorded.jsonData.csrfToken
        assert.strictEqual(boot.recorded.cookieCalls[0].value, freshToken)
        const decoded = jwt.verify(freshToken, process.env.JWT_SECRET)
        assert.strictEqual(decoded.purpose, "initial")

        const { res, recorded } = makeRes()
        const next = makeNext()
        csrfMiddleware(makeReq({
            headers: { "x-xsrf-token": freshToken },
            cookies: { "XSRF-TOKEN": freshToken },
        }), res, next)

        assert.strictEqual(next.nextCalled, true)
        assert.strictEqual(recorded.statusCode, null)
    })

    test("after signout without re-bootstrap a stale headerless request is rejected with 403", () => {
        const { res, recorded } = makeRes()
        const next = makeNext()

        const stale = makeReq({ cookies: {} })
        csrfMiddleware(stale, res, next)

        assert.strictEqual(recorded.statusCode, 403)
        assert.strictEqual(recorded.jsonData.message, "Missing CSRF token")
        assert.strictEqual(next.nextCalled, false)
    })

    test("re-login flows: middleware also accepts post-login purpose tokens minted by the login endpoints", async () => {
        const postLoginToken = jwt.sign(
            { csrf: "fresh-login-csrf-id", purpose: "post-login" },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        )
        const { res, recorded } = makeRes()
        const next = makeNext()
        csrfMiddleware(makeReq({
            headers: { "x-xsrf-token": postLoginToken },
            cookies: { "XSRF-TOKEN": postLoginToken },
        }), res, next)

        assert.strictEqual(next.nextCalled, true)
        assert.strictEqual(recorded.statusCode, null)
    })
})
