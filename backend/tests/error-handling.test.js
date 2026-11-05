import { test, describe, before, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import request from "supertest"
import express from "express"

import { errorHandler } from "../middlewares/errorHandler.js"

const INDEX_SOURCE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js"),
    "utf8"
)

let app
let originalNodeEnv
let originalConsoleError

const setNodeEnv = (value) => {
    if (value === undefined) {
        delete process.env.NODE_ENV
    } else {
        process.env.NODE_ENV = value
    }
}

before(() => {
    originalNodeEnv = process.env.NODE_ENV

    app = express()
    app.use(express.json())
    app.post("/api/boom", async () => {
        throw new Error("db: mongodb+srv://internal-host/secret-db")
    })
    app.get("/api/denied", async () => {
        const error = new Error("owner-only internal rule text")
        error.statusCode = 403
        throw error
    })
    app.get("/api/teapot", () => {
        const error = new Error("short and stout")
        error.statusCode = 418
        throw error
    })
    app.use(errorHandler)
})

after(() => {
    setNodeEnv(originalNodeEnv)
})

beforeEach(() => {
    originalConsoleError = console.error
    console.error = () => {}
})

afterEach(() => {
    console.error = originalConsoleError
    setNodeEnv(originalNodeEnv)
})

describe("safe error handling and logging (Stage 6E)", () => {
    test("development responses keep actionable messages but never include stack traces", async () => {
        setNodeEnv("development")

        const res = await request(app).post("/api/boom").send({})

        assert.strictEqual(res.status, 500)
        assert.match(res.body.message, /db:/)
        assert.deepStrictEqual(Object.keys(res.body), ["message"], "error bodies must expose only a message")
        assert.ok(!JSON.stringify(res.body).includes("errorHandler.js"), "no stack frames may leak")
    })

    test("production hides 5xx internals and generic 4xx details", async () => {
        setNodeEnv("production")

        const serverError = await request(app).post("/api/boom").send({})
        assert.strictEqual(serverError.status, 500)
        assert.deepStrictEqual(serverError.body, { message: "Internal server error" })
        assert.ok(!JSON.stringify(serverError.body).includes("mongodb"), "production must not leak internals")

        const forbidden = await request(app).get("/api/denied")
        assert.strictEqual(forbidden.status, 403)
        assert.deepStrictEqual(forbidden.body, { message: "Request failed" })

        const teapot = await request(app).get("/api/teapot")
        assert.strictEqual(teapot.status, 418)
        assert.deepStrictEqual(teapot.body, { message: "Request failed" })
    })

    test("malformed JSON is rejected with a safe, consistent error body", async () => {
        setNodeEnv("production")

        const res = await request(app)
            .post("/api/boom")
            .set("Content-Type", "application/json")
            .send('{"broken":')

        assert.strictEqual(res.status, 400)
        assert.deepStrictEqual(res.body, { message: "Request failed" })
        assert.match(res.headers["content-type"], /application\/json/)
    })

    test("the application registers the error handler last, after all routes", () => {
        const errorHandlerRegistrations = INDEX_SOURCE.match(/app\.use\(errorHandler\)/g) || []
        assert.strictEqual(errorHandlerRegistrations.length, 1, "the error handler must be mounted exactly once")
        assert.ok(INDEX_SOURCE.includes('from "./middlewares/errorHandler.js"'), "index.js must import the shared handler")

        const orderRouteIndex = INDEX_SOURCE.indexOf('app.use("/api/order"')
        const errorHandlerIndex = INDEX_SOURCE.indexOf("app.use(errorHandler)")
        assert.ok(orderRouteIndex > -1, "order routes must still be mounted")
        assert.ok(errorHandlerIndex > orderRouteIndex, "the error handler must be registered after the routes")
        assert.ok(!INDEX_SOURCE.includes("err.stack"), "the old inline handler must be gone")
    })
})
