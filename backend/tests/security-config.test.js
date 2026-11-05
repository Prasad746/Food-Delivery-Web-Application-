import { test, describe } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
    DEFAULT_DEVELOPMENT_ORIGINS,
    PRODUCTION_JWT_SECRET_MIN_LENGTH,
    SecurityConfigError,
    createTrustedProxyChecker,
    getAllowedOrigins,
    getCookieOptions,
    getJwtSecret,
    getNodeEnv,
    isProduction,
    loadSecurityConfig
} from "../config/security.js"
import { createCsrfHandlers } from "../middlewares/csrf.js"
import { createSocketOriginValidator } from "../socket.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, "..")
const indexSource = fs.readFileSync(path.join(backendRoot, "index.js"), "utf8")
const strongSecret = crypto.randomBytes(48).toString("base64url")

const productionEnv = (overrides = {}) => ({
    NODE_ENV: "production",
    JWT_SECRET: strongSecret,
    ALLOWED_ORIGIN: "https://app.example.com",
    COOKIE_SAME_SITE: "none",
    ...overrides
})

const expectConfigError = (run, pattern) => {
    assert.throws(run, (error) => {
        assert.ok(error instanceof SecurityConfigError, "expected a SecurityConfigError")
        assert.match(error.message, pattern)
        return true
    })
}

const withProcessEnv = (values, run) => {
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
        return run()
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

const makeRes = () => {
    const recorded = {
        statusCode: null,
        body: null,
        cookies: []
    }
    const res = {
        status(code) {
            recorded.statusCode = code
            return res
        },
        json(body) {
            recorded.body = body
            return res
        },
        cookie(name, value, options) {
            recorded.cookies.push({ name, value, options })
            return res
        }
    }
    return { res, recorded }
}

const validateSocketOrigin = (allowedOrigins, origin) =>
    new Promise((resolve) => {
        createSocketOriginValidator(allowedOrigins)(
            { headers: origin === undefined ? {} : { origin } },
            (message, success) => resolve({ message, success })
        )
    })

const cleanSubprocessEnv = (overrides) => {
    const env = { ...process.env }
    for (const key of [
        "NODE_ENV",
        "JWT_SECRET",
        "ALLOWED_ORIGIN",
        "COOKIE_SAME_SITE",
        "TRUST_PROXY_CIDRS",
        "RATE_LIMIT_STORE",
        "RATE_LIMIT_KEY_SECRET",
        "RATE_LIMIT_MONGO_COLLECTION",
        "RATE_LIMIT_MONGO_TIMEOUT_MS",
        "RATE_LIMIT_KEY_PREFIX",
        "DOTENV_CONFIG_PATH"
    ]) {
        delete env[key]
    }
    return { ...env, ...overrides }
}

const runStartup = (overrides) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vingo-security-config-"))
    try {
        return spawnSync(process.execPath, [path.join(backendRoot, "index.js")], {
            cwd,
            env: cleanSubprocessEnv(overrides),
            encoding: "utf8",
            timeout: 15000
        })
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
    }
}

