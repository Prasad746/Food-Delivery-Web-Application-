import { describe, test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

import { startServer } from "../index.js"
import {
    loadRateLimitConfig,
    createRateLimitKeyHasher
} from "../config/rateLimit.js"
import { SecurityConfigError, loadSecurityConfig } from "../config/security.js"
import { errorHandler } from "../middlewares/errorHandler.js"
import { createOrderRateLimiter } from "../middlewares/orderRateLimit.js"
import {
    MongoRateLimitStore,
    createRateLimitStore,
    initializeRateLimitStore
} from "../middlewares/mongoRateLimitStore.js"

const COLLECTION = "rate_limit_store_test_counters"
const SECRET = "rate-limit-hmac-test-secret-0123456789-abcdef"
const OTHER_SECRET = "other-rate-limit-hmac-secret-0123456789-abcdef"

let mongo

const makeConfig = (overrides = {}) => loadRateLimitConfig({
    NODE_ENV: "test",
    RATE_LIMIT_STORE: "mongo",
    RATE_LIMIT_KEY_SECRET: SECRET,
    RATE_LIMIT_MONGO_COLLECTION: COLLECTION,
    RATE_LIMIT_MONGO_TIMEOUT_MS: "2000",
    RATE_LIMIT_KEY_PREFIX: "vingo:test",
    ...overrides
})

const delay = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
})

const buildLimiterApp = (limiter) => {
    const app = express()
    app.use((req, res, next) => {
        if (req.headers["x-user-id"]) {
            req.userId = req.headers["x-user-id"]
        }
        next()
    })
    app.get("/limited", limiter, (req, res) => res.status(200).json({ ok: true }))
    app.use(errorHandler)
    return app
}

const storeFor = (name, windowMs, config = makeConfig()) =>
    createRateLimitStore({ name, windowMs, config })

const limiterFor = ({ limit, windowMs = 60 * 1000, name, store }) =>
    createOrderRateLimiter({ limit, windowMs }, { name, store })

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await initializeRateLimitStore(makeConfig())
})

after(async () => {
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.dropCollection(COLLECTION).catch(() => {})
    }
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await mongoose.connection.db.collection(COLLECTION).deleteMany({})
})

