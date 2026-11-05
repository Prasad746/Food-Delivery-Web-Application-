import "./helpers/isolated-upload-dir.js"
import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"
import express from "express"
import cookieParser from "cookie-parser"

process.env.JWT_SECRET = "test_upload_security_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { UPLOAD_DIR, MAX_UPLOAD_FILE_SIZE, cleanupUnprocessedUpload } from "../middlewares/multer.js"
import uploadOnCloudinary, {
    setCloudinaryUploaderForTesting,
    setCloudinaryDeleterForTesting,
    cloudinaryPublicIdFromUrl
} from "../utils/cloudinary.js"
import itemRouter from "../routes/item.routes.js"
import shopRouter from "../routes/shop.routes.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const STUB_IMAGE_URL = "https://res.cloudinary.example/stub-image.png"

let mongo
let app
let cloudinaryCalls = 0
let deletedAssets = []

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-upload", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const attachUploads = (req, path, token, csrf, buffers, fields = {}) => {
    req.set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
    req.set("X-XSRF-TOKEN", csrf)
    req.set("Origin", TRUSTED_ORIGIN)
    for (const [key, value] of Object.entries(fields)) {
        req.field(key, value)
    }
    for (const [field, buffer, filename, mimetype] of buffers) {
        req.attach(field, buffer, { filename, contentType: mimetype })
    }
    return req
}

const ITEM_FIELDS = { name: "Masala Dosa", category: "South Indian", foodType: "veg", price: "120" }
const SHOP_FIELDS = { name: "New Shop", city: "Pune", state: "MH", address: "some street" }

const uploadAddItem = (token, csrf, buffers, fields = ITEM_FIELDS) =>
    attachUploads(request(app).post("/api/item/add-item"), "/api/item/add-item", token, csrf, buffers, fields)

const uploadAddShopItem = (token, csrf, buffers, fields = SHOP_FIELDS) =>
    attachUploads(request(app).post("/api/shop/create-edit"), "/api/shop/create-edit", token, csrf, buffers, fields)

const uploadEditItem = (itemId, token, csrf, buffers, fields = ITEM_FIELDS) =>
    attachUploads(request(app).post(`/api/item/edit-item/${itemId}`), `/api/item/edit-item/${itemId}`, token, csrf, buffers, fields)

const listUploadDir = () => (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [])

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/item", csrfMiddleware, itemRouter)
    app.use("/api/shop", csrfMiddleware, shopRouter)

    setCloudinaryUploaderForTesting(async () => {
        cloudinaryCalls += 1
        return { secure_url: STUB_IMAGE_URL }
    })
    setCloudinaryDeleterForTesting(async (url) => {
        deletedAssets.push(url)
    })
})

after(async () => {
    setCloudinaryUploaderForTesting(null)
    setCloudinaryDeleterForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({})])
    for (const name of listUploadDir()) {
        fs.unlinkSync(path.join(UPLOAD_DIR, name))
    }
    cloudinaryCalls = 0
    deletedAssets = []
})

