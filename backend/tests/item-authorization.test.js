import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_item_authorization_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const OWNER_ONLY_MESSAGE = "Only shop owners can manage items"

let mongo
let app
let userSequence = 0

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-item-authorization", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const sendAs = (method, path, token, body) => {
    const csrf = csrfToken()
    const req = request(app)[method](path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
    return body === undefined ? req : req.send(body)
}

const makeUser = (role, label) => {
    userSequence += 1
    return User.create({
        fullName: `${label} ${role}`,
        email: `${label}${userSequence}${Date.now()}@t.com`,
        mobile: "9000000000",
        role
    })
}

const makeShop = async (owner, name) => {
    const shop = await Shop.create({ name, image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    return shop
}

const makeItem = async (shop, name, price = 100) => {
    const item = await Item.create({
        name,
        image: "i.png",
        shop: shop._id,
        category: "Snacks",
        price,
        foodType: "veg"
    })
    shop.items.push(item._id)
    await shop.save()
    return item
}

const ITEM_BODY = { name: "New Dish", category: "Snacks", foodType: "veg", price: 50 }

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

const seedItemWorld = async () => {
    const ownerA = await makeUser("owner", "owner-a")
    const ownerB = await makeUser("owner", "owner-b")
    const legacyCustomer = await makeUser("user", "legacy-customer")
    const legacyRider = await makeUser("deliveryBoy", "legacy-rider")
    const shoplessCustomer = await makeUser("user", "shopless-customer")

    const shopA = await makeShop(ownerA, "Shop A")
    const shopB = await makeShop(ownerB, "Shop B")
    const legacyCustomerShop = await makeShop(legacyCustomer, "Legacy Customer Shop")
    const legacyRiderShop = await makeShop(legacyRider, "Legacy Rider Shop")

    const itemA = await makeItem(shopA, "Item A")
    const itemB = await makeItem(shopB, "Item B")
    const legacyCustomerItem = await makeItem(legacyCustomerShop, "Legacy Customer Item")
    const legacyRiderItem = await makeItem(legacyRiderShop, "Legacy Rider Item")

    return {
        ownerA,
        ownerB,
        legacyCustomer,
        legacyRider,
        shoplessCustomer,
        shopA,
        shopB,
        legacyCustomerShop,
        legacyRiderShop,
        itemA,
        itemB,
        legacyCustomerItem,
        legacyRiderItem
    }
}

describe("item management authorization (Stage 6F)", () => {
    test("a non-owner account that owns a legacy shop cannot add items", async () => {
        const w = await seedItemWorld()
        const before = await Item.countDocuments({})

        const res = await sendAs("post", "/api/item/add-item", tokenFor(w.legacyCustomer._id), ITEM_BODY)

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, OWNER_ONLY_MESSAGE)
        assert.strictEqual(await Item.countDocuments({}), before, "no item may be created for a non-owner requester")
    })

    test("a non-owner account that owns a legacy shop cannot edit its items", async () => {
        const w = await seedItemWorld()

        const res = await sendAs("post", `/api/item/edit-item/${w.legacyCustomerItem._id}`, tokenFor(w.legacyCustomer._id), { price: 55 })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, OWNER_ONLY_MESSAGE)
        const stored = await Item.findById(w.legacyCustomerItem._id)
        assert.strictEqual(stored.price, 100, "the rejected edit must not change the item")
    })

    test("a non-owner account that owns a legacy shop cannot delete its items", async () => {
        const w = await seedItemWorld()

        const res = await sendAs("delete", `/api/item/delete/${w.legacyRiderItem._id}`, tokenFor(w.legacyRider._id))

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, OWNER_ONLY_MESSAGE)
        assert.ok(await Item.findById(w.legacyRiderItem._id), "the item must survive a rejected delete")
    })

    test("owners cannot edit or delete items belonging to another shop", async () => {
        const w = await seedItemWorld()

        const editRes = await sendAs("post", `/api/item/edit-item/${w.itemB._id}`, tokenFor(w.ownerA._id), { price: 1 })
        assert.strictEqual(editRes.status, 403)
        assert.strictEqual(editRes.body.message, "You do not have permission to edit this item")

        const deleteRes = await sendAs("delete", `/api/item/delete/${w.itemB._id}`, tokenFor(w.ownerA._id))
        assert.strictEqual(deleteRes.status, 403)
        assert.strictEqual(deleteRes.body.message, "You do not have permission to delete this item")

        const stored = await Item.findById(w.itemB._id)
        assert.ok(stored, "a cross-shop delete must not remove the item")
        assert.strictEqual(stored.price, 100, "a cross-shop edit must not change the item")
    })

    test("legitimate owners can still edit and delete their own items", async () => {
        const w = await seedItemWorld()

        const editRes = await sendAs("post", `/api/item/edit-item/${w.itemA._id}`, tokenFor(w.ownerA._id), { name: "Renamed Item", price: 75 })
        assert.strictEqual(editRes.status, 200)
        assert.strictEqual(editRes.body.name, "Renamed Item")
        assert.strictEqual(editRes.body.price, 75)

        const deleteRes = await sendAs("delete", `/api/item/delete/${w.itemA._id}`, tokenFor(w.ownerA._id))
        assert.strictEqual(deleteRes.status, 200)
        assert.strictEqual(await Item.findById(w.itemA._id), null)
        assert.ok(
            !deleteRes.body.items.some((item) => String(item._id) === String(w.itemA._id)),
            "the deleted item must be removed from the shop's item list"
        )
    })

    test("read-only item access is not restricted by role", async () => {
        const w = await seedItemWorld()

        const res = await sendAs("get", `/api/item/get-by-id/${w.itemA._id}`, tokenFor(w.legacyCustomer._id))

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.name, "Item A")
    })

    test("users without a shop keep the existing shop-not-found responses", async () => {
        const w = await seedItemWorld()

        const addRes = await sendAs("post", "/api/item/add-item", tokenFor(w.shoplessCustomer._id), ITEM_BODY)
        assert.strictEqual(addRes.status, 400)
        assert.strictEqual(addRes.body.message, "shop not found")

        const editRes = await sendAs("post", `/api/item/edit-item/${w.itemA._id}`, tokenFor(w.shoplessCustomer._id), { price: 10 })
        assert.strictEqual(editRes.status, 403)
        assert.strictEqual(editRes.body.message, "Shop not found or unauthorized")

        const deleteRes = await sendAs("delete", `/api/item/delete/${w.itemA._id}`, tokenFor(w.shoplessCustomer._id))
        assert.strictEqual(deleteRes.status, 403)
        assert.strictEqual(deleteRes.body.message, "Shop not found or unauthorized")
    })
})