describe("security configuration validation", () => {
    test("accepts a valid production configuration and returns no secret in the config object", () => {
        const config = loadSecurityConfig(productionEnv())

        assert.equal(config.nodeEnv, "production")
        assert.equal(config.isProduction, true)
        assert.deepEqual([...config.allowedOrigins], ["https://app.example.com"])
        assert.deepEqual(config.cookieOptions, {
            secure: true,
            sameSite: "none",
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000
        })
        assert.equal(Object.prototype.hasOwnProperty.call(config, "jwtSecret"), false)
        assert.ok(!JSON.stringify(config).includes(strongSecret), "config serialization must not expose the secret")
    })

    test("accepts multiple canonical production origins and removes duplicates", () => {
        const config = loadSecurityConfig(productionEnv({
            ALLOWED_ORIGIN: "https://app.example.com, https://admin.example.com, https://app.example.com"
        }))

        assert.deepEqual([...config.allowedOrigins], [
            "https://app.example.com",
            "https://admin.example.com"
        ])
    })

    test("rejects a missing JWT secret", () => {
        const env = productionEnv()
        delete env.JWT_SECRET
        expectConfigError(() => loadSecurityConfig(env), /JWT_SECRET must be set/)
    })

    test("rejects a short production JWT secret", () => {
        const shortSecret = "s".repeat(PRODUCTION_JWT_SECRET_MIN_LENGTH - 1)
        expectConfigError(
            () => loadSecurityConfig(productionEnv({ JWT_SECRET: shortSecret })),
            /at least 32 characters/
        )
    })

    test("rejects known placeholder secrets even when they meet the length requirement", () => {
        const placeholders = [
            "replace_with_a_secure_random_string_at_least_32_characters",
            "changeme",
            "your_secret_key"
        ]

        for (const placeholder of placeholders) {
            expectConfigError(
                () => loadSecurityConfig(productionEnv({ JWT_SECRET: placeholder })),
                /known placeholder/
            )
        }
    })

    test("allows a short development secret but still requires it to be present", () => {
        const config = loadSecurityConfig({
            NODE_ENV: "development",
            JWT_SECRET: "local-dev-secret",
            ALLOWED_ORIGIN: "http://localhost:5173"
        })

        assert.equal(config.isProduction, false)
        assert.equal(getJwtSecret({ NODE_ENV: "development", JWT_SECRET: "local-dev-secret" }), "local-dev-secret")
        expectConfigError(
            () => loadSecurityConfig({ NODE_ENV: "development", ALLOWED_ORIGIN: "http://localhost:5173" }),
            /JWT_SECRET must be set/
        )
    })

    test("rejects missing and unsupported NODE_ENV values", () => {
        const missing = productionEnv()
        delete missing.NODE_ENV
        expectConfigError(() => loadSecurityConfig(missing), /NODE_ENV/)
        expectConfigError(() => loadSecurityConfig(productionEnv({ NODE_ENV: "staging" })), /NODE_ENV/)
        expectConfigError(() => loadSecurityConfig(productionEnv({ NODE_ENV: "" })), /NODE_ENV/)
    })

    test("runtime environment helpers share the same mode rules", () => {
        assert.equal(getNodeEnv({}), "development")
        assert.equal(getNodeEnv({ NODE_ENV: "" }), "development")
        assert.equal(getNodeEnv({ NODE_ENV: "test" }), "test")
        assert.equal(isProduction({ NODE_ENV: "production" }), true)
        assert.equal(isProduction({ NODE_ENV: "development" }), false)
        expectConfigError(() => getNodeEnv({ NODE_ENV: "staging" }), /NODE_ENV/)
        expectConfigError(() => isProduction({ NODE_ENV: "staging" }), /NODE_ENV/)
    })

    test("requires ALLOWED_ORIGIN in production", () => {
        const env = productionEnv()
        delete env.ALLOWED_ORIGIN
        expectConfigError(() => loadSecurityConfig(env), /ALLOWED_ORIGIN is required/)
        expectConfigError(() => loadSecurityConfig(productionEnv({ ALLOWED_ORIGIN: "" })), /required/)
    })

    test("rejects malformed and non-HTTPS production origins", () => {
        const invalidOrigins = [
            "https://app.example.com/",
            "https://app.example.com/path",
            "https://app.example.com?query=1",
            "https://app.example.com#fragment",
            "https://user:password@app.example.com",
            "http://app.example.com",
            "app.example.com",
            "*",
            "null",
            "ftp://app.example.com",
            "https://app.example.com,,https://admin.example.com"
        ]

        for (const origin of invalidOrigins) {
            expectConfigError(
                () => loadSecurityConfig(productionEnv({ ALLOWED_ORIGIN: origin })),
                /ALLOWED_ORIGIN/
            )
        }
    })

    test("keeps localhost defaults and HTTP origins in development", () => {
        const config = loadSecurityConfig({
            NODE_ENV: "development",
            JWT_SECRET: "local-dev-secret"
        })

        assert.deepEqual([...config.allowedOrigins], [...DEFAULT_DEVELOPMENT_ORIGINS])
        assert.deepEqual([...getAllowedOrigins({ NODE_ENV: "development" })], [...DEFAULT_DEVELOPMENT_ORIGINS])
        assert.deepEqual(
            [...getAllowedOrigins({ NODE_ENV: "development", ALLOWED_ORIGIN: "https://preview.example.com" })],
            [...DEFAULT_DEVELOPMENT_ORIGINS, "https://preview.example.com"]
        )
    })

    test("accepts only explicit trusted proxy CIDRs and resolves them safely", () => {
        const config = loadSecurityConfig(productionEnv({
            TRUST_PROXY_CIDRS: "10.0.0.0/8, 192.168.1.10, 2001:db8::/32, 10.0.0.0/8"
        }))

        assert.deepEqual([...config.trustedProxyCidrs], [
            "10.0.0.0/8",
            "192.168.1.10/32",
            "2001:db8::/32"
        ])

        const isTrustedProxy = createTrustedProxyChecker(config.trustedProxyCidrs)
        assert.equal(isTrustedProxy("10.1.2.3"), true)
        assert.equal(isTrustedProxy("192.168.1.10"), true)
        assert.equal(isTrustedProxy("2001:db8::1"), true)
        assert.equal(isTrustedProxy("::ffff:10.1.2.3"), true)
        assert.equal(isTrustedProxy("203.0.113.9"), false)
        assert.equal(isTrustedProxy("::1"), false)
        assert.equal(isTrustedProxy("not-an-ip"), false)
        assert.equal(isTrustedProxy(undefined), false)

        const trustNothing = createTrustedProxyChecker([])
        assert.equal(typeof trustNothing, "function", "the default checker must still be an explicit trust function")
        assert.equal(trustNothing("127.0.0.1"), false)
        assert.equal(trustNothing("::1"), false)
        assert.equal(trustNothing("203.0.113.9"), false)
    })

    test("rejects unsafe or malformed trusted proxy CIDRs", () => {
        const invalidCidrs = [
            "0.0.0.0/0",
            "::/0",
            "10.0.0.0/33",
            "2001:db8::/129",
            "10.0.0.0/",
            "10.0.0.0/-1",
            "10.0.0.0/8,,192.168.0.0/16",
            "10.0.0.0/8/9",
            "10.0.0.0/ 8",
            "fe80::1%eth0/64",
            "example.com",
            "loopback",
            "*",
            "true",
            "false"
        ]

        for (const cidr of invalidCidrs) {
            expectConfigError(
                () => loadSecurityConfig(productionEnv({ TRUST_PROXY_CIDRS: cidr })),
                /TRUST_PROXY_CIDRS/
            )
        }
    })

    test("validates COOKIE_SAME_SITE and keeps production cookies secure", () => {
        for (const sameSite of ["lax", "strict", "none"]) {
            const options = getCookieOptions({
                NODE_ENV: "production",
                COOKIE_SAME_SITE: sameSite
            })
            assert.equal(options.secure, true)
            assert.equal(options.sameSite, sameSite)
        }

        const development = getCookieOptions({
            NODE_ENV: "development",
            COOKIE_SAME_SITE: "strict"
        })
        assert.equal(development.secure, false)
        assert.equal(development.sameSite, "lax")

        expectConfigError(
            () => getCookieOptions({ NODE_ENV: "production", COOKIE_SAME_SITE: "sometimes" }),
            /COOKIE_SAME_SITE/
        )
        expectConfigError(
            () => loadSecurityConfig(productionEnv({ COOKIE_SAME_SITE: "sometimes" })),
            /COOKIE_SAME_SITE/
        )
    })

    test("safe errors never contain the rejected secret value", () => {
        const secret = "do-not-leak-this-value"
        assert.throws(
            () => loadSecurityConfig(productionEnv({ JWT_SECRET: secret })),
            (error) => {
                assert.ok(error instanceof SecurityConfigError)
                assert.ok(!error.message.includes(secret), "error message must not include the secret")
                assert.ok(!error.stack.includes(secret), "error stack must not include the secret")
                return true
            }
        )
    })
})

