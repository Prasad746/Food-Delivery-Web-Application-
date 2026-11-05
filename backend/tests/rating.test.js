import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_rating_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-rating", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postRating = (token, itemId, rating) =>
    request(app)
        .post("/api/item/rating")
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send({ itemId, rating })

const postRatingRaw = (token, body) =>
    request(app)
        .post("/api/item/rating")
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init()])

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
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({})])
})

const seedRatingWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const shop = await Shop.create({ name: "Rating Shop", city: "Pune", state: "MH", address: "a", image: "s.png", owner: owner._id, items: [] })
    const item = await Item.create({ name: "Rated Dish", image: "i.png", shop: shop._id, category: "Others", price: 90, foodType: "veg" })
    return { owner, shop, item }
}

const newUser = async (label) =>
    User.create({ fullName: `Rater ${label}`, email: `r${label}${Date.now()}@t.com`, mobile: "9000000099", role: "user" })

const deliverItemTo = async (user, world, status = "delivered") => {
    await Order.create({
        user: user._id,
        payment: true,
        paymentMethod: "online",
        deliveryAddress: { text: "1 rating lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: world.item.price,
        shopOrders: [{
            shop: world.shop._id,
            owner: world.owner._id,
            status,
            subtotal: world.item.price,
            shopOrderItems: [{
                item: world.item._id,
                name: world.item.name,
                price: world.item.price,
                quantity: 1
            }]
        }]
    })
    return user
}

const newRatedUser = async (label, world) => {
    const user = await newUser(label)
    await deliverItemTo(user, world)
    return user
}

const newUnpaidCustomer = async (label) =>
    User.create({ fullName: `Unpaid ${label}`, email: `u${label}${Date.now()}@t.com`, mobile: "9000000097", role: "user" })

describe("rating validation (Stage 6D)", () => {
    test("a valid rating returns only the rating summary", async () => {
        const w = await seedRatingWorld()
        const user = await newRatedUser("valid", w)

        const res = await postRating(tokenFor(user._id), String(w.item._id), 3)

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(Object.keys(res.body), ["rating"])
        assert.strictEqual(res.body.rating.count, 1)
        assert.strictEqual(res.body.rating.average, 3)
    })

    test("non-numeric, non-finite, out-of-range and missing ratings are rejected", async () => {
        const w = await seedRatingWorld()
        const user = await newUser("invalid")

        for (const [label, body] of [
            ["numeric string", { itemId: String(w.item._id), rating: "4" }],
            ["boolean", { itemId: String(w.item._id), rating: true }],
            ["array", { itemId: String(w.item._id), rating: [4] }],
            ["object", { itemId: String(w.item._id), rating: { value: 4 } }],
            ["null (JSON NaN/Infinity paths land here too)", { itemId: String(w.item._id), rating: null }],
            ["below range", { itemId: String(w.item._id), rating: 0 }],
            ["above range", { itemId: String(w.item._id), rating: 6 }],
            ["negative", { itemId: String(w.item._id), rating: -1 }],
            ["missing rating", { itemId: String(w.item._id) }],
            ["nan-as-string", { itemId: String(w.item._id), rating: "NaN" }]
        ]) {
            const res = await postRatingRaw(tokenFor(user._id), body)
            assert.strictEqual(res.status, 400, `${label} must be rejected`)
            assert.strictEqual(res.body.message, "rating must be a number between 1 and 5", label)
        }

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, 0)
        assert.strictEqual(stored.rating.average, 0)
    })

    test("malformed or unknown item ids are rejected", async () => {
        const w = await seedRatingWorld()
        const user = await newUser("ids")

        for (const [label, itemId] of [
            ["missing", undefined],
            ["non-id string", "not-an-object-id"],
            ["numeric", 12345],
            ["empty string", ""]
        ]) {
            const res = await postRating(tokenFor(user._id), itemId, 4)
            assert.strictEqual(res.status, 400, `${label} must be rejected`)
            assert.strictEqual(res.body.message, "Valid item ID is required", label)
        }

        const unknown = await postRating(tokenFor(user._id), String(new mongoose.Types.ObjectId()), 4)
        assert.strictEqual(unknown.status, 400)
        assert.strictEqual(unknown.body.message, "item not found")

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, 0)
    })

    test("sequential ratings fold correctly into count and average", async () => {
        const w = await seedRatingWorld()
        const first = await newRatedUser("seq1", w)
        const second = await newRatedUser("seq2", w)

        const res1 = await postRating(tokenFor(first._id), String(w.item._id), 3)
        assert.strictEqual(res1.status, 200)

        const res2 = await postRating(tokenFor(second._id), String(w.item._id), 4)
        assert.strictEqual(res2.status, 200)
        assert.strictEqual(res2.body.rating.count, 2)
        assert.strictEqual(res2.body.rating.average, 3.5)
    })

    test("only customers may rate items", async () => {
        const w = await seedRatingWorld()
        const rider = await User.create({
            fullName: "Rider Rater",
            email: `rider${Date.now()}@t.com`,
            mobile: "9000000096",
            role: "deliveryBoy"
        })

        const res = await postRating(tokenFor(rider._id), String(w.item._id), 5)

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Only customers can rate items")
        assert.strictEqual((await Item.findById(w.item._id)).rating.count, 0)
    })

    test("a shop owner cannot rate an item from their own shop", async () => {
        const owner = await User.create({
            fullName: "Customer Owner",
            email: `self${Date.now()}@t.com`,
            mobile: "9000000095",
            role: "user"
        })
        const shop = await Shop.create({
            name: "Self Rating Shop",
            city: "Pune",
            state: "MH",
            address: "s",
            image: "s.png",
            owner: owner._id,
            items: []
        })
        const item = await Item.create({
            name: "Self Dish",
            image: "i.png",
            shop: shop._id,
            category: "Others",
            price: 80,
            foodType: "veg"
        })

        const res = await postRating(tokenFor(owner._id), String(item._id), 5)

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "You cannot rate an item from your own shop")
        assert.strictEqual((await Item.findById(item._id)).rating.count, 0)
    })

    test("a customer without a delivered purchase cannot rate the item", async () => {
        const w = await seedRatingWorld()
        const user = await newUser("no-purchase")

        const res = await postRating(tokenFor(user._id), String(w.item._id), 4)

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "You can only rate items from a delivered purchase")
        assert.strictEqual((await Item.findById(w.item._id)).rating.count, 0)
    })

    test("an undelivered purchase cannot be rated", async () => {
        const w = await seedRatingWorld()
        const user = await newUser("undelivered")
        await deliverItemTo(user, w, "out of delivery")

        const res = await postRating(tokenFor(user._id), String(w.item._id), 4)

        assert.strictEqual(res.status, 403)
        assert.strictEqual((await Item.findById(w.item._id)).rating.count, 0)
    })

    test("unauthenticated rating requests are rejected", async () => {
        const w = await seedRatingWorld()

        const res = await request(app)
            .post("/api/item/rating")
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
            .set("Origin", TRUSTED_ORIGIN)
            .send({ itemId: String(w.item._id), rating: 4 })

        assert.strictEqual(res.status, 401)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, 0)
    })
})

