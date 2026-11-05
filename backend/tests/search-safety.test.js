import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_search_safety_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import itemRouter from "../routes/item.routes.js"
import shopRouter from "../routes/shop.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })

const getWithAuth = (token, url) =>
    request(app)
        .get(url)
        .set("Cookie", `token=${token}`)

const searchItems = (token, query, city) =>
    getWithAuth(token, "/api/item/search-items").query({ query, city })

const itemsByCity = (token, city) =>
    getWithAuth(token, `/api/item/get-by-city/${encodeURIComponent(city)}`)

const shopsByCity = (token, city) =>
    getWithAuth(token, `/api/shop/get-by-city/${encodeURIComponent(city)}`)

const itemById = (token, itemId) =>
    getWithAuth(token, `/api/item/get-by-id/${encodeURIComponent(itemId)}`)

const itemsByShop = (token, shopId) =>
    getWithAuth(token, `/api/item/get-by-shop/${encodeURIComponent(shopId)}`)

const myShop = (token) => getWithAuth(token, "/api/shop/get-my")

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/item", csrfMiddleware, itemRouter)
    app.use("/api/shop", csrfMiddleware, shopRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({})])
})

const seedSearchWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const user = await User.create({ fullName: "User One", email: `u${Date.now()}@t.com`, mobile: "9000000001", role: "user" })

    const shop = await Shop.create({
        name: "Pune Kitchen",
        city: "Pune",
        state: "MH",
        address: "12 pune street",
        image: "s.png",
        owner: owner._id,
        items: []
    })

    const pizza = await Item.create({ name: "Margherita Pizza", image: "i.png", shop: shop._id, category: "Pizza", price: 200, foodType: "veg" })
    const dosa = await Item.create({ name: "Masala Dosa", image: "i2.png", shop: shop._id, category: "South Indian", price: 120, foodType: "veg" })
    const plus = await Item.create({ name: "a+b Combo", image: "i3.png", shop: shop._id, category: "Others", price: 80, foodType: "non veg" })

    shop.items = [pizza._id, dosa._id, plus._id]
    await shop.save()

    return { owner, user, shop, items: [pizza, dosa, plus] }
}

describe("item search safety (Stage 6D)", () => {
    test("a normal query returns matching items with the populated shop summary", async () => {
        const w = await seedSearchWorld()

        const res = await searchItems(tokenFor(w.user._id), "pizza", "Pune")

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)
        assert.strictEqual(res.body[0].name, "Margherita Pizza")
        assert.strictEqual(res.body[0].shop.name, "Pune Kitchen")
    })

    test("substring matching and case-insensitivity are preserved", async () => {
        const w = await seedSearchWorld()

        const partial = await searchItems(tokenFor(w.user._id), "marg", "Pune")
        assert.strictEqual(partial.status, 200)
        assert.strictEqual(partial.body.length, 1)
        assert.strictEqual(partial.body[0].name, "Margherita Pizza")

        const upper = await searchItems(tokenFor(w.user._id), "MARGHERITA", "pune")
        assert.strictEqual(upper.status, 200)
        assert.strictEqual(upper.body.length, 1)

        const category = await searchItems(tokenFor(w.user._id), "south", "Pune")
        assert.strictEqual(category.status, 200)
        assert.strictEqual(category.body.length, 1)
        assert.strictEqual(category.body[0].category, "South Indian")
    })

    test("regex metacharacters are treated as literals and can no longer broaden the search", async () => {
        const w = await seedSearchWorld()

        for (const hostile of [".*", ".", "(", "[", "^Margherita", "a.b", "\\"]) {
            const res = await searchItems(tokenFor(w.user._id), hostile, "Pune")
            assert.strictEqual(res.status, 200, `${hostile} must not error`)
            assert.strictEqual(res.body.length, 0, `${hostile} must not match seeded items`)
        }
    })

    test("a literal plus in the query matches an item containing that literal", async () => {
        const w = await seedSearchWorld()

        const res = await searchItems(tokenFor(w.user._id), "a+b", "Pune")

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)
        assert.strictEqual(res.body[0].name, "a+b Combo")
    })

    test("oversized search input is rejected without scanning", async () => {
        const w = await seedSearchWorld()

        // Sizes stay below Node's request-line limit so the cap itself (100)
        // is what gets exercised; far larger requests are already clipped by
        // the HTTP/server layer before they reach the app.
        for (const oversized of ["x".repeat(101), "x".repeat(2000)]) {
            const res = await searchItems(tokenFor(w.user._id), oversized, "Pune")
            assert.strictEqual(res.status, 400, "oversized query must be rejected")
        }

        const oversizedCity = await searchItems(tokenFor(w.user._id), "pizza", "x".repeat(2000))
        assert.strictEqual(oversizedCity.status, 400, "oversized city must be rejected")
    })

    test("empty or missing search input responds with an empty array", async () => {
        const w = await seedSearchWorld()

        for (const [query, city] of [[undefined, "Pune"], ["", "Pune"], ["   ", "Pune"], ["pizza", undefined], ["pizza", ""], [undefined, undefined]]) {
            const res = await searchItems(tokenFor(w.user._id), query, city)
            assert.strictEqual(res.status, 200)
            assert.deepStrictEqual(res.body, [])
        }
    })

    test("an unknown city with a normal query returns an empty array", async () => {
        const w = await seedSearchWorld()

        const res = await searchItems(tokenFor(w.user._id), "pizza", "Mumbai")

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body, [])
    })

    test("unauthenticated search requests are rejected", async () => {
        const res = await request(app).get("/api/item/search-items").query({ query: "pizza", city: "Pune" })
        assert.strictEqual(res.status, 401)
    })
})

