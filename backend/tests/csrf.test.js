import { describe, it } from "node:test"
import assert from "node:assert"
import jwt from "jsonwebtoken"

// Set env BEFORE the middleware module is evaluated (imports are hoisted,
// but the middleware reads process.env at call time, so this value is used)
process.env.JWT_SECRET = "test_csrf_secret_key_for_unit_testing"
process.env.ALLOWED_ORIGIN = "http://localhost:5173,http://127.0.0.1:5173"

import { csrfMiddleware, csrfBootstrap } from "../middlewares/csrf.js"

const SECRET = process.env.JWT_SECRET
const TRUSTED_ORIGIN = "http://localhost:5173"

// Sign a real, correctly-signed CSRF JWT (size of csrf claim is irrelevant
// to binding, which compares full token strings)
const signCsrf = (purpose = "initial") =>
  jwt.sign({ csrf: "test-csrf-id", purpose }, SECRET, { expiresIn: "1h" })

// Sign a JWT that is already expired (exp 60s in the past)
const signExpiredCsrf = (purpose = "initial") =>
  jwt.sign({ csrf: "test-csrf-id", purpose, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET)

// Record-keeping mocks (requirement 1): capture response status, JSON body,
// every res.cookie() call with its arguments, and whether next() ran
const makeMocks = (reqOverrides = {}) => {
  const req = {
    method: reqOverrides.method === undefined ? "POST" : reqOverrides.method,
    headers: {
      // "origin" in object keeps an explicit undefined (header genuinely absent)
      // instead of silently defaulting to a trusted origin
      origin: "origin" in reqOverrides ? reqOverrides.origin : TRUSTED_ORIGIN,
      "x-xsrf-token": reqOverrides.headerToken,
    },
    cookies: reqOverrides.cookies === undefined ? {} : reqOverrides.cookies,
  }
  const recorded = { statusCode: null, jsonData: null, cookieCalls: [], nextCalled: false }
  const res = {
    status(code) { recorded.statusCode = code; return res },
    json(data) { recorded.jsonData = data; return res },
    cookie(name, value, options) {
      recorded.cookieCalls.push({ name, value, options })
      return res
    },
  }
  const next = () => { recorded.nextCalled = true }
  return { req, res, next, recorded }
}

describe("CSRF Bootstrap Endpoint", () => {
  it("sets XSRF-TOKEN cookie and returns an identical csrfToken in JSON", () => {
    const { req, res, recorded } = makeMocks({ method: "GET" })
    csrfBootstrap(req, res)

    assert.strictEqual(recorded.statusCode, null, "bootstrap must not respond with an error status")
    assert.strictEqual(recorded.cookieCalls.length, 1, "exactly one cookie must be set")
    const { name, value, options } = recorded.cookieCalls[0]
    assert.strictEqual(name, "XSRF-TOKEN")
    assert.ok(value, "cookie value must be present")
    assert.strictEqual(options.httpOnly, false, "cookie must be readable JS-side by design")

    assert.ok(recorded.jsonData, "JSON body must be present")
    assert.ok(recorded.jsonData.csrfToken, "JSON body must carry csrfToken")
    assert.strictEqual(
      recorded.jsonData.csrfToken,
      value,
      "cookie value and JSON csrfToken must be the identical signed JWT"
    )

    const decoded = jwt.verify(recorded.jsonData.csrfToken, SECRET)
    assert.strictEqual(decoded.purpose, "initial")
  })

  it("rejects untrusted origins with 403 and issues no token", () => {
    const { req, res, recorded } = makeMocks({ method: "GET", origin: "http://evil-site.com" })
    csrfBootstrap(req, res)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid origin")
    assert.strictEqual(recorded.cookieCalls.length, 0)
    assert.ok(recorded.jsonData.csrfToken === undefined, "no csrfToken may be issued")
  })

  it("rejects a missing origin with 403 and issues no token", () => {
    const { req, res, recorded } = makeMocks({ method: "GET", origin: undefined })
    csrfBootstrap(req, res)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid origin")
    assert.strictEqual(recorded.cookieCalls.length, 0)
    assert.ok(recorded.jsonData.csrfToken === undefined, "no csrfToken may be issued")
  })
})

describe("CSRF Middleware — Valid tokens", () => {
  it("calls next() for a valid matching initial-purpose JWT in header and cookie", () => {
    const token = signCsrf("initial")
    const { req, res, next, recorded } = makeMocks({
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, null, "no error status may be set")
    assert.strictEqual(recorded.nextCalled, true, "next() must be called for a valid request")
  })

  it("calls next() for a valid matching post-login-purpose JWT in header and cookie", () => {
    const token = signCsrf("post-login")
    const { req, res, next, recorded } = makeMocks({
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, null)
    assert.strictEqual(recorded.nextCalled, true)
  })
})

describe("CSRF Middleware — Cookie binding", () => {
  it("returns 403 for mismatched header and cookie tokens without calling next()", () => {
    // Two correctly signed, unexpired JWTs — but with distinct csrf claims,
    // so the token strings are guaranteed to differ
    const headerToken = jwt.sign({ csrf: "header-side-csrf-id", purpose: "initial" }, SECRET, { expiresIn: "1h" })
    const cookieToken = jwt.sign({ csrf: "cookie-side-csrf-id", purpose: "initial" }, SECRET, { expiresIn: "1h" })
    assert.notStrictEqual(headerToken, cookieToken, "test precondition: tokens must differ")

    const { req, res, next, recorded } = makeMocks({
      headerToken,
      cookies: { "XSRF-TOKEN": cookieToken },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "CSRF token mismatch")
    assert.strictEqual(recorded.nextCalled, false, "next() must NOT be called")
  })

  it("returns 403 when the XSRF-TOKEN cookie is missing without calling next()", () => {
    const token = signCsrf("initial")
    const { req, res, next, recorded } = makeMocks({ headerToken: token, cookies: {} })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "CSRF token cookie missing")
    assert.strictEqual(recorded.nextCalled, false)
  })
})

describe("CSRF Middleware — Token validation", () => {
  it("returns 403 for an expired JWT without calling next()", () => {
    const token = signExpiredCsrf("initial")
    const { req, res, next, recorded } = makeMocks({
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid or expired CSRF token")
    assert.strictEqual(recorded.nextCalled, false)
  })

  it("returns 403 for a JWT signed with the wrong secret without calling next()", () => {
    const token = jwt.sign({ csrf: "test-csrf-id", purpose: "initial" }, "a_completely_different_secret", { expiresIn: "1h" })
    const { req, res, next, recorded } = makeMocks({
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid or expired CSRF token")
    assert.strictEqual(recorded.nextCalled, false)
  })

  it("returns 403 for an invalid purpose without calling next()", () => {
    const token = jwt.sign({ csrf: "test-csrf-id", purpose: "random" }, SECRET, { expiresIn: "1h" })
    const { req, res, next, recorded } = makeMocks({
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid CSRF token purpose")
    assert.strictEqual(recorded.nextCalled, false)
  })

  it("returns 403 when the X-XSRF-TOKEN header is missing without calling next()", () => {
    const { req, res, next, recorded } = makeMocks({
      headerToken: undefined,
      cookies: { "XSRF-TOKEN": signCsrf("initial") },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Missing CSRF token")
    assert.strictEqual(recorded.nextCalled, false)
  })
})

describe("CSRF Middleware — Origin policy", () => {
  it("returns 403 for an untrusted origin without calling next()", () => {
    const token = signCsrf("initial")
    const { req, res, next, recorded } = makeMocks({
      origin: "http://evil-site.com",
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid origin")
    assert.strictEqual(recorded.nextCalled, false)
  })

  it("returns 403 for a missing origin without calling next()", () => {
    const token = signCsrf("initial")
    const { req, res, next, recorded } = makeMocks({
      origin: undefined,
      headerToken: token,
      cookies: { "XSRF-TOKEN": token },
    })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, 403)
    assert.strictEqual(recorded.jsonData.message, "Invalid origin")
    assert.strictEqual(recorded.nextCalled, false)
  })
})

describe("CSRF Middleware — Safe methods", () => {
  it("passes OPTIONS preflight through to next()", () => {
    const { req, res, next, recorded } = makeMocks({ method: "OPTIONS" })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, null)
    assert.strictEqual(recorded.nextCalled, true)
  })

  it("passes GET requests through to next()", () => {
    const { req, res, next, recorded } = makeMocks({ method: "GET" })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, null)
    assert.strictEqual(recorded.nextCalled, true)
  })

  it("passes HEAD requests through to next()", () => {
    const { req, res, next, recorded } = makeMocks({ method: "HEAD" })
    csrfMiddleware(req, res, next)

    assert.strictEqual(recorded.statusCode, null)
    assert.strictEqual(recorded.nextCalled, true)
  })
})