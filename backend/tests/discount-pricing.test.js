import "./helpers/isolated-upload-dir.js"
import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_discount_pricing_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { UPLOAD_DIR } from "../middlewares/multer.js"
import { setCloudinaryUploaderForTesting } from "../utils/cloudinary.js"
import { calculateItemPricing, validateDiscountConfig } from "../utils/pricing.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const STUB_IMAGE_URL = "https://res.cloudinary.example/stub-discount.png"
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])

let mongo
let app
let cloudinaryCalls = 0
let sequence = 0

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-discount-pricing", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postJson = (path, token, body) => {
    const csrf = csrfToken()
    const req = request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
    return body === undefined ? req : req.send(body)
}

const postMultipart = (path, token, fields, buffers = []) => {
    const csrf = csrfToken()
    const req = request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
    for (const [key, value] of Object.entries(fields)) {
        req.field(key, typeof value === "string" ? value : JSON.stringify(value))
    }
    for (const [field, buffer] of buffers) {
        req.attach(field, buffer, { filename: "dish.png", contentType: "image/png" })
    }
    return req
}

const uniqueSuffix = () => {
    sequence += 1
    return `${Date.now()}_${sequence}`
}

const seedWorld = async ({ price = 200, discount } = {}) => {
    const suffix = uniqueSuffix()
    const owner = await User.create({ fullName: "Owner One", email: `discount_owner_${suffix}@test.com`, mobile: "9100000001", role: "owner" })
    const ownerTwo = await User.create({ fullName: "Owner Two", email: `discount_owner2_${suffix}@test.com`, mobile: "9100000002", role: "owner" })
    const customer = await User.create({ fullName: "Customer", email: `discount_customer_${suffix}@test.com`, mobile: "9100000003", role: "user" })

    const shop = await Shop.create({ name: "Discount Shop", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const otherShop = await Shop.create({ name: "Other Shop", image: "s2.png", owner: ownerTwo._id, city: "Pune", state: "MH", address: "b", items: [] })

    const item = await Item.create({
        name: "Discount Dish",
        image: STUB_IMAGE_URL,
        shop: shop._id,
        category: "Main Course",
        price,
        foodType: "veg",
        ...(discount ? { discount } : {})
    })

    return { owner, ownerTwo, customer, shop, otherShop, item }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/item", csrfMiddleware, itemRouter)

    setCloudinaryUploaderForTesting(async () => {
        cloudinaryCalls += 1
        return { secure_url: STUB_IMAGE_URL }
    })
})

after(async () => {
    setCloudinaryUploaderForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({})])
    cloudinaryCalls = 0
})