describe("city lookup safety (Stage 6D)", () => {
    test("item get-by-city returns matching items and preserves case-insensitivity", async () => {
        const w = await seedSearchWorld()

        const res = await itemsByCity(tokenFor(w.user._id), "Pune")
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 3)

        const mixed = await itemsByCity(tokenFor(w.user._id), "punE")
        assert.strictEqual(mixed.status, 200)
        assert.strictEqual(mixed.body.length, 3)

        const empty = await itemsByCity(tokenFor(w.user._id), "Mumbai")
        assert.strictEqual(empty.status, 200)
        assert.deepStrictEqual(empty.body, [])
    })

    test("item get-by-city treats metacharacter cities as literals instead of erroring", async () => {
        const w = await seedSearchWorld()

        for (const hostile of ["(", "[", ".*", "Pun(e"]) {
            const res = await itemsByCity(tokenFor(w.user._id), hostile)
            assert.strictEqual(res.status, 200, `${hostile} must not cause a 500`)
            assert.deepStrictEqual(res.body, [], `${hostile} must not match the seeded city`)
        }
    })

    test("item get-by-city rejects empty and oversized cities", async () => {
        const w = await seedSearchWorld()

        const blank = await itemsByCity(tokenFor(w.user._id), "   ")
        assert.strictEqual(blank.status, 400)
        assert.strictEqual(blank.body.message, "city is required")

        const oversized = await itemsByCity(tokenFor(w.user._id), "x".repeat(2000))
        assert.strictEqual(oversized.status, 400)
    })

    test("unavailable items are excluded from search, city, and shop listings", async () => {
        const w = await seedSearchWorld()
        await Item.findByIdAndUpdate(w.items[0]._id, { isAvailable: false })

        const search = await searchItems(tokenFor(w.user._id), "pizza", "Pune")
        assert.strictEqual(search.status, 200)
        assert.deepStrictEqual(search.body, [])

        const city = await itemsByCity(tokenFor(w.user._id), "Pune")
        assert.strictEqual(city.status, 200)
        assert.strictEqual(city.body.length, 2)
        assert.ok(city.body.every((item) => item.name !== "Margherita Pizza"))

        const shop = await itemsByShop(tokenFor(w.user._id), String(w.shop._id))
        assert.strictEqual(shop.status, 200)
        assert.strictEqual(shop.body.items.length, 2)
        assert.ok(shop.body.items.every((item) => item.name !== "Margherita Pizza"))

        const shops = await shopsByCity(tokenFor(w.user._id), "Pune")
        assert.strictEqual(shops.status, 200)
        assert.strictEqual(shops.body[0].items.length, 2)
    })

    test("shop get-by-city returns matching shops safely", async () => {
        const w = await seedSearchWorld()

        const res = await shopsByCity(tokenFor(w.user._id), "Pune")
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)
        assert.strictEqual(res.body[0].name, "Pune Kitchen")
        assert.ok(Array.isArray(res.body[0].items))

        const hostile = await shopsByCity(tokenFor(w.user._id), "[Prone")
        assert.strictEqual(hostile.status, 200)
        assert.deepStrictEqual(hostile.body, [])

        const oversized = await shopsByCity(tokenFor(w.user._id), "x".repeat(2000))
        assert.strictEqual(oversized.status, 400)

        const blank = await shopsByCity(tokenFor(w.user._id), "  ")
        assert.strictEqual(blank.status, 400)
        assert.strictEqual(blank.body.message, "city is required")
    })
})

describe("endpoint completion fixes (Stage 6D)", () => {
    test("get-my-shop responds even when the owner has no shop", async () => {
        const w = await seedSearchWorld()

        const res = await myShop(tokenFor(w.user._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body, null)
    })

    test("get-my-shop still returns the owned shop with items", async () => {
        const w = await seedSearchWorld()

        const res = await myShop(tokenFor(w.owner._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.name, "Pune Kitchen")
        assert.strictEqual(res.body.items.length, 3)
    })

    test("get-items-by-shop completes for valid, malformed, and unknown shop ids", async () => {
        const w = await seedSearchWorld()

        const valid = await itemsByShop(tokenFor(w.user._id), String(w.shop._id))
        assert.strictEqual(valid.status, 200)
        assert.strictEqual(valid.body.shop.name, "Pune Kitchen")
        assert.strictEqual(valid.body.items.length, 3)

        const malformed = await itemsByShop(tokenFor(w.user._id), "not-an-object-id")
        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(malformed.body.message, "Valid shop ID is required")

        const unknown = await itemsByShop(tokenFor(w.user._id), String(new mongoose.Types.ObjectId()))
        assert.strictEqual(unknown.status, 400)
        assert.strictEqual(unknown.body.message, "shop not found")
    })

    test("get-item-by-id completes for malformed and unknown ids", async () => {
        const w = await seedSearchWorld()

        const malformed = await itemById(tokenFor(w.user._id), "%%%bad")
        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(malformed.body.message, "Valid item ID is required")

        const unknown = await itemById(tokenFor(w.user._id), String(new mongoose.Types.ObjectId()))
        assert.strictEqual(unknown.status, 400)
        assert.strictEqual(unknown.body.message, "item not found")

        const valid = await itemById(tokenFor(w.user._id), String(w.items[0]._id))
        assert.strictEqual(valid.status, 200)
        assert.strictEqual(valid.body.name, "Margherita Pizza")
    })
})