describe("MongoDB rate-limit store (Stage 7A.8)", () => {
    test("creates a TTL index for expired counters", async () => {
        const indexes = await mongoose.connection.db.collection(COLLECTION).listIndexes().toArray()
        const ttlIndex = indexes.find((index) => index.name === "rate_limit_ttl")

        assert.ok(ttlIndex, "the resetAt TTL index must exist")
        assert.deepEqual(ttlIndex.key, { resetAt: 1 })
        assert.equal(ttlIndex.expireAfterSeconds, 0)
    })

    test("expires a fixed window and starts a new one after the window passes", async () => {
        const store = storeFor("expiry", 200)

        const first = await store.increment("u:expiry-user")
        assert.equal(first.totalHits, 1)
        const firstReset = first.resetTime.getTime()

        const second = await store.increment("u:expiry-user")
        assert.equal(second.totalHits, 2)
        assert.equal(second.resetTime.getTime(), firstReset)

        await delay(300)

        const third = await store.increment("u:expiry-user")
        assert.equal(third.totalHits, 1)
        assert.ok(third.resetTime.getTime() > firstReset)
    })

    test("concurrent increments across store instances are atomic", async () => {
        const config = makeConfig()
        const firstStore = storeFor("concurrent", 60 * 1000, config)
        const secondStore = storeFor("concurrent", 60 * 1000, config)

        const results = await Promise.all(
            Array.from({ length: 24 }, (_, index) =>
                (index % 2 === 0 ? firstStore : secondStore).increment("u:concurrent-user")
            )
        )

        assert.deepEqual(
            results.map((result) => result.totalHits).sort((left, right) => left - right),
            Array.from({ length: 24 }, (_, index) => index + 1)
        )

        const document = await mongoose.connection.db
            .collection(COLLECTION)
            .findOne({ _id: { $regex: "concurrent" } })
        assert.equal(document.hits, 24)
    })

    test("two application instances enforce one shared counter", async () => {
        const config = makeConfig()
        const firstStore = storeFor("cross-instance", 60 * 1000, config)
        const secondStore = storeFor("cross-instance", 60 * 1000, config)
        const firstApp = buildLimiterApp(limiterFor({
            limit: 2,
            name: "cross-instance",
            store: firstStore
        }))
        const secondApp = buildLimiterApp(limiterFor({
            limit: 2,
            name: "cross-instance",
            store: secondStore
        }))

        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-shared")).status, 200)
        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-shared")).status, 200)
        assert.equal((await request(firstApp).get("/limited").set("X-User-Id", "user-shared")).status, 429)
        assert.equal(
            (await request(secondApp).get("/limited").set("X-User-Id", "user-shared")).status,
            429,
            "the second instance must see the first instance's counter"
        )
        assert.equal((await request(secondApp).get("/limited").set("X-User-Id", "user-other")).status, 200)

        const documents = await mongoose.connection.db.collection(COLLECTION).find({}).toArray()
        const storedKeys = documents.map((document) => document._id).join(" ")
        assert.ok(!storedKeys.includes("user-shared"))
        assert.ok(!storedKeys.includes("user-other"))
        assert.ok(!storedKeys.includes("127.0.0.1"))
    })

    test("per-route limiter names keep upload buckets separate", async () => {
        const addApp = buildLimiterApp(limiterFor({
            limit: 1,
            name: "upload-add-item",
            store: storeFor("upload-add-item", 60 * 1000)
        }))
        const editApp = buildLimiterApp(limiterFor({
            limit: 1,
            name: "upload-edit-item",
            store: storeFor("upload-edit-item", 60 * 1000)
        }))

        assert.equal((await request(addApp).get("/limited").set("X-User-Id", "owner-a")).status, 200)
        assert.equal((await request(addApp).get("/limited").set("X-User-Id", "owner-a")).status, 429)
        assert.equal((await request(editApp).get("/limited").set("X-User-Id", "owner-a")).status, 200)
    })

    test("HMAC hashing is deterministic, keyed, and never stores the raw identifier", () => {
        const config = makeConfig()
        const hashed = config.hashKey("u:user-123")

        assert.match(hashed, /^[0-9a-f]{64}$/)
        assert.equal(hashed, config.hashKey("u:user-123"))
        assert.notEqual(hashed, config.hashKey("u:user-456"))
        assert.notEqual(hashed, "u:user-123")
        assert.ok(!JSON.stringify(config).includes(SECRET), "the config must not serialize the secret")

        const otherHasher = createRateLimitKeyHasher(OTHER_SECRET)
        assert.notEqual(hashed, otherHasher("u:user-123"))

        const store = storeFor("hash-check", 60 * 1000, config)
        assert.ok(!store.keyFor("u:user-123").includes("user-123"))
    })

    test("store failures fail closed with a generic 503", async () => {
        const config = makeConfig()
        const store = new MongoRateLimitStore({
            collectionName: COLLECTION,
            namespace: "vingo:test:failure",
            hashKey: config.hashKey,
            timeoutMs: 50,
            windowMs: 60 * 1000,
            getCollection: () => {
                throw new Error("mongodb detail that must not leak")
            }
        })
        const app = buildLimiterApp(limiterFor({
            limit: 5,
            name: "failure",
            store
        }))

        const response = await request(app).get("/limited").set("X-User-Id", "user-failure")

        assert.equal(response.status, 503)
        assert.deepEqual(response.body, { message: "Rate limit service unavailable" })
        assert.ok(!JSON.stringify(response.body).includes("mongodb detail"))
        assert.ok(!JSON.stringify(response.body).includes("user-failure"))
    })

    test("store operations time out and fail closed", async () => {
        const config = makeConfig()
        const hangingCollection = {
            findOneAndUpdate: () => new Promise(() => {})
        }
        const store = new MongoRateLimitStore({
            collectionName: COLLECTION,
            namespace: "vingo:test:timeout",
            hashKey: config.hashKey,
            timeoutMs: 25,
            windowMs: 60 * 1000,
            getCollection: () => hangingCollection
        })

        await assert.rejects(
            store.increment("u:timeout-user"),
            (error) => {
                assert.equal(error.statusCode, 503)
                assert.ok(!error.message.includes("timeout-user"))
                return true
            }
        )
    })

    test("invalid shared-store configuration prevents startup before connecting", async () => {
        const securityConfig = loadSecurityConfig({
            NODE_ENV: "test",
            JWT_SECRET: "rate-limit-store-test-secret-0123456789-abcdef",
            ALLOWED_ORIGIN: "http://localhost:5173"
        })
        let connected = false

        await assert.rejects(
            startServer({
                securityConfig,
                rateLimitConfig: {
                    store: "invalid",
                    error: new SecurityConfigError('RATE_LIMIT_STORE must be set to "mongo" in production')
                },
                connectDatabase: async () => {
                    connected = true
                },
                buildApplication: () => {
                    throw new Error("the application must not be built")
                },
                startListening: async () => {
                    throw new Error("the server must not listen")
                }
            }),
            /RATE_LIMIT_STORE/
        )

        assert.equal(connected, false)
    })
})