describe("origin consistency and startup failure", () => {
    test("CORS, Socket.IO, and CSRF all receive the same validated origin list", async () => {
        const config = loadSecurityConfig(productionEnv())
        const handlers = createCsrfHandlers(config)

        await withProcessEnv({ JWT_SECRET: strongSecret, NODE_ENV: "production" }, () => {
            const trusted = makeRes()
            handlers.csrfBootstrap({ headers: { origin: "https://app.example.com" } }, trusted.res)
            assert.equal(trusted.recorded.statusCode, null)
            assert.ok(trusted.recorded.body.csrfToken)
            assert.equal(trusted.recorded.cookies.length, 1)

            const untrusted = makeRes()
            handlers.csrfBootstrap({ headers: { origin: "https://evil.example.com" } }, untrusted.res)
            assert.equal(untrusted.recorded.statusCode, 403)
            assert.deepEqual(untrusted.recorded.body, { message: "Invalid origin" })
        })

        assert.deepEqual(
            await validateSocketOrigin(config.allowedOrigins, "https://app.example.com"),
            { message: null, success: true }
        )
        assert.equal(
            (await validateSocketOrigin(config.allowedOrigins, "https://evil.example.com")).success,
            false
        )

        assert.match(indexSource, /const \{ allowedOrigins, trustedProxyCidrs = \[\] \} = securityConfig/)
        assert.match(indexSource, /allowRequest:\s*createSocketOriginValidator\(allowedOrigins\)/)
        assert.match(indexSource, /origin:\s*allowedOrigins/)
        assert.match(indexSource, /createCsrfHandlers\(securityConfig\)/)

        const validationIndex = indexSource.indexOf("loadSecurityConfig()")
        const listenIndex = indexSource.indexOf("server.listen(")
        assert.ok(validationIndex > -1)
        assert.ok(listenIndex > validationIndex, "configuration validation must run before the server listens")
    })

    test("startup fails safely when NODE_ENV is missing", () => {
        const result = runStartup({
            JWT_SECRET: strongSecret,
            ALLOWED_ORIGIN: "https://app.example.com"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /Security configuration error: NODE_ENV/)
        assert.ok(!result.stderr.includes(strongSecret), "startup output must not expose the secret")
    })

    test("startup fails safely when a production JWT secret is missing", () => {
        const result = runStartup({
            NODE_ENV: "production",
            ALLOWED_ORIGIN: "https://app.example.com"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /Security configuration error: JWT_SECRET/)
    })

    test("startup fails safely on a short production JWT secret without echoing it", () => {
        const shortSecret = "short-secret-must-not-print"
        const result = runStartup({
            NODE_ENV: "production",
            JWT_SECRET: shortSecret,
            ALLOWED_ORIGIN: "https://app.example.com"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /at least 32 characters/)
        assert.ok(!result.stderr.includes(shortSecret), "startup output must not expose the secret")
    })

    test("startup fails safely when production ALLOWED_ORIGIN is missing", () => {
        const result = runStartup({
            NODE_ENV: "production",
            JWT_SECRET: strongSecret
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /Security configuration error: ALLOWED_ORIGIN/)
    })

    test("startup fails safely on an invalid COOKIE_SAME_SITE value", () => {
        const result = runStartup({
            NODE_ENV: "production",
            JWT_SECRET: strongSecret,
            ALLOWED_ORIGIN: "https://app.example.com",
            COOKIE_SAME_SITE: "sometimes"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /COOKIE_SAME_SITE/)
    })

    test("startup fails safely on an invalid TRUST_PROXY_CIDRS value", () => {
        const result = runStartup({
            NODE_ENV: "production",
            JWT_SECRET: strongSecret,
            ALLOWED_ORIGIN: "https://app.example.com",
            TRUST_PROXY_CIDRS: "0.0.0.0/0"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /TRUST_PROXY_CIDRS/)
    })
})
