import crypto from "node:crypto"
import { SecurityConfigError, getNodeEnv } from "./security.js"

export const SUPPORTED_RATE_LIMIT_STORES = Object.freeze(["memory", "mongo"])
export const DEFAULT_RATE_LIMIT_COLLECTION = "rate_limit_counters"
export const DEFAULT_RATE_LIMIT_TIMEOUT_MS = 2000
export const MIN_RATE_LIMIT_KEY_SECRET_LENGTH = 32
const MAX_RATE_LIMIT_KEY_SECRET_LENGTH = 4096
const DEFAULT_RATE_LIMIT_KEY_PREFIX = "vingo"
const PLACEHOLDER_SECRETS = new Set([
    "changeme",
    "change_me",
    "change-me",
    "default",
    "development",
    "example",
    "password",
    "production",
    "sample",
    "secret",
    "test"
])
const PLACEHOLDER_SECRET_PATTERNS = Object.freeze([
    /^change[_-]?me$/i,
    /^replace[_-]?with/i,
    /^your[_-]/i,
    /^example[_-]/i
])

const fail = (message) => {
    throw new SecurityConfigError(message)
}

const optionalValue = (value) => {
    if (typeof value !== "string") {
        return ""
    }
    return value.trim()
}

export const validateRateLimitKeySecret = (value) => {
    if (typeof value !== "string" || value === "") {
        fail("RATE_LIMIT_KEY_SECRET must be set when RATE_LIMIT_STORE is mongo")
    }
    if (value !== value.trim()) {
        fail("RATE_LIMIT_KEY_SECRET must not contain leading or trailing whitespace")
    }
    if (value.length < MIN_RATE_LIMIT_KEY_SECRET_LENGTH) {
        fail(`RATE_LIMIT_KEY_SECRET must be at least ${MIN_RATE_LIMIT_KEY_SECRET_LENGTH} characters`)
    }
    if (value.length > MAX_RATE_LIMIT_KEY_SECRET_LENGTH) {
        fail(`RATE_LIMIT_KEY_SECRET must be at most ${MAX_RATE_LIMIT_KEY_SECRET_LENGTH} characters`)
    }

    const normalized = value.toLowerCase()
    if (
        PLACEHOLDER_SECRETS.has(normalized) ||
        PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(normalized))
    ) {
        fail("RATE_LIMIT_KEY_SECRET must not use a known placeholder value")
    }

    return value
}

export const createRateLimitKeyHasher = (secret) => {
    const keySecret = validateRateLimitKeySecret(secret)
    return (key) => crypto.createHmac("sha256", keySecret).update(String(key), "utf8").digest("hex")
}

const resolveStore = (rawStore, { production }) => {
    const configured = optionalValue(rawStore).toLowerCase()
    if (configured === "") {
        if (production) {
            fail('RATE_LIMIT_STORE must be set to "mongo" in production')
        }
        return "memory"
    }
    if (!SUPPORTED_RATE_LIMIT_STORES.includes(configured)) {
        fail("RATE_LIMIT_STORE must be one of: memory, mongo")
    }
    if (production && configured !== "mongo") {
        fail('RATE_LIMIT_STORE must be "mongo" in production')
    }
    return configured
}

const resolveCollection = (rawCollection) => {
    const configured = optionalValue(rawCollection)
    if (configured === "") {
        return DEFAULT_RATE_LIMIT_COLLECTION
    }
    if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(configured) ||
        configured.startsWith("system.")
    ) {
        fail("RATE_LIMIT_MONGO_COLLECTION must be a valid collection name")
    }
    return configured
}

const resolveTimeout = (rawTimeout) => {
    const configured = optionalValue(rawTimeout)
    if (configured === "") {
        return DEFAULT_RATE_LIMIT_TIMEOUT_MS
    }
    if (!/^\d+$/.test(configured)) {
        fail("RATE_LIMIT_MONGO_TIMEOUT_MS must be an integer between 100 and 10000")
    }
    const timeout = Number(configured)
    if (timeout < 100 || timeout > 10000) {
        fail("RATE_LIMIT_MONGO_TIMEOUT_MS must be an integer between 100 and 10000")
    }
    return timeout
}

const resolveKeyPrefix = (rawPrefix, nodeEnv) => {
    const configured = optionalValue(rawPrefix)
    if (configured === "") {
        return `${DEFAULT_RATE_LIMIT_KEY_PREFIX}:${nodeEnv}`
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(configured)) {
        fail("RATE_LIMIT_KEY_PREFIX must contain only letters, numbers, dots, underscores, colons, or hyphens")
    }
    return configured
}

export const loadRateLimitConfig = (env = process.env) => {
    const nodeEnv = getNodeEnv(env)
    const production = nodeEnv === "production"
    const store = resolveStore(env.RATE_LIMIT_STORE, { production })
    const collection = resolveCollection(env.RATE_LIMIT_MONGO_COLLECTION)
    const timeoutMs = resolveTimeout(env.RATE_LIMIT_MONGO_TIMEOUT_MS)
    const keyPrefix = resolveKeyPrefix(env.RATE_LIMIT_KEY_PREFIX, nodeEnv)
    const hashKey = store === "mongo"
        ? createRateLimitKeyHasher(env.RATE_LIMIT_KEY_SECRET)
        : null

    return Object.freeze({
        store,
        collection,
        timeoutMs,
        keyPrefix,
        hashKey
    })
}

let cachedConfig

export const getRateLimitConfig = () => {
    if (!cachedConfig) {
        try {
            cachedConfig = loadRateLimitConfig(process.env)
        } catch (error) {
            cachedConfig = Object.freeze({ store: "invalid", error })
        }
    }
    return cachedConfig
}

export const assertRateLimitConfig = (config = getRateLimitConfig()) => {
    if (!config || config.store === "invalid") {
        if (config?.error instanceof Error) {
            throw config.error
        }
        fail("RATE_LIMIT_STORE configuration is invalid")
    }
    return config
}