describe("rate-limit configuration (Stage 7A.8)", () => {
    const productionEnv = (overrides = {}) => ({
        NODE_ENV: "production",
        RATE_LIMIT_STORE: "mongo",
        RATE_LIMIT_KEY_SECRET: SECRET,
        RATE_LIMIT_MONGO_COLLECTION: COLLECTION,
        ...overrides
    })

    test("requires MongoDB and a dedicated strong secret in production", () => {
        assert.equal(loadRateLimitConfig(productionEnv()).store, "mongo")

        const missingStore = productionEnv()
        delete missingStore.RATE_LIMIT_STORE
        assert.throws(() => loadRateLimitConfig(missingStore), /RATE_LIMIT_STORE/)

        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_STORE: "memory" })),
            /mongo/
        )

        const missingSecret = productionEnv()
        delete missingSecret.RATE_LIMIT_KEY_SECRET
        assert.throws(() => loadRateLimitConfig(missingSecret), /RATE_LIMIT_KEY_SECRET/)

        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_KEY_SECRET: "short" })),
            /at least 32/
        )
        assert.throws(
            () => loadRateLimitConfig(productionEnv({
                RATE_LIMIT_KEY_SECRET: "replace_with_a_secure_random_string_at_least_32_characters"
            })),
            /placeholder/
        )
    })

    test("does not expose the secret in errors or config serialization", () => {
        const secret = "do-not-leak-rate-limit-secret-0123456789"
        const config = loadRateLimitConfig(productionEnv({ RATE_LIMIT_KEY_SECRET: secret }))

        assert.ok(!JSON.stringify(config).includes(secret))
        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_KEY_SECRET: `${secret} ` })),
            (error) => {
                assert.ok(error instanceof SecurityConfigError)
                assert.ok(!error.message.includes(secret))
                assert.ok(!error.stack.includes(secret))
                return true
            }
        )
    })

    test("validates collection, timeout, and prefix overrides", () => {
        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_MONGO_COLLECTION: "system.profile" })),
            /RATE_LIMIT_MONGO_COLLECTION/
        )
        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_MONGO_TIMEOUT_MS: "0" })),
            /RATE_LIMIT_MONGO_TIMEOUT_MS/
        )
        assert.throws(
            () => loadRateLimitConfig(productionEnv({ RATE_LIMIT_KEY_PREFIX: "bad prefix" })),
            /RATE_LIMIT_KEY_PREFIX/
        )
    })

    test("development and test modes default to memory without a secret", () => {
        assert.equal(loadRateLimitConfig({ NODE_ENV: "test" }).store, "memory")
        assert.equal(loadRateLimitConfig({ NODE_ENV: "development" }).store, "memory")
    })
})
