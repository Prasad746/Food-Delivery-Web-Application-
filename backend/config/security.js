import dotenv from "dotenv"
import net from "node:net"

dotenv.config({ quiet: true })

export const SUPPORTED_NODE_ENVS = Object.freeze(["development", "test", "production"])
export const SUPPORTED_COOKIE_SAME_SITE = Object.freeze(["lax", "strict", "none"])
export const PRODUCTION_JWT_SECRET_MIN_LENGTH = 32
export const DEFAULT_DEVELOPMENT_ORIGINS = Object.freeze([
    "http://localhost:5173",
    "http://127.0.0.1:5173"
])

const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PLACEHOLDER_SECRETS = new Set([
    "changeme",
    "change_me",
    "change-me",
    "default",
    "development",
    "example",
    "jwt_secret",
    "jwt-secret",
    "jwtsecret",
    "password",
    "production",
    "replace_with_a_secure_random_string_at_least_32_characters",
    "sample",
    "secret",
    "secret_key",
    "secret-key",
    "secretkey",
    "test",
    "your_jwt_secret",
    "your-secret-key",
    "your_secret_key"
])
const PLACEHOLDER_SECRET_PATTERNS = Object.freeze([
    /^change[_-]?me$/i,
    /^replace[_-]?with[_-]/i,
    /^your[_-]/i
])

export class SecurityConfigError extends Error {
    constructor(message) {
        super(message)
        this.name = "SecurityConfigError"
    }
}

const fail = (message) => {
    throw new SecurityConfigError(message)
}

const requireSupportedNodeEnv = (value) => {
    if (!SUPPORTED_NODE_ENVS.includes(value)) {
        fail("NODE_ENV must be explicitly set to one of: development, test, production")
    }
    return value
}

// Runtime helpers keep the existing development/test harness behavior when
// NODE_ENV is absent or empty. The application entrypoint always calls
// loadSecurityConfig() first, which rejects that state.
const resolveRuntimeNodeEnv = (value) => {
    if (value === undefined || value === "") {
        return "development"
    }
    return requireSupportedNodeEnv(value)
}

export const getNodeEnv = (env = process.env) => resolveRuntimeNodeEnv(env.NODE_ENV)

export const isProduction = (env = process.env) => getNodeEnv(env) === "production"

/*
 * Production JWT secrets must come from a cryptographically secure random
 * source. Generate one once with:
 *
 *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
 *
 * Store it only in the deployment secret manager. Length is a required floor,
 * not proof of entropy; known copied example values are rejected separately.
 */
export const validateJwtSecret = (value, { production = false } = {}) => {
    const secret = typeof value === "string" ? value : ""
    if (secret.trim() === "") {
        fail("JWT_SECRET must be set")
    }

    const normalized = secret.trim().toLowerCase()
    if (
        PLACEHOLDER_SECRETS.has(normalized) ||
        PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(normalized))
    ) {
        fail("JWT_SECRET must not use a known placeholder value")
    }

    if (production && secret.length < PRODUCTION_JWT_SECRET_MIN_LENGTH) {
        fail(`JWT_SECRET must be at least ${PRODUCTION_JWT_SECRET_MIN_LENGTH} characters in production`)
    }

    return secret
}

const normalizeCookieSameSite = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null
    }
    const normalized = String(value).trim().toLowerCase()
    if (!SUPPORTED_COOKIE_SAME_SITE.includes(normalized)) {
        fail("COOKIE_SAME_SITE must be one of: lax, strict, none")
    }
    return normalized
}

export const resolveCookieOptions = (sameSiteValue, nodeEnv) => {
    const isProduction = nodeEnv === "production"
    const configuredSameSite = normalizeCookieSameSite(sameSiteValue)
    const sameSite = isProduction ? (configuredSameSite || "none") : "lax"

    return Object.freeze({
        secure: isProduction,
        sameSite,
        httpOnly: true,
        maxAge: COOKIE_MAX_AGE_MS
    })
}

const parseOrigin = (value, { production }) => {
    if (typeof value !== "string" || value.trim() === "") {
        fail("ALLOWED_ORIGIN contains an empty entry")
    }

    const origin = value.trim()
    if (origin === "*" || origin === "null") {
        fail("ALLOWED_ORIGIN contains an invalid origin")
    }

    let parsed
    try {
        parsed = new URL(origin)
    } catch {
        fail("ALLOWED_ORIGIN contains an invalid origin")
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail("ALLOWED_ORIGIN contains an invalid origin")
    }
    if (production && parsed.protocol !== "https:") {
        fail("ALLOWED_ORIGIN must use HTTPS in production")
    }
    if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/" ||
        parsed.origin !== origin
    ) {
        fail("ALLOWED_ORIGIN contains an invalid origin")
    }

    return parsed.origin
}

