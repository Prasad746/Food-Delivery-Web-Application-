import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_item_production_errors_secret"
process.env.ALLOWED_ORIGIN = "https://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "https://localhost:5173"
const INTERNAL_DETAIL = /validation failed|Path `|Mongoose|CastError|item\.model|backend[\\/]/i

let mongo
let app
let userSequence = 0

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-item-production-errors", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postItem = (token, body) => {
    const csrf = csrfToken()
    return request(app)
        .post("/api/item/add-item")
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)
}

const withNodeEnv = async (value, run) => {
    const previous = process.env.NODE_ENV
    if (value === undefined) {
        delete process.env.NODE_ENV
    } else {
        process.env.NODE_ENV = value
    }
    try {
        return await run()
    } finally {
        if (previous === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = previous
        }
    }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/item", csrfMiddleware, itemRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({})])
})

const seedOwnerWithShop = async () => {
    userSequence += 1
    const owner = await User.create({
        fullName: "Owner",
        email: `owner${userSequence}${Date.now()}@t.com`,
        mobile: "9000000000",
        role: "owner"
    })
    const shop = await Shop.create({
        name: "Owned Shop",
        image: "s.png",
        owner: owner._id,
        city: "Pune",
        state: "MH",
        address: "a",
        items: []
    })
    return { owner, shop }
}

const MISSING_IMAGE_BODY = { name: "No Image Dish", category: "Snacks", foodType: "veg", price: 40 }

describe("item production error sanitization (Stage 6F)", () => {
    test("a database validation failure returns a generic message in production", async () => {
        const w = await seedOwnerWithShop()

        const res = await withNodeEnv("production", () =>
            postItem(tokenFor(w.owner._id), MISSING_IMAGE_BODY)
        )

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "Invalid item data")
        assert.doesNotMatch(JSON.stringify(res.body), INTERNAL_DETAIL, "production responses must not expose schema or error internals")
        assert.strictEqual(await Item.countDocuments({}), 0)
    })

    test("local development still receives the detailed validation message", async () => {
        const w = await seedOwnerWithShop()

        const res = await withNodeEnv("development", () =>
            postItem(tokenFor(w.owner._id), MISSING_IMAGE_BODY)
        )

        assert.strictEqual(res.status, 400)
        assert.match(res.body.message, /image/i, "developers keep the actionable validation detail")
        assert.strictEqual(await Item.countDocuments({}), 0)
    })

    test("production keeps already-safe validation messages unchanged", async () => {
        const w = await seedOwnerWithShop()

        const res = await withNodeEnv("production", () =>
            postItem(tokenFor(w.owner._id), { name: "Bad Price", category: "Snacks", foodType: "veg", price: -5 })
        )

        assert.strictEqual(res.status, 400)
        assert.match(res.body.message, /greater than or equal to 0/i)
        assert.doesNotMatch(JSON.stringify(res.body), INTERNAL_DETAIL)
    })
})