describe("discount calculation rules", () => {
    test("no discount keeps the original price", () => {
        const pricing = calculateItemPricing({ price: 200 })
        assert.strictEqual(pricing.originalPrice, 200)
        assert.strictEqual(pricing.finalPrice, 200)
        assert.strictEqual(pricing.discountAmount, 0)
        assert.strictEqual(pricing.discountType, "")
        assert.strictEqual(pricing.discountApplied, false)
    })

    test("percentage discount calculates the expected final price", () => {
        const pricing = calculateItemPricing({
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        assert.strictEqual(pricing.discountAmount, 20)
        assert.strictEqual(pricing.finalPrice, 180)
        assert.strictEqual(pricing.discountType, "percentage")
        assert.strictEqual(pricing.discountValue, 10)
    })

    test("fixed amount discount calculates the expected final price", () => {
        const pricing = calculateItemPricing({
            price: 200,
            discount: { type: "fixed", value: 30, enabled: true }
        })
        assert.strictEqual(pricing.discountAmount, 30)
        assert.strictEqual(pricing.finalPrice, 170)
        assert.strictEqual(pricing.discountType, "fixed")
        assert.strictEqual(pricing.discountValue, 30)
    })

    test("rounding is paise-safe for percentages and fixed amounts", () => {
        const percentage = calculateItemPricing({
            price: 199.99,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        assert.strictEqual(percentage.discountAmount, 20)
        assert.strictEqual(percentage.finalPrice, 179.99)

        const recurring = calculateItemPricing({
            price: 100,
            discount: { type: "percentage", value: 33.33, enabled: true }
        })
        assert.strictEqual(recurring.discountAmount, 33.33)
        assert.strictEqual(recurring.finalPrice, 66.67)

        const fixed = calculateItemPricing({
            price: 99.99,
            discount: { type: "fixed", value: 0.01, enabled: true }
        })
        assert.strictEqual(fixed.discountAmount, 0.01)
        assert.strictEqual(fixed.finalPrice, 99.98)
    })

    test("a hundred percent discount reaches zero but never becomes negative", () => {
        const pricing = calculateItemPricing({
            price: 250,
            discount: { type: "percentage", value: 100, enabled: true }
        })
        assert.strictEqual(pricing.discountAmount, 250)
        assert.strictEqual(pricing.finalPrice, 0)
    })

    test("disabled discounts are ignored", () => {
        const pricing = calculateItemPricing({
            price: 200,
            discount: { type: "percentage", value: 10, enabled: false }
        })
        assert.strictEqual(pricing.finalPrice, 200)
        assert.strictEqual(pricing.discountApplied, false)
    })

    test("time-based discounts only apply inside the server-side window", () => {
        const discount = {
            type: "percentage",
            value: 10,
            enabled: true,
            startDate: "2026-01-10T10:00:00.000Z",
            endDate: "2026-01-10T12:00:00.000Z"
        }
        const at = (iso) => new Date(iso)

        assert.strictEqual(calculateItemPricing({ price: 200, discount }, at("2026-01-10T09:59:59.000Z")).finalPrice, 200)
        assert.strictEqual(calculateItemPricing({ price: 200, discount }, at("2026-01-10T10:00:00.000Z")).finalPrice, 180)
        assert.strictEqual(calculateItemPricing({ price: 200, discount }, at("2026-01-10T11:00:00.000Z")).finalPrice, 180)
        assert.strictEqual(calculateItemPricing({ price: 200, discount }, at("2026-01-10T12:00:00.000Z")).finalPrice, 180)
        assert.strictEqual(calculateItemPricing({ price: 200, discount }, at("2026-01-10T12:00:01.000Z")).finalPrice, 200)
    })

    test("invalid discount configurations are rejected by validation and never make prices negative", () => {
        const invalidDiscounts = [
            { type: "percentage", value: 0, enabled: true },
            { type: "percentage", value: -5, enabled: true },
            { type: "percentage", value: 100.01, enabled: true },
            { type: "fixed", value: 0, enabled: true },
            { type: "fixed", value: -10, enabled: true },
            { type: "fixed", value: 200.01, enabled: true },
            { type: "bogus", value: 10, enabled: true },
            { type: "fixed", value: 10, enabled: true, startDate: "2026-02-01T00:00:00.000Z", endDate: "2026-01-01T00:00:00.000Z" }
        ]

        for (const discount of invalidDiscounts) {
            assert.strictEqual(validateDiscountConfig(discount, 200).valid, false, JSON.stringify(discount))
            const pricing = calculateItemPricing({ price: 200, discount })
            assert.strictEqual(pricing.finalPrice, 200, JSON.stringify(discount))
            assert.ok(pricing.finalPrice >= 0)
        }
    })

    test("invalid dates are rejected", () => {
        assert.strictEqual(validateDiscountConfig({ type: "fixed", value: 10, startDate: "not-a-date" }, 200).valid, false)
        assert.strictEqual(validateDiscountConfig({ type: "fixed", value: 10, endDate: "not-a-date" }, 200).valid, false)
        assert.strictEqual(
            validateDiscountConfig({
                type: "fixed",
                value: 10,
                startDate: "2026-01-01T00:00:00.000Z",
                endDate: "2026-01-01T00:00:00.000Z"
            }, 200).valid,
            false
        )
    })
})

describe("item discount schema validation", () => {
    test("a valid discount is persisted with its full configuration", async () => {
        const w = await seedWorld({
            discount: {
                type: "percentage",
                value: 15,
                startDate: new Date("2026-01-01T00:00:00.000Z"),
                endDate: new Date("2026-12-31T23:59:59.000Z"),
                enabled: true
            }
        })

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.type, "percentage")
        assert.strictEqual(stored.discount.value, 15)
        assert.strictEqual(stored.discount.enabled, true)
        assert.strictEqual(stored.discount.startDate.toISOString(), "2026-01-01T00:00:00.000Z")
        assert.strictEqual(stored.discount.endDate.toISOString(), "2026-12-31T23:59:59.000Z")
        assert.strictEqual(stored.price, 200)
    })

    test("existing items without a discount keep working normally", async () => {
        const w = await seedWorld()
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.price, 200)
        assert.strictEqual(stored.discount, undefined)
        const pricing = calculateItemPricing(stored)
        assert.strictEqual(pricing.finalPrice, 200)
    })

    test("invalid discount data cannot be written directly to MongoDB", async () => {
        const suffix = uniqueSuffix()
        const owner = await User.create({ fullName: "Owner", email: `schema_owner_${suffix}@test.com`, mobile: "9100000010", role: "owner" })
        const shop = await Shop.create({ name: "Schema Shop", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
        const base = {
            name: "Schema Dish",
            image: STUB_IMAGE_URL,
            shop: shop._id,
            category: "Main Course",
            price: 200,
            foodType: "veg"
        }

        const invalidDiscounts = [
            { type: "percentage", value: 0 },
            { type: "percentage", value: 101 },
            { type: "percentage", value: -1 },
            { type: "fixed", value: 0 },
            { type: "fixed", value: 201 },
            { type: "fixed", value: -1 },
            { type: "unsupported", value: 10 },
            { type: "fixed", value: 10, startDate: new Date("2026-02-01"), endDate: new Date("2026-01-01") }
        ]

        for (const discount of invalidDiscounts) {
            await assert.rejects(
                () => Item.create({ ...base, discount }),
                (error) => error?.name === "ValidationError" || error?.name === "CastError",
                JSON.stringify(discount)
            )
        }

        await assert.rejects(
            () => Item.create({ ...base, discount: { type: "fixed", value: 10, startDate: "not-a-date" } }),
            (error) => error?.name === "ValidationError" || error?.name === "CastError"
        )
        assert.strictEqual(await Item.countDocuments({}), 0)
    })
})

describe("owner discount management through the item routes", () => {
    test("an owner can create an item with a discount through add-item", async () => {
        const w = await seedWorld()

        const res = await postMultipart("/api/item/add-item", tokenFor(w.owner._id), {
            name: "Promo Dish",
            category: "Snacks",
            foodType: "veg",
            price: "250",
            discount: {
                type: "percentage",
                value: 20,
                startDate: "2026-01-01T00:00:00.000Z",
                endDate: "2026-12-31T23:59:59.000Z",
                enabled: true
            }
        }, [["image", PNG_BYTES]])

        assert.strictEqual(res.status, 201)
        const created = await Item.findOne({ name: "Promo Dish" })
        assert.ok(created)
        assert.strictEqual(created.price, 250)
        assert.strictEqual(created.discount.type, "percentage")
        assert.strictEqual(created.discount.value, 20)
        assert.strictEqual(created.discount.enabled, true)
        assert.strictEqual(cloudinaryCalls, 1)
    })

    test("an owner can set, update, disable, re-enable and clear a discount", async () => {
        const w = await seedWorld()

        const setRes = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            discount: { type: "percentage", value: 10, enabled: true }
        })
        assert.strictEqual(setRes.status, 200)
        let stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.type, "percentage")
        assert.strictEqual(stored.discount.value, 10)
        assert.strictEqual(stored.discount.enabled, true)

        const updateRes = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            discount: { type: "fixed", value: 30 }
        })
        assert.strictEqual(updateRes.status, 200)
        stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.type, "fixed")
        assert.strictEqual(stored.discount.value, 30)

        const disableRes = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            discount: { enabled: false }
        })
        assert.strictEqual(disableRes.status, 200)
        stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.enabled, false)
        assert.strictEqual(stored.discount.type, "fixed")
        assert.strictEqual(stored.discount.value, 30)

        const enableRes = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            discount: { enabled: true }
        })
        assert.strictEqual(enableRes.status, 200)
        stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.enabled, true)

        const clearRes = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            discount: null
        })
        assert.strictEqual(clearRes.status, 200)
        stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount, null)
    })

    test("invalid create and update payloads are rejected without persisting discount data", async () => {
        const w = await seedWorld()

        const invalidUpdates = [
            { discount: { type: "percentage", value: 0 } },
            { discount: { type: "percentage", value: 101 } },
            { discount: { type: "fixed", value: 0 } },
            { discount: { type: "fixed", value: 200.01 } },
            { discount: { type: "fixed", value: 10, startDate: "bad-date" } },
            { discount: { type: "fixed", value: 10, startDate: "2026-02-01T00:00:00.000Z", endDate: "2026-01-01T00:00:00.000Z" } },
            { discount: {} },
            { discount: "not-json" },
            { discount: [] }
        ]

        for (const body of invalidUpdates) {
            const res = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), body)
            assert.strictEqual(res.status, 400, JSON.stringify(body))
            const stored = await Item.findById(w.item._id)
            assert.strictEqual(stored.discount, undefined, JSON.stringify(body))
        }

        const createRes = await postMultipart("/api/item/add-item", tokenFor(w.owner._id), {
            name: "Bad Promo",
            category: "Snacks",
            foodType: "veg",
            price: "100",
            discount: { type: "fixed", value: 101 }
        }, [["image", PNG_BYTES]])

        assert.strictEqual(createRes.status, 400)
        assert.strictEqual(await Item.findOne({ name: "Bad Promo" }), null)
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("a price update that would make a fixed discount exceed the price is rejected", async () => {
        const w = await seedWorld({ discount: { type: "fixed", value: 150, enabled: true } })

        const res = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            price: 100
        })

        assert.strictEqual(res.status, 400)
        assert.match(res.body.message, /must not exceed the item price/)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.price, 200)
        assert.strictEqual(stored.discount.value, 150)
    })

    test("another shop owner cannot change a discount", async () => {
        const w = await seedWorld({ discount: { type: "percentage", value: 10, enabled: true } })

        const res = await postJson(`/api/item/edit-item/${w.item._id}`, tokenFor(w.ownerTwo._id), {
            discount: { type: "percentage", value: 90, enabled: true }
        })

        assert.strictEqual(res.status, 403)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.value, 10)
    })

    test("unauthenticated discount changes are rejected", async () => {
        const w = await seedWorld({ discount: { type: "percentage", value: 10, enabled: true } })
        const csrf = csrfToken()

        const res = await request(app)
            .post(`/api/item/edit-item/${w.item._id}`)
            .set("Cookie", `XSRF-TOKEN=${csrf}`)
            .set("X-XSRF-TOKEN", csrf)
            .set("Origin", TRUSTED_ORIGIN)
            .send({ discount: { type: "percentage", value: 90 } })

        assert.strictEqual(res.status, 401)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.discount.value, 10)
    })
})
