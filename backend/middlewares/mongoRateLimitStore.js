import mongoose from "mongoose"
import { SecurityConfigError } from "../config/security.js"
import { assertRateLimitConfig, getRateLimitConfig } from "../config/rateLimit.js"

const TTL_INDEX_NAME = "rate_limit_ttl"
const DEFAULT_STORE_TIMEOUT_MS = 2000

export class RateLimitStoreUnavailableError extends Error {
    constructor() {
        super("Rate limit service unavailable")
        this.name = "RateLimitStoreUnavailableError"
        this.statusCode = 503
        this.code = "RATE_LIMIT_STORE_UNAVAILABLE"
    }
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const withTimeout = (operation, timeoutMs) => {
    const operationPromise = Promise.resolve().then(operation)
    let timeoutId

    return new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
            reject(new RateLimitStoreUnavailableError())
        }, timeoutMs)

        operationPromise.then(
            (value) => {
                clearTimeout(timeoutId)
                resolve(value)
            },
            (error) => {
                clearTimeout(timeoutId)
                reject(error instanceof RateLimitStoreUnavailableError
                    ? error
                    : new RateLimitStoreUnavailableError())
            }
        )
    })
}

const getDefaultCollection = (collectionName) => {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
        throw new RateLimitStoreUnavailableError()
    }
    return mongoose.connection.db.collection(collectionName)
}

class UnavailableRateLimitStore {
    constructor() {
        this.prefix = "rate-limit-unavailable"
        this.localKeys = false
    }

    init() {}

    async increment() {
        throw new RateLimitStoreUnavailableError()
    }

    async decrement() {
        throw new RateLimitStoreUnavailableError()
    }

    async resetKey() {
        throw new RateLimitStoreUnavailableError()
    }

    async resetAll() {
        throw new RateLimitStoreUnavailableError()
    }

    async shutdown() {}
}

export class MongoRateLimitStore {
    constructor({
        collectionName,
        namespace,
        hashKey,
        timeoutMs = DEFAULT_STORE_TIMEOUT_MS,
        windowMs,
        getCollection = () => getDefaultCollection(collectionName)
    }) {
        if (typeof hashKey !== "function") {
            throw new SecurityConfigError("RATE_LIMIT_KEY_SECRET hashing is not configured")
        }

        this.collectionName = collectionName
        this.prefix = namespace
        this.localKeys = false
        this.hashKey = hashKey
        this.timeoutMs = timeoutMs
        this.windowMs = windowMs
        this.getCollection = getCollection
    }

    init(options) {
        if (Number.isFinite(options?.windowMs) && options.windowMs > 0) {
            this.windowMs = options.windowMs
        }
    }

    keyFor(key) {
        return `${this.prefix}:${this.hashKey(String(key))}`
    }

    requireWindowMs() {
        if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
            throw new RateLimitStoreUnavailableError()
        }
        return this.windowMs
    }

    async increment(key) {
        const windowMs = this.requireWindowMs()
        const documentId = this.keyFor(key)
        const expiredWindow = {
            $or: [
                { $eq: [{ $type: "$resetAt" }, "missing"] },
                { $eq: ["$resetAt", null] },
                { $lte: ["$resetAt", "$$NOW"] }
            ]
        }
        const update = [
            {
                $set: {
                    hits: {
                        $cond: [
                            expiredWindow,
                            1,
                            { $add: [{ $ifNull: ["$hits", 0] }, 1] }
                        ]
                    },
                    resetAt: {
                        $cond: [
                            expiredWindow,
                            { $add: ["$$NOW", windowMs] },
                            "$resetAt"
                        ]
                    }
                }
            }
        ]

        return withTimeout(async () => {
            const collection = await this.getCollection()

            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const document = await collection.findOneAndUpdate(
                        { _id: documentId },
                        update,
                        {
                            upsert: true,
                            returnDocument: "after",
                            maxTimeMS: this.timeoutMs,
                            writeConcern: { w: 1 }
                        }
                    )

                    if (!document) {
                        throw new RateLimitStoreUnavailableError()
                    }

                    return {
                        totalHits: document.hits,
                        resetTime: document.resetAt
                    }
                } catch (error) {
                    if (error?.code === 11000 && attempt === 0) {
                        continue
                    }
                    throw error
                }
            }

            throw new RateLimitStoreUnavailableError()
        }, this.timeoutMs)
    }

    async decrement(key) {
        const documentId = this.keyFor(key)

        return withTimeout(async () => {
            const collection = await this.getCollection()
            await collection.updateOne(
                { _id: documentId },
                [
                    {
                        $set: {
                            hits: {
                                $max: [
                                    0,
                                    { $subtract: [{ $ifNull: ["$hits", 0] }, 1] }
                                ]
                            }
                        }
                    }
                ],
                {
                    maxTimeMS: this.timeoutMs,
                    writeConcern: { w: 1 }
                }
            )
        }, this.timeoutMs)
    }

    async resetKey(key) {
        const documentId = this.keyFor(key)

        return withTimeout(async () => {
            const collection = await this.getCollection()
            await collection.deleteOne({ _id: documentId }, { maxTimeMS: this.timeoutMs })
        }, this.timeoutMs)
    }

    async resetAll() {
        const prefixPattern = `^${escapeRegExp(this.prefix)}:`

        return withTimeout(async () => {
            const collection = await this.getCollection()
            await collection.deleteMany(
                { _id: { $regex: prefixPattern } },
                { maxTimeMS: this.timeoutMs }
            )
        }, this.timeoutMs)
    }

    async shutdown() {}
}

export const createRateLimitStore = ({
    name = "default",
    windowMs,
    config = getRateLimitConfig()
} = {}) => {
    if (!config || config.store === "invalid") {
        return new UnavailableRateLimitStore()
    }
    if (config.store === "memory") {
        return undefined
    }

    const limiterName = typeof name === "string" ? name.trim() : ""
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(limiterName)) {
        throw new SecurityConfigError("rate limit limiter name is invalid")
    }

    return new MongoRateLimitStore({
        collectionName: config.collection,
        namespace: `${config.keyPrefix}:${limiterName}`,
        hashKey: config.hashKey,
        timeoutMs: config.timeoutMs,
        windowMs
    })
}

export const initializeRateLimitStore = async (config = getRateLimitConfig()) => {
    const resolvedConfig = assertRateLimitConfig(config)
    if (resolvedConfig.store === "memory") {
        return
    }

    const collection = getDefaultCollection(resolvedConfig.collection)
    await withTimeout(
        () => collection.createIndex(
            { resetAt: 1 },
            { expireAfterSeconds: 0, name: TTL_INDEX_NAME }
        ),
        resolvedConfig.timeoutMs
    )
}
