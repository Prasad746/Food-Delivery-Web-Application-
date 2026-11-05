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

process.env.JWT_SECRET = "test_item_validation_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { UPLOAD_DIR } from "../middlewares/multer.js"
import { setCloudinaryUploaderForTesting } from "../utils/cloudinary.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const STUB_IMAGE_URL = "https://res.cloudinary.example/stub-stage6c.png"
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])

let mongo
let app
let cloudinaryCalls

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-item-validation", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postJson = (path, token, body) =>
    request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const postMultipart = (path, token, fields, buffers = []) => {
    const req = request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
    for (const [key, value] of Object.entries(fields)) {
        req.field(key, typeof value === "string" ? value : JSON.stringify(value))
    }
    for (const [field, buffer] of buffers) {
        req.attach(field, buffer, { filename: "dish.png", contentType: "image/png" })
    }
    return req
}

const editVia = (token, itemId, body) => postJson(`/api/item/edit-item/${itemId}`, token, body)

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

const seedItemWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const owner2 = await User.create({ fullName: "Owner Two", email: `o2${Date.now()}@t.com`, mobile: "9000000002", role: "owner" })

    const shop = await Shop.create({ name: "Shop One", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shop2 = await Shop.create({ name: "Shop Two", image: "s2.png", owner: owner2._id, city: "Pune", state: "MH", address: "b", items: [] })
    const item = await Item.create({
        name: "Veggie Combo",
        image: STUB_IMAGE_URL,
        shop: shop._id,
        category: "Main Course",
        price: 199,
        foodType: "veg"
    })

    return { owner, owner2, shop, shop2, item }
}

describe("item edit validation (Stage 6C)", () => {
    test("negative prices are rejected as numbers and as their string form", async () => {
        const w = await seedItemWorld()

        for (const price of [-1, -5, -0.01, "-5", "-1"]) {
            const res = await editVia(tokenFor(w.owner._id), w.item._id, { price })
            assert.strictEqual(res.status, 400, `price ${JSON.stringify(price)} must be rejected`)
            const stored = await Item.findById(w.item._id)
            assert.strictEqual(stored.price, 199, `price ${JSON.stringify(price)} must not be persisted`)
        }
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("malformed price types are rejected", async () => {
        const w = await seedItemWorld()

        for (const [label, price] of [
            ["non-numeric string", "abc"],
            ["NaN string", "NaN"],
            ["null", null],
            ["boolean", true],
            ["object", { a: 1 }],
            ["array", [5]],
            ["empty string", ""]
        ]) {
            const res = await editVia(tokenFor(w.owner._id), w.item._id, { price })
            assert.strictEqual(res.status, 400, `price ${label} ${JSON.stringify(price)} must be rejected`)
            const stored = await Item.findById(w.item._id)
            assert.strictEqual(stored.price, 199, `price ${label} must not be persisted`)
        }
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("invalid categories and food types are rejected", async () => {
        const w = await seedItemWorld()

        for (const [key, value] of [
            ["category", "Soups"],
            ["category", ""],
            ["category", "snacks"],
            ["foodType", "unknown"],
            ["foodType", ""],
            ["foodType", "VEG"]
        ]) {
            const res = await editVia(tokenFor(w.owner._id), w.item._id, { [key]: value })
            assert.strictEqual(res.status, 400, `${key} ${JSON.stringify(value)} must be rejected`)
        }

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.category, "Main Course")
        assert.strictEqual(stored.foodType, "veg")
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("malformed name and other structural keys are rejected", async () => {
        const w = await seedItemWorld()

        for (const [label, body] of [
            ["numeric name", { name: 123 }],
            ["empty name", { name: "" }],
            ["whitespace name", { name: "   " }],
            ["null name", { name: null }],
            ["array name", { name: ["x"] }],
            ["schemless shop reassignment", { shop: String(w.shop2._id) }],
            ["rating injection", { rating: { average: 5, count: 99 } }]
        ]) {
            const res = await editVia(tokenFor(w.owner._id), w.item._id, body)
            assert.strictEqual(res.status, 400, `${label} must be rejected`)
        }

        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "Veggie Combo")
        assert.strictEqual(stored.rating.average, 0)
        assert.strictEqual(stored.rating.count, 0)
        assert.strictEqual(String(stored.shop), String(w.shop._id))
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("a fully valid update is applied", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner._id), w.item._id, {
            name: "Paneer Combo",
            category: "Burgers",
            foodType: "non veg",
            price: 249.5
        })

        assert.strictEqual(res.status, 200)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "Paneer Combo")
        assert.strictEqual(stored.category, "Burgers")
        assert.strictEqual(stored.foodType, "non veg")
        assert.strictEqual(stored.price, 249.5)
        assert.strictEqual(stored.image, STUB_IMAGE_URL, "the existing image must be preserved when no new upload is sent")
    })

    test("a partial update only touches the provided field and preserves untouched fields", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner._id), w.item._id, { price: 121 })

        assert.strictEqual(res.status, 200)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.price, 121)
        assert.strictEqual(stored.name, "Veggie Combo")
        assert.strictEqual(stored.category, "Main Course")
        assert.strictEqual(stored.foodType, "veg")
        assert.strictEqual(stored.image, STUB_IMAGE_URL)
    })

    test("a partial update of name and foodType alone works", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner._id), w.item._id, { name: "New Combo", foodType: "non veg" })

        assert.strictEqual(res.status, 200)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "New Combo")
        assert.strictEqual(stored.foodType, "non veg")
        assert.strictEqual(stored.category, "Main Course")
        assert.strictEqual(stored.price, 199)
    })

    test("an update that carries no valid field is refused", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner._id), w.item._id, {})

        assert.strictEqual(res.status, 400)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "Veggie Combo")
    })

    test("multipart updates keep the numeric-string contract of the owner UI", async () => {
        const w = await seedItemWorld()

        const res = await postMultipart(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            name: "Dosa Combo",
            category: "South Indian",
            foodType: "veg",
            price: "145"
        })

        assert.strictEqual(res.status, 200)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "Dosa Combo")
        assert.strictEqual(stored.category, "South Indian")
        assert.strictEqual(stored.price, 145, "the numeric-string price from FormData must still be stored as a number")
        assert.strictEqual(stored.image, STUB_IMAGE_URL, "no new upload means the old image stays")
    })

    test("a multipart update with an attached image replaces the image field", async () => {
        const w = await seedItemWorld()

        const res = await postMultipart(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            name: "Dosa Combo",
            category: "South Indian",
            foodType: "veg",
            price: "145"
        }, [["image", PNG_BYTES]])

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.image, STUB_IMAGE_URL)
        assert.strictEqual(cloudinaryCalls, 1)
    })

    test("a multipart update that pairs a new image with an invalid price is rejected before upload", async () => {
        const w = await seedItemWorld()

        const res = await postMultipart(`/api/item/edit-item/${w.item._id}`, tokenFor(w.owner._id), {
            name: "Dosa Combo",
            category: "South Indian",
            foodType: "veg",
            price: "-5"
        }, [["image", PNG_BYTES]])

        assert.strictEqual(res.status, 400)
        assert.strictEqual(cloudinaryCalls, 0, "the image must not be uploaded for an invalid payload")
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.price, 199)
        assert.strictEqual(stored.name, "Veggie Combo")
    })

    test("ownership is still enforced for validation-passing updates", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner2._id), w.item._id, {
            name: "Hijacked",
            category: "Burgers",
            foodType: "non veg",
            price: 10
        })

        assert.strictEqual(res.status, 403)
        const stored = await Item.findById(w.item._id)
        assert.strictEqual(stored.name, "Veggie Combo")
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("a malformed item id is refused before any update", async () => {
        const w = await seedItemWorld()

        const res = await editVia(tokenFor(w.owner._id), "not-an-oid", { price: 100 })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "Valid item ID is required")
        assert.strictEqual(await Item.countDocuments({}), 1)
    })
})

