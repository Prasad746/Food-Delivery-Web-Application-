import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"
import express from "express"
import cookieParser from "cookie-parser"

process.env.JWT_SECRET = "test_shop_authorization_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import shopRouter from "../routes/shop.routes.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-shop-auth", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const attachAuth = (req, token, csrf) => {
    req.set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
    req.set("X-XSRF-TOKEN", csrf)
    req.set("Origin", TRUSTED_ORIGIN)
    return req
}

const postShopJson = (token, fields) =>
    attachAuth(request(app).post("/api/shop/create-edit"), token, csrfToken()).send(fields)

const getMyShop = (token) =>
    request(app).get("/api/shop/get-my").set("Cookie", `token=${token}`)

let seq = 0
const seedUser = (role) => {
    seq += 1
    return User.create({
        fullName: `${role} ${seq}`,
        email: `${role}${seq}@shopauth.test`,
        mobile: `91000000${String(seq).padStart(2, "0")}`,
        role
    })
}

const SHOP_FIELDS = { name: "Auth Shop", city: "Pune", state: "MH", address: "1 auth street" }

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/shop", csrfMiddleware, shopRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({})])
})

describe("shop creation and editing authorization (Stage 6E)", () => {
    test("regular customers and delivery partners cannot create a shop", async () => {
        const customer = await seedUser("user")
        const rider = await seedUser("deliveryBoy")

        const customerRes = await postShopJson(tokenFor(customer._id), SHOP_FIELDS)
        const riderRes = await postShopJson(tokenFor(rider._id), { ...SHOP_FIELDS, name: "Rider Shop" })

        assert.strictEqual(customerRes.status, 403)
        assert.strictEqual(riderRes.status, 403)
        assert.match(customerRes.body.message, /owners/i)
        assert.strictEqual(await Shop.countDocuments({}), 0, "rejected roles must not create shops")
    })

    test("an owner can only update the shop they own", async () => {
        const ownerOne = await seedUser("owner")
        const ownerTwo = await seedUser("owner")
        const shopOne = await Shop.create({ ...SHOP_FIELDS, image: "one.png", owner: ownerOne._id })
        const shopTwo = await Shop.create({ ...SHOP_FIELDS, name: "Second Shop", image: "two.png", owner: ownerTwo._id })

        const edited = await postShopJson(tokenFor(ownerOne._id), { ...SHOP_FIELDS, name: "Renamed Shop" })

        assert.strictEqual(edited.status, 201)
        assert.strictEqual(String(edited.body._id), String(shopOne._id), "the caller's own shop must be updated")
        assert.strictEqual(edited.body.name, "Renamed Shop")
        assert.strictEqual(edited.body.image, "one.png", "editing without a new upload must keep the existing image")

        const own = await getMyShop(tokenFor(ownerOne._id))
        assert.strictEqual(own.status, 200)
        assert.strictEqual(own.body.name, "Renamed Shop")

        const other = await Shop.findById(shopTwo._id)
        assert.strictEqual(other.name, "Second Shop", "the other owner's shop must stay untouched")
        assert.strictEqual(await Shop.countDocuments({}), 2, "editing must not create duplicates")
    })

    test("unknown identities are rejected without creating a shop or touching existing ones", async () => {
        const ghost = await postShopJson(tokenFor(new mongoose.Types.ObjectId()), SHOP_FIELDS)

        assert.strictEqual(ghost.status, 401)
        assert.strictEqual(ghost.body.message, "Invalid or expired token")
        assert.strictEqual(await Shop.countDocuments({}), 0)
    })

    test("unauthenticated shop writes are rejected", async () => {
        const anonymousReq = attachAuth(request(app).post("/api/shop/create-edit"), "", csrfToken())
        const anonymous = await anonymousReq.send(SHOP_FIELDS)

        assert.strictEqual(anonymous.status, 401)
        assert.strictEqual(await Shop.countDocuments({}), 0)
    })
})
