import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

import connectDb from "../config/db.js"
import { SecurityConfigError, loadSecurityConfig } from "../config/security.js"
import { createApplication, createShutdownHandler, startServer } from "../index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, "..")

const testSecurityConfig = loadSecurityConfig({
    NODE_ENV: "test",
    JWT_SECRET: "startup-test-secret-0123456789-abcdef",
    ALLOWED_ORIGIN: "http://localhost:5173"
})

const requestHealth = (app, route) => request(app).get(route)

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
        "DOTENV_CONFIG_PATH",
        "MONGODB_URL",
        "PORT"
    ]) {
        delete env[key]
    }
    return { ...env, ...overrides }
}

const runStartup = (overrides) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vingo-startup-"))
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

describe("database readiness and startup ordering (Stage 7A.4)", () => {
    test("security validation and the database connection complete before the app is built and listens", async () => {
        const events = []
        const fakeServer = { listening: false }
        const fakeIo = {}

        const result = await startServer({
            securityConfig: testSecurityConfig,
            connectDatabase: async () => {
                events.push("database")
            },
            buildApplication: (receivedConfig) => {
                assert.equal(receivedConfig, testSecurityConfig)
                events.push("application")
                return { app: {}, server: fakeServer, io: fakeIo }
            },
            startListening: async (server, port) => {
                assert.equal(server, fakeServer)
                events.push(`listen:${port}`)
            },
            port: 4321,
            logger: {
                log: (message) => events.push(`log:${message}`),
                error: () => {}
            }
        })

        assert.deepEqual(events, [
            "database",
            "application",
            "listen:4321",
            "log:server started at 4321"
        ])
        assert.equal(result.securityConfig, testSecurityConfig)
        assert.equal(result.server, fakeServer)
        assert.equal(result.io, fakeIo)
    })

    test("security configuration failure prevents the database connection and listener", async () => {
        let connected = false
        let built = false
        let listened = false

        await assert.rejects(
            startServer({
                configLoader: () => {
                    throw new SecurityConfigError("NODE_ENV must be explicitly set")
                },
                connectDatabase: async () => {
                    connected = true
                },
                buildApplication: () => {
                    built = true
                    return { app: {}, server: {}, io: {} }
                },
                startListening: async () => {
                    listened = true
                }
            }),
            SecurityConfigError
        )

        assert.equal(connected, false)
        assert.equal(built, false)
        assert.equal(listened, false)
    })

    test("database connection failure prevents the application and listener from starting", async () => {
        let built = false
        let listened = false
        const logged = []

        await assert.rejects(
            startServer({
                securityConfig: testSecurityConfig,
                connectDatabase: async () => {
                    throw new Error("database connection failed")
                },
                buildApplication: () => {
                    built = true
                    return { app: {}, server: {}, io: {} }
                },
                startListening: async () => {
                    listened = true
                },
                logger: {
                    log: (message) => logged.push(message),
                    error: (message) => logged.push(message)
                }
            }),
            /database connection failed/
        )

        assert.equal(built, false)
        assert.equal(listened, false)
        assert.deepEqual(logged, [])
    })

    test("startup rejects a missing database URL before listening", () => {
        const result = runStartup({
            NODE_ENV: "test",
            JWT_SECRET: "startup-test-secret-0123456789-abcdef",
            ALLOWED_ORIGIN: "http://localhost:5173"
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /Server startup failed/)
        assert.ok(!result.stdout.includes("server started"))
        assert.ok(!result.stderr.includes("MONGODB_URL"))
    })

    test("startup exits non-zero on database failure without printing the connection URI", () => {
        const secretMarker = "startup-db-password-marker"
        const result = runStartup({
            NODE_ENV: "test",
            JWT_SECRET: "startup-test-secret-0123456789-abcdef",
            ALLOWED_ORIGIN: "http://localhost:5173",
            MONGODB_URL: `mongodb://startupUser:${secretMarker}@127.0.0.1:1/vingo_startup?serverSelectionTimeoutMS=250`
        })

        assert.equal(result.status, 1)
        assert.match(result.stderr, /Server startup failed/)
        assert.ok(!result.stdout.includes("server started"))
        assert.ok(!result.stderr.includes(secretMarker), "startup output must not expose the password")
        assert.ok(!result.stderr.includes("mongodb://"), "startup output must not expose the URI")
    })

    test("readiness follows the live MongoDB connection while liveness stays independent", async () => {
        const mongo = await MongoMemoryServer.create()
        const previousMongoUrl = process.env.MONGODB_URL
        process.env.MONGODB_URL = mongo.getUri()
        const { app } = createApplication(testSecurityConfig)

        try {
            assert.notEqual(mongoose.connection.readyState, 1)
            const disconnectedReadiness = await requestHealth(app, "/readyz")
            assert.equal(disconnectedReadiness.status, 503)
            assert.deepEqual(disconnectedReadiness.body, { status: "unavailable" })
            assert.equal((await requestHealth(app, "/healthz")).status, 200)

            await connectDb()
            assert.equal(mongoose.connection.readyState, 1)
            const connectedReadiness = await requestHealth(app, "/readyz")
            assert.equal(connectedReadiness.status, 200)
            assert.deepEqual(connectedReadiness.body, { status: "ready" })
            assert.equal((await requestHealth(app, "/healthz")).status, 200)

            await mongoose.disconnect()
            const reDisconnectedReadiness = await requestHealth(app, "/readyz")
            assert.equal(reDisconnectedReadiness.status, 503)
            assert.deepEqual(reDisconnectedReadiness.body, { status: "unavailable" })
            assert.equal((await requestHealth(app, "/healthz")).status, 200)
        } finally {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect()
            }
            if (previousMongoUrl === undefined) {
                delete process.env.MONGODB_URL
            } else {
                process.env.MONGODB_URL = previousMongoUrl
            }
            await mongo.stop()
        }
    })

    test("readiness reports unavailable while the driver is connecting", async () => {
        const { app } = createApplication(testSecurityConfig, {
            getDatabaseConnectionState: () => 2
        })

        const readiness = await requestHealth(app, "/readyz")
        assert.equal(readiness.status, 503)
        assert.deepEqual(readiness.body, { status: "unavailable" })
        assert.equal((await requestHealth(app, "/healthz")).status, 200)
    })

    test("a connected database allows real HTTP startup and graceful shutdown", async () => {
        const mongo = await MongoMemoryServer.create()
        const previousMongoUrl = process.env.MONGODB_URL
        process.env.MONGODB_URL = mongo.getUri()
        let started

        try {
            started = await startServer({
                securityConfig: testSecurityConfig,
                port: 0,
                logger: { log: () => {} }
            })
            const { server, io } = started
            assert.equal(server.listening, true)

            const address = server.address()
            const baseUrl = `http://127.0.0.1:${address.port}`
            const liveness = await request(baseUrl).get("/healthz")
            assert.equal(liveness.status, 200)
            assert.deepEqual(liveness.body, { status: "ok" })
            const readiness = await request(baseUrl).get("/readyz")
            assert.equal(readiness.status, 200)
            assert.deepEqual(readiness.body, { status: "ready" })

            const exitCodes = []
            const shutdown = createShutdownHandler({
                server,
                io,
                disconnectDatabase: () => mongoose.disconnect(),
                timeoutMs: 2000,
                logger: { log: () => {}, error: () => {} },
                exit: (code) => exitCodes.push(code)
            })
            await shutdown()

            assert.equal(server.listening, false)
            assert.equal(mongoose.connection.readyState, 0)
            assert.deepEqual(exitCodes, [0])
        } finally {
            if (started?.server?.listening) {
                await new Promise((resolve) => started.server.close(resolve))
            }
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect()
            }
            if (previousMongoUrl === undefined) {
                delete process.env.MONGODB_URL
            } else {
                process.env.MONGODB_URL = previousMongoUrl
            }
            await mongo.stop()
        }
    })

    test("shutdown closes the HTTP server, Socket.IO, and MongoDB exactly once", async () => {
        const calls = []
        const exitCodes = []
        const shutdown = createShutdownHandler({
            server: {
                close(callback) {
                    calls.push("http")
                    callback()
                }
            },
            io: {
                close(callback) {
                    calls.push("io")
                    callback()
                }
            },
            disconnectDatabase: async () => {
                calls.push("database")
            },
            timeoutMs: 1000,
            logger: {
                log: () => {},
                error: () => {}
            },
            exit: (code) => exitCodes.push(code)
        })

        await Promise.all([shutdown(), shutdown()])

        assert.deepEqual(calls.slice().sort(), ["database", "http", "io"])
        assert.deepEqual(exitCodes, [0])
    })

    test("shutdown cannot hang indefinitely when resources do not close", async () => {
        const exitCodes = []
        const shutdown = createShutdownHandler({
            server: { close: () => {} },
            io: { close: () => {} },
            disconnectDatabase: async () => {},
            timeoutMs: 20,
            logger: {
                log: () => {},
                error: () => {}
            },
            exit: (code) => exitCodes.push(code)
        })

        await shutdown()

        assert.deepEqual(exitCodes, [1])
    })
})