describe("item creation validation (Stage 6C)", () => {
    test("negative, malformed and invalid fields are refused without creating the item", async () => {
        const w = await seedItemWorld()

        for (const body of [
            { name: "Cheap", category: "Snacks", foodType: "veg", price: -1 },
            { name: "Cheap", category: "Snacks", foodType: "veg", price: "-9" },
            { name: "Cheap", category: "Snacks", foodType: "veg", price: "abc" },
            { name: "Cheap", category: "Soups", foodType: "veg", price: 50 },
            { name: "Cheap", category: "Snacks", foodType: "unknown", price: 50 },
            { name: "", category: "Snacks", foodType: "veg", price: 50 },
            { name: "Cheap", category: "Snacks", foodType: "veg", price: 50, rating: { count: 9, average: 9 } }
        ]) {
            const res = await postMultipart("/api/item/add-item", tokenFor(w.owner._id), body)
            assert.strictEqual(res.status, 400, `payload ${JSON.stringify(body)} must be rejected`)
        }

        assert.strictEqual(await Item.countDocuments({}), 1)
        assert.strictEqual(cloudinaryCalls, 0)
    })

    test("a valid multipart creation stores the item with the converted numeric price", async () => {
        const w = await seedItemWorld()

        const res = await postMultipart("/api/item/add-item", tokenFor(w.owner._id), {
            name: "Idli Plate",
            category: "South Indian",
            foodType: "veg",
            price: "80"
        }, [["image", PNG_BYTES]])

        assert.strictEqual(res.status, 201)
        const created = await Item.findOne({ name: "Idli Plate" })
        assert.ok(created)
        assert.strictEqual(created.price, 80)
        assert.strictEqual(created.image, STUB_IMAGE_URL)
        assert.strictEqual(String(created.shop), String(w.shop._id))
        assert.strictEqual(cloudinaryCalls, 1)
    })

    test("creation without an image is refused as invalid input, not a 500", async () => {
        const w = await seedItemWorld()

        const res = await postMultipart("/api/item/add-item", tokenFor(w.owner._id), {
            name: "No Image",
            category: "Snacks",
            foodType: "veg",
            price: "40"
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(await Item.countDocuments({}), 1)
    })
})