const seedImageWorld = async () => {
    const owner = await User.create({ fullName: "Shop Owner", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const customer = await User.create({ fullName: "Plain Customer", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
    const shop = await Shop.create({ name: "Owned Shop", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    return { owner, customer, shop }
}

const seedUploadAuthorizationWorld = async () => {
    const w = await seedImageWorld()
    const nonOwner = await User.create({ fullName: "Legacy Non Owner", email: `n${Date.now()}@t.com`, mobile: "9000000002", role: "user" })
    const nonOwnerShop = await Shop.create({ name: "Legacy Shop", image: "l.png", owner: nonOwner._id, city: "Pune", state: "MH", address: "b", items: [] })
    const nonOwnerItem = await Item.create({
        name: "Legacy Dish", image: "legacy.png", shop: nonOwnerShop._id, category: "Snacks", price: 90, foodType: "veg"
    })
    nonOwnerShop.items.push(nonOwnerItem._id)
    await nonOwnerShop.save()

    const ownedItem = await Item.create({
        name: "Owned Dish", image: "owned.png", shop: w.shop._id, category: "Snacks", price: 90, foodType: "veg"
    })
    w.shop.items.push(ownedItem._id)
    await w.shop.save()

    const otherOwner = await User.create({ fullName: "Other Owner", email: `x${Date.now()}@t.com`, mobile: "9000000003", role: "owner" })
    const otherShop = await Shop.create({ name: "Other Shop", image: "other.png", owner: otherOwner._id, city: "Pune", state: "MH", address: "c", items: [] })

    return { ...w, nonOwner, nonOwnerShop, nonOwnerItem, ownedItem, otherOwner, otherShop }
}

describe("image upload security (Stage 5A)", () => {
    test("a valid image upload by a shop owner succeeds and leaves no temporary file behind", async () => {
        const w = await seedImageWorld()
        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "dish.png", "image/png"]
        ])

        assert.strictEqual(res.status, 201)
        assert.ok(res.body.items?.[0]?.image === STUB_IMAGE_URL)
        assert.deepStrictEqual(listUploadDir(), [], "consumed upload must be removed after the controller completes")
    })

    test("a Windows traversal-style filename cannot escape the upload directory", async () => {
        const w = await seedImageWorld()
        const maliciousNames = ["..\\..\\evil.js", "..\\..\\..\\evil-two.js", "sub\\..\\..\\evil-three.png"]

        for (const originalname of maliciousNames) {
            const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
                ["image", PNG_BYTES, originalname, "image/png"]
            ])
            assert.strictEqual(res.status, 201, `upload with name ${originalname} must still be a normal image flow`)
        }

        assert.deepStrictEqual(listUploadDir(), [], "no traversal artifact may remain in the upload directory")
        assert.ok(!fs.existsSync(path.join(process.cwd(), "public", "evil.js")))
        assert.ok(!fs.existsSync(path.join(process.cwd(), "public", "evil-two.js")))
        assert.ok(!fs.existsSync(path.join(process.cwd(), "public", "evil-three.png")))
        assert.ok(!fs.existsSync(path.join(process.cwd(), "evil.js")))
        assert.ok(!fs.existsSync(path.join(process.cwd(), "..", "evil.js")))
    })

    test("a POSIX traversal-style filename cannot escape the upload directory", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "../../../evil-posix.js", "image/png"]
        ])

        assert.strictEqual(res.status, 201)
        assert.deepStrictEqual(listUploadDir(), [])
        assert.ok(!fs.existsSync(path.join(process.cwd(), "evil-posix.js")))
        assert.ok(!fs.existsSync(path.join(process.cwd(), "public", "evil-posix.js")))
    })

    test("non-image content types are rejected and no file is persisted", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", Buffer.from("plain text, not an image"), "changes.txt", "text/plain"]
        ])

        assert.strictEqual(res.status, 415)
        assert.strictEqual(res.body.message, "Only JPEG, PNG, WEBP or GIF images are allowed.")
        assert.deepStrictEqual(listUploadDir(), [])
        assert.ok(!fs.existsSync(path.join(process.cwd(), "changes.txt")))
    })

    test("a text payload disguised as image/png is rejected by content inspection", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", Buffer.from(`<html>${"A".repeat(100)}</html>`), "payload.png", "image/png"]
        ])

        assert.strictEqual(res.status, 415)
        assert.strictEqual(res.body.message, "Only JPEG, PNG, WEBP or GIF images are allowed.")
        assert.deepStrictEqual(listUploadDir(), [])
    })

    test("oversized uploads are rejected with a safe 413 and no partial file remains", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", Buffer.alloc(MAX_UPLOAD_FILE_SIZE + 1000, 0x50), "huge.png", "image/png"]
        ])

        assert.strictEqual(res.status, 413)
        assert.strictEqual(res.body.message, "Uploaded file is too large. Maximum size is 5 MB.")
        assert.deepStrictEqual(listUploadDir(), [])
    })

    test("unauthenticated upload requests write nothing to disk", async () => {
        const target = await request(app)
            .post("/api/item/add-item")
            .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .attach("image", PNG_BYTES, { filename: "anon.png", contentType: "image/png" })

        assert.strictEqual(target.status, 401)
        assert.strictEqual(target.body.message, "Authentication token required")
        assert.deepStrictEqual(listUploadDir(), [])
        assert.ok(!fs.existsSync(path.join(process.cwd(), "anon.png")))
    })

    test("an authenticated user without a shop triggers cleanup, leaving no persistent upload", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddItem(tokenFor(w.customer._id), csrfToken(), [
            ["image", PNG_BYTES, "customer.png", "image/png"]
        ])

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "shop not found")
        assert.deepStrictEqual(listUploadDir(), [])
        assert.strictEqual(cloudinaryCalls, 0, "a rejected request must not reach Cloudinary")
    })

    test("shop creation still accepts legitimate image uploads", async () => {
        await seedImageWorld()
        const shoplessOwner = await User.create({
            fullName: "Shopless Owner",
            email: `so${Date.now()}@t.com`,
            mobile: "9000000009",
            role: "owner"
        })

        const res = await uploadAddShopItem(tokenFor(shoplessOwner._id), csrfToken(), [
            ["image", PNG_BYTES, "shop.png", "image/png"]
        ])

        assert.strictEqual(res.status, 201)
        assert.ok(res.body.image === STUB_IMAGE_URL, "the legitimate image URL must be recorded on the shop")
        assert.strictEqual(String(res.body.owner._id), String(shoplessOwner._id), "the shop must belong to the creator")
        assert.strictEqual(await Shop.countDocuments({ owner: shoplessOwner._id }), 1)
        assert.deepStrictEqual(listUploadDir(), [])
    })

    test("a non-owner shop upload is rejected, cleaned up, and never reaches Cloudinary", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddShopItem(tokenFor(w.customer._id), csrfToken(), [
            ["image", PNG_BYTES, "customer-shop.png", "image/png"]
        ])

        assert.strictEqual(res.status, 403)
        assert.match(res.body.message, /owners/i)
        assert.deepStrictEqual(listUploadDir(), [], "the temporary upload must be cleaned up")
        assert.strictEqual(cloudinaryCalls, 0, "no upload processing may happen for a rejected role")
        assert.strictEqual(await Shop.countDocuments({}), 1, "the rejected request must not create a shop")
    })

    test("an unexpected failure after accepting an upload leaves no temporary file", async () => {
        const w = await seedImageWorld()
        const shopCountBefore = await Shop.countDocuments({})
        const originalFindOne = Shop.findOne
        Shop.findOne = () => {
            throw new Error("forced shop lookup failure")
        }

        let res
        try {
            res = await uploadAddShopItem(tokenFor(w.owner._id), csrfToken(), [
                ["image", PNG_BYTES, "unexpected.png", "image/png"]
            ])
        } finally {
            Shop.findOne = originalFindOne
        }

        assert.strictEqual(res.status, 500)
        assert.strictEqual(res.body.message, "Failed to create shop. Please try again.")
        assert.deepStrictEqual(listUploadDir(), [], "the accepted upload must be removed when the controller fails unexpectedly")
        assert.strictEqual(cloudinaryCalls, 1, "the accepted image was processed before the forced failure")
        assert.strictEqual(await Shop.countDocuments({}), shopCountBefore, "the failed request must not create a shop")
    })

    test("cleanup never deletes files outside the upload directory", async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vingo-upload-cleanup-"))
        const externalPath = path.join(outsideDir, "keep-me.png")
        const traversalPath = path.join(UPLOAD_DIR, "..", "keep-me-too.png")

        try {
            fs.writeFileSync(externalPath, PNG_BYTES)
            fs.writeFileSync(traversalPath, PNG_BYTES)

            await cleanupUnprocessedUpload({ file: { path: externalPath } })
            await cleanupUnprocessedUpload({ file: { path: traversalPath } })

            assert.ok(fs.existsSync(externalPath), "a file outside UPLOAD_DIR must never be deleted")
            assert.ok(fs.existsSync(traversalPath), "a traversal path escaping UPLOAD_DIR must never be deleted")
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true })
            fs.rmSync(traversalPath, { force: true })
        }
    })

    test("the Cloudinary upload helper only removes temporary files inside the upload directory", async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vingo-cloudinary-cleanup-"))
        const externalPath = path.join(outsideDir, "keep-me.png")

        try {
            fs.writeFileSync(externalPath, PNG_BYTES)
            const url = await uploadOnCloudinary(externalPath)

            assert.strictEqual(url, STUB_IMAGE_URL)
            assert.strictEqual(cloudinaryCalls, 1)
            assert.ok(fs.existsSync(externalPath), "the Cloudinary helper must not unlink arbitrary paths")
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true })
        }
    })
})