describe("rating concurrency and abuse controls (Stage 6D)", () => {
    test("concurrent ratings never lose an increment or corrupt the average", async () => {
        const w = await seedRatingWorld()
        const user = await newRatedUser("concurrent", w)

        const ratings = [...Array(15).fill(4), 5]
        const responses = await Promise.all(
            ratings.map((value) => postRating(tokenFor(user._id), String(w.item._id), value))
        )

        for (const res of responses) {
            assert.strictEqual(res.status, 200)
        }

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, 16)
        assert.ok(
            Math.abs(stored.rating.average - (15 * 4 + 5) / 16) < 1e-9,
            `average must equal ${(15 * 4 + 5) / 16}, got ${stored.rating.average}`
        )
    })

    test("a rating burst is rate limited per user", async () => {
        const w = await seedRatingWorld()
        const user = await newRatedUser("burst", w)
        const token = tokenFor(user._id)
        const limit = ORDER_RATE_LIMITS.rating.limit

        for (let i = 0; i < limit; i++) {
            const res = await postRating(token, String(w.item._id), 5)
            assert.strictEqual(res.status, 200, `request ${i + 1} within the limit must succeed`)
        }

        const blocked = await postRating(token, String(w.item._id), 5)
        assert.strictEqual(blocked.status, 429)
        assert.strictEqual(blocked.body.message, "Too many requests. Please try again later.")

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, limit)
    })

    test("a second user can rate after a rate-limited user", async () => {
        const w = await seedRatingWorld()
        const limited = await newRatedUser("limited", w)
        const other = await newRatedUser("other", w)

        for (let i = 0; i < ORDER_RATE_LIMITS.rating.limit + 1; i++) {
            await postRating(tokenFor(limited._id), String(w.item._id), 4)
        }

        const res = await postRating(tokenFor(other._id), String(w.item._id), 5)
        assert.strictEqual(res.status, 200)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.rating.count, ORDER_RATE_LIMITS.rating.limit + 1)
    })
})