export const resolveAllowedOrigins = (rawOrigins, nodeEnv) => {
    const isProduction = nodeEnv === "production"
    const rawValue = typeof rawOrigins === "string" ? rawOrigins : ""

    if (rawValue.trim() === "") {
        if (isProduction) {
            fail("ALLOWED_ORIGIN is required in production")
        }
        return DEFAULT_DEVELOPMENT_ORIGINS
    }

    const entries = rawValue.split(",")
    if (entries.some((entry) => entry.trim() === "")) {
        fail("ALLOWED_ORIGIN contains an empty entry")
    }

    const configuredOrigins = entries.map((entry) => parseOrigin(entry, { production: isProduction }))
    const origins = isProduction
        ? configuredOrigins
        : [...DEFAULT_DEVELOPMENT_ORIGINS, ...configuredOrigins]

    return Object.freeze([...new Set(origins)])
}

export const resolveTrustedProxyCidrs = (rawCidrs) => {
    if (typeof rawCidrs !== "string" || rawCidrs.trim() === "") {
        return Object.freeze([])
    }

    const entries = rawCidrs.split(",")
    if (entries.some((entry) => entry.trim() === "")) {
        fail("TRUST_PROXY_CIDRS contains an empty entry")
    }

    const cidrs = entries.map((entry) => {
        const value = entry.trim()
        const separator = value.indexOf("/")
        const address = separator === -1 ? value : value.slice(0, separator)
        const family = net.isIP(address)
        if (family === 0 || address.includes("%")) {
            fail("TRUST_PROXY_CIDRS contains an invalid IP address")
        }

        const prefixText = separator === -1 ? String(family === 4 ? 32 : 128) : value.slice(separator + 1)
        if (!/^\d+$/.test(prefixText)) {
            fail("TRUST_PROXY_CIDRS contains an invalid prefix length")
        }

        const prefix = Number(prefixText)
        const maxPrefix = family === 4 ? 32 : 128
        if (prefix < 1 || prefix > maxPrefix) {
            fail(`TRUST_PROXY_CIDRS prefix lengths must be between 1 and ${maxPrefix}`)
        }

        return `${address}/${prefix}`
    })

    return Object.freeze([...new Set(cidrs)])
}

// Always returns an explicit trust function. With `trust proxy: false`,
// express-rate-limit reports client-supplied X-Forwarded-For headers as
// configuration errors even though Express correctly ignores them. A compiled
// checker that trusts nothing keeps those headers ignored while making the
// trust decision explicit and auditable.
export const createTrustedProxyChecker = (cidrs = []) => {
    const list = Array.isArray(cidrs) ? cidrs : []
    const blockList = new net.BlockList()
    for (const cidr of list) {
        const [address, prefixText] = cidr.split("/")
        blockList.addSubnet(address, Number(prefixText), net.isIP(address) === 6 ? "ipv6" : "ipv4")
    }

    return (ip) => {
        if (typeof ip !== "string") {
            return false
        }
        const family = net.isIP(ip)
        if (family === 4) {
            return blockList.check(ip, "ipv4")
        }
        if (family === 6) {
            return blockList.check(ip, "ipv6")
        }
        return false
    }
}

export const loadSecurityConfig = (env = process.env) => {
    const nodeEnv = requireSupportedNodeEnv(env.NODE_ENV)
    const production = nodeEnv === "production"

    validateJwtSecret(env.JWT_SECRET, { production })
    const allowedOrigins = resolveAllowedOrigins(env.ALLOWED_ORIGIN, nodeEnv)
    const cookieOptions = resolveCookieOptions(env.COOKIE_SAME_SITE, nodeEnv)
    const trustedProxyCidrs = resolveTrustedProxyCidrs(env.TRUST_PROXY_CIDRS)

    return Object.freeze({
        nodeEnv,
        isProduction: production,
        allowedOrigins,
        cookieOptions,
        trustedProxyCidrs
    })
}

export const getJwtSecret = (env = process.env) =>
    validateJwtSecret(env.JWT_SECRET, { production: isProduction(env) })

export const getAllowedOrigins = (env = process.env) =>
    resolveAllowedOrigins(env.ALLOWED_ORIGIN, getNodeEnv(env))

export const getCookieOptions = (env = process.env) =>
    resolveCookieOptions(env.COOKIE_SAME_SITE, getNodeEnv(env))