describe("item upload authorization (Stage 6G)", () => {
    test("a non-owner cannot create an item with an image and never reaches Cloudinary", async () => {
        const w = await seedUploadAuthorizationWorld()
        const itemCountBefore = await Item.countDocuments({})

        const res = await uploadAddItem(tokenFor(w.nonOwner._id), csrfToken(), [
            ["image", PNG_BYTES, "non-owner.png", "image/png"]
        ])

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Only shop owners can manage items")
        assert.strictEqual(cloudinaryCalls, 0, "the rejected image must never be uploaded to Cloudinary")
        assert.deepStrictEqual(listUploadDir(), [], "the temporary upload must be cleaned up")
        assert.strictEqual(await Item.countDocuments({}), itemCountBefore, "the rejected request must not create an item")
    })

    test("a non-owner cannot edit an item with an image and never reaches Cloudinary", async () => {
        const w = await seedUploadAuthorizationWorld()

        const res = await uploadEditItem(w.nonOwnerItem._id, tokenFor(w.nonOwner._id), csrfToken(), [
            ["image", PNG_BYTES, "non-owner-edit.png", "image/png"]
        ], { price: "95" })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Only shop owners can manage items")
        assert.strictEqual(cloudinaryCalls, 0, "the rejected image must never be uploaded to Cloudinary")
        assert.deepStrictEqual(listUploadDir(), [], "the temporary upload must be cleaned up")

        const stored = await Item.findById(w.nonOwnerItem._id)
        assert.strictEqual(stored.price, 90)
        assert.strictEqual(stored.image, "legacy.png")
    })

    test("a legitimate owner can create an item with an image", async () => {
        const w = await seedUploadAuthorizationWorld()

        const res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "owner-create.png", "image/png"]
        ])

        assert.strictEqual(res.status, 201)
        assert.strictEqual(cloudinaryCalls, 1)
        assert.deepStrictEqual(listUploadDir(), [])
        const created = await Item.findOne({ name: ITEM_FIELDS.name })
        assert.ok(created, "the owner-created item must exist")
        assert.strictEqual(created.image, STUB_IMAGE_URL)
        assert.strictEqual(String(created.shop), String(w.shop._id))
    })

    test("a legitimate owner can edit an item with an image", async () => {
        const w = await seedUploadAuthorizationWorld()

        const res = await uploadEditItem(w.ownedItem._id, tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "owner-edit.png", "image/png"]
        ], { name: "Owned Dish Updated", price: "123" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(cloudinaryCalls, 1)
        assert.deepStrictEqual(listUploadDir(), [])
        assert.strictEqual(res.body.image, STUB_IMAGE_URL)

        const stored = await Item.findById(w.ownedItem._id)
        assert.strictEqual(stored.name, "Owned Dish Updated")
        assert.strictEqual(stored.price, 123)
        assert.strictEqual(stored.image, STUB_IMAGE_URL)
    })

    test("a cross-shop edit with an image is rejected before Cloudinary", async () => {
        const w = await seedUploadAuthorizationWorld()

        const res = await uploadEditItem(w.ownedItem._id, tokenFor(w.otherOwner._id), csrfToken(), [
            ["image", PNG_BYTES, "cross-shop.png", "image/png"]
        ], { price: "1" })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "You do not have permission to edit this item")
        assert.strictEqual(cloudinaryCalls, 0, "a cross-shop edit must never upload the image")
        assert.deepStrictEqual(listUploadDir(), [], "the temporary upload must be cleaned up")

        const stored = await Item.findById(w.ownedItem._id)
        assert.strictEqual(stored.price, 90)
        assert.strictEqual(stored.image, "owned.png")
    })

    test("a database failure after upload removes the new asset and leaves no orphan item", async () => {
        const w = await seedImageWorld()
        const originalCreate = Item.create
        Item.create = async () => {
            throw new Error("forced database failure")
        }

        let res
        try {
            res = await uploadAddItem(tokenFor(w.owner._id), csrfToken(), [
                ["image", PNG_BYTES, "rollback.png", "image/png"]
            ])
        } finally {
            Item.create = originalCreate
        }

        assert.strictEqual(res.status, 500)
        assert.strictEqual(cloudinaryCalls, 1)
        assert.deepStrictEqual(deletedAssets, [STUB_IMAGE_URL], "the uploaded asset must be rolled back")
        assert.deepStrictEqual(listUploadDir(), [])
        assert.strictEqual(await Item.countDocuments({ name: ITEM_FIELDS.name }), 0)
    })

    test("replacing an item image deletes the previous asset only after the database commit", async () => {
        const w = await seedUploadAuthorizationWorld()

        const res = await uploadEditItem(w.ownedItem._id, tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "replacement.png", "image/png"]
        ], { name: "Replaced Dish" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(cloudinaryCalls, 1)
        assert.deepStrictEqual(deletedAssets, ["owned.png"])
        assert.strictEqual((await Item.findById(w.ownedItem._id)).image, STUB_IMAGE_URL)
    })

    test("an image still referenced by another item is never deleted during replacement", async () => {
        const w = await seedUploadAuthorizationWorld()
        await Item.create({
            name: "Shared Image Dish",
            image: "owned.png",
            shop: w.shop._id,
            category: "Snacks",
            price: 70,
            foodType: "veg"
        })

        const res = await uploadEditItem(w.ownedItem._id, tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "replacement-shared.png", "image/png"]
        ], { name: "Shared Replaced Dish" })

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(deletedAssets, [], "a shared image must stay available for other references")
    })

    test("replacing a shop image deletes the old unreferenced asset", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddShopItem(tokenFor(w.owner._id), csrfToken(), [
            ["image", PNG_BYTES, "shop-replacement.png", "image/png"]
        ])

        assert.strictEqual(res.status, 201)
        assert.strictEqual(cloudinaryCalls, 1)
        assert.deepStrictEqual(deletedAssets, ["s.png"])
    })

    test("a shop edit without a new image keeps the current image", async () => {
        const w = await seedImageWorld()

        const res = await uploadAddShopItem(tokenFor(w.owner._id), csrfToken(), [])

        assert.strictEqual(res.status, 201)
        assert.strictEqual(cloudinaryCalls, 0)
        assert.deepStrictEqual(deletedAssets, [])
        assert.strictEqual(res.body.image, "s.png")
    })

    test("Cloudinary public ids are parsed only from trusted upload URLs", async () => {
        const previousCloudName = process.env.CLOUDINARY_CLOUD_NAME
        process.env.CLOUDINARY_CLOUD_NAME = "demo"
        try {
            assert.strictEqual(
                cloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/v1234/vingo/items/dish.jpg"),
                "vingo/items/dish"
            )
            assert.strictEqual(
                cloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/vingo/items/dish.webp"),
                "vingo/items/dish"
            )
            assert.strictEqual(cloudinaryPublicIdFromUrl("https://example.com/demo/image/upload/v1/x.jpg"), null)
            assert.strictEqual(cloudinaryPublicIdFromUrl("https://res.cloudinary.com/other/image/upload/v1/x.jpg"), null)
            assert.strictEqual(cloudinaryPublicIdFromUrl("not a url"), null)
        } finally {
            if (previousCloudName === undefined) {
                delete process.env.CLOUDINARY_CLOUD_NAME
            } else {
                process.env.CLOUDINARY_CLOUD_NAME = previousCloudName
            }
        }
    })
})
