import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_location_address_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import userRouter from "../routes/user.routes.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { toValidCoordinates } from "../socket.js"
import { setRazorpayClientForTesting } from "../controllers/order.controllers.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-location-address", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postUser = (token, body) =>
    request(app)
        .post("/api/user/update-location")
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const postOrderFor = (token, body) =>
    request(app)
        .post("/api/order/place-order")
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const ioEvents = []
const ioTestDouble = {
    to: (room) => ({
        emit: (event, payload) => {
            ioEvents.push({ room, event, payload })
        }
    })
}

const Razorpay_double = {
    orderSeq: 0,
    ordersCreated: [],
    orders: {
        create: async (payload) => {
            Razorpay_double.ordersCreated.push(payload)
            Razorpay_double.orderSeq += 1
            return {
                id: `order_loc_${Razorpay_double.orderSeq}`,
                amount: payload.amount,
                currency: payload.currency,
                receipt: payload.receipt
            }
        }
    }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/user", csrfMiddleware, userRouter)
    app.use("/api/order", csrfMiddleware, orderRouter)
    app.set("io", ioTestDouble)
    setRazorpayClientForTesting(Razorpay_double)
})

after(async () => {
    setRazorpayClientForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({})])
    ioEvents.length = 0
    Razorpay_double.ordersCreated = []
    Razorpay_double.orderSeq = 0
})

const seedCheckoutWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const customer = await User.create({ fullName: "Customer One", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })

    const shop = await Shop.create({ name: "Shop One", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const item = await Item.create({ name: "Dish", image: "i.png", shop: shop._id, category: "Others", price: 100, foodType: "veg" })

    return { owner, customer, shop, item }
}

const newCustomer = async (label) =>
    User.create({ fullName: `Customer ${label}`, email: `c${label}${Date.now()}@t.com`, mobile: "9000000099", role: "user" })

const newDeliveryBoy = async (label) =>
    User.create({ fullName: `Rider ${label}`, email: `d${label}${Date.now()}@t.com`, mobile: "9000000098", role: "deliveryBoy" })

const cartLine = (w) => [{ id: String(w.item._id), shop: String(w.shop._id), quantity: 1 }]

describe("REST user-location validation (Stage 6C)", () => {
    test("valid delivery-partner coordinates are stored in the geospatial [longitude, latitude] order", async () => {
        const rider = await newDeliveryBoy("valid")

        const res = await postUser(tokenFor(rider._id), { lat: 18.5204, lon: 73.8567 })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.message, "location updated")
        const stored = await User.findById(rider._id)
        assert.strictEqual(stored.location.type, "Point")
        assert.deepStrictEqual([...stored.location.coordinates], [73.8567, 18.5204])
    })

    test("exact bounds values (-90/90 and -180/180) are accepted for delivery partners", async () => {
        const rider = await newDeliveryBoy("bounds")

        const south = await postUser(tokenFor(rider._id), { lat: -90, lon: -180 })
        assert.strictEqual(south.status, 200)
        let stored = await User.findById(rider._id)
        assert.deepStrictEqual([...stored.location.coordinates], [-180, -90])

        const north = await postUser(tokenFor(rider._id), { lat: 90, lon: 180 })
        assert.strictEqual(north.status, 200)
        stored = await User.findById(rider._id)
        assert.deepStrictEqual([...stored.location.coordinates], [180, 90])
    })

    test("customers and owners cannot move their stored location through the rider endpoint", async () => {
        const w = await seedCheckoutWorld()
        await User.updateOne({ _id: w.customer._id }, { location: { type: "Point", coordinates: [73.85, 18.52] } })

        const customerRes = await postUser(tokenFor(w.customer._id), { lat: 19.07, lon: 72.88 })
        const ownerRes = await postUser(tokenFor(w.owner._id), { lat: 19.07, lon: 72.88 })

        assert.strictEqual(customerRes.status, 403)
        assert.strictEqual(ownerRes.status, 403)
        const stored = await User.findById(w.customer._id)
        assert.deepStrictEqual([...stored.location.coordinates], [73.85, 18.52])
    })

    test("string, NaN-like, boolean, structural and out-of-range coordinates are rejected with no stored change", async () => {
        const w = await seedCheckoutWorld()
        await User.updateOne({ _id: w.customer._id }, { location: { type: "Point", coordinates: [73.85, 18.52] } })

        for (const [label, body] of [
            ["string latitude", { lat: "18.5204", lon: 73.85 }],
            ["string longitude", { lat: 18.5204, lon: "73.85" }],
            ["NaN string", { lat: "NaN", lon: 10 }],
            ["NaN number serialized by JSON", { lat: Number.NaN, lon: 10 }],
            ["boolean latitude", { lat: true, lon: 10 }],
            ["array latitude", { lat: [18.5], lon: 10 }],
            ["object latitude", { lat: { value: 18.5 }, lon: 10 }],
            ["latitude above 90", { lat: 90.0001, lon: 10 }],
            ["latitude below -90", { lat: -90.0001, lon: 10 }],
            ["longitude above 180", { lat: 10, lon: 180.0001 }],
            ["longitude below -180", { lat: 10, lon: -180.0001 }],
            ["missing longitude", { lat: 10 }],
            ["missing latitude", { lon: 10 }],
            ["empty payload", {}]
        ]) {
            const res = await postUser(tokenFor(w.customer._id), body)
            assert.strictEqual(res.status, 400, `${label} must be rejected`)
        }

        const stored = await User.findById(w.customer._id)
        assert.deepStrictEqual([...stored.location.coordinates], [73.85, 18.52], "rejected payloads must never move the stored location")
    })

    test("unauthenticated updates are rejected and change nothing", async () => {
        const w = await seedCheckoutWorld()
        await User.updateOne({ _id: w.customer._id }, { location: { type: "Point", coordinates: [73.85, 18.52] } })

        const res = await request(app)
            .post("/api/user/update-location")
            .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send({ lat: 19.07, lon: 72.88 })

        assert.strictEqual(res.status, 401)
        const stored = await User.findById(w.customer._id)
        assert.deepStrictEqual([...stored.location.coordinates], [73.85, 18.52])
    })

    test("REST validation matches the Socket.IO coordinate validator", () => {
        assert.deepEqual(toValidCoordinates(18.5204, 73.8567), { latitude: 18.5204, longitude: 73.8567 })
        assert.deepEqual(toValidCoordinates(-90, -180), { latitude: -90, longitude: -180 })
        assert.deepEqual(toValidCoordinates(90, 180), { latitude: 90, longitude: 180 })
        assert.strictEqual(toValidCoordinates("18.5204", 73.8567), null)
        assert.strictEqual(toValidCoordinates(90.0001, 0), null)
        assert.strictEqual(toValidCoordinates(0, -180.0001), null)
        assert.strictEqual(toValidCoordinates(0, 180.0001), null)
        assert.strictEqual(toValidCoordinates(Number.NaN, 10), null)
        assert.strictEqual(toValidCoordinates(10, Number.NaN), null)
        assert.strictEqual(toValidCoordinates(Infinity, 10), null)
    })
})

describe("delivery-address validation at order placement (Stage 6C)", () => {
    test("a valid checkout persists the normalized address with latitude/longitude intact", async () => {
        const w = await seedCheckoutWorld()

        const res = await postOrderFor(tokenFor(w.customer._id), {
            paymentMethod: "cod",
            deliveryAddress: { text: "12 valid street", latitude: 18.5, longitude: 73.8 },
            cartItems: [{ id: String(w.item._id), shop: String(w.shop._id), quantity: 2 }]
        })

        assert.strictEqual(res.status, 201)
        const order = await Order.findById(res.body._id)
        assert.ok(order)
        assert.strictEqual(order.deliveryAddress.text, "12 valid street")
        assert.strictEqual(order.deliveryAddress.latitude, 18.5)
        assert.strictEqual(order.deliveryAddress.longitude, 73.8)
        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, 1)
    })

    test("malformed coordinates and address structures are rejected before any order is stored", async () => {
        const w = await seedCheckoutWorld()

        const cases = [
            ["missing address part", () => ({ text: "12 broken", latitude: 18.5 })],
            ["string latitude", () => ({ text: "12 street", latitude: "18.5", longitude: 73.8 })],
            ["NaN latitude", () => ({ text: "12 NaN", latitude: "NaN", longitude: 73.8 })],
            ["boolean latitude", () => ({ text: "12 street", latitude: true, longitude: 73.8 })],
            ["null latitude", () => ({ text: "12 street", latitude: null, longitude: 73.8 })],
            ["latitude above 90", () => ({ text: "12 street", latitude: 90.1, longitude: 73.8 })],
            ["latitude below -90", () => ({ text: "12 street", latitude: -90.1, longitude: 73.8 })],
            ["longitude above 180", () => ({ text: "12 street", latitude: 18.5, longitude: 180.1 })],
            ["longitude below -180", () => ({ text: "12 street", latitude: 18.5, longitude: -180.1 })],
            ["empty text", () => ({ text: "", latitude: 18.5, longitude: 73.8 })],
            ["numeric text", () => ({ text: 123, latitude: 18.5, longitude: 73.8 })],
            ["unknown key", () => ({ text: "12 street", latitude: 18.5, longitude: 73.8, secret: "x" })]
        ]

        for (const [label, build] of cases) {
            const invalidCustomer = await newCustomer(`bad${cases.indexOf(build)}`)
            const res = await postOrderFor(tokenFor(invalidCustomer._id), {
                paymentMethod: "cod",
                deliveryAddress: build(),
                cartItems: cartLine(w)
            })
            assert.strictEqual(res.status, 400, `${label} must be rejected`)

            const twin = await newCustomer(`twin${cases.indexOf(build)}`)
            const res2 = await postOrderFor(tokenFor(twin._id), {
                paymentMethod: "cod",
                deliveryAddress: { text: "12 street", latitude: 18.5, longitude: 73.8 },
                cartItems: cartLine(w)
            })
            assert.strictEqual(res2.status, 201, `${label}: a well-formed twin request must still be able to place an order`)
            const placed = await Order.findById(res2.body._id)
            assert.strictEqual(placed.deliveryAddress.text, "12 street")
        }

        assert.strictEqual(await Order.countDocuments({}), cases.length)
        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, cases.length)
    })

    test("an array or missing deliveryAddress is rejected as a malformed structure", async () => {
        const w = await seedCheckoutWorld()

        const arrayed = await postOrderFor(tokenFor(w.customer._id), {
            paymentMethod: "cod",
            deliveryAddress: ["fail"],
            cartItems: cartLine(w)
        })
        assert.strictEqual(arrayed.status, 400)

        const absentOrder = await request(app)
            .post("/api/order/place-order")
            .set("Cookie", `token=${tokenFor(w.customer._id)}; XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send({ paymentMethod: "cod", cartItems: cartLine(w) })
        assert.strictEqual(absentOrder.status, 400)

        assert.strictEqual(await Order.countDocuments({}), 0)
    })

    test("an online order with a valid address stores the same normalized address", async () => {
        const w = await seedCheckoutWorld()

        const res = await postOrderFor(tokenFor(w.customer._id), {
            paymentMethod: "online",
            deliveryAddress: { text: "gateway street", latitude: 18.5, longitude: 73.8 },
            cartItems: cartLine(w)
        })

        assert.strictEqual(res.status, 200)
        assert.ok(Razorpay_double.ordersCreated.at(-1), "the online order must reach the gateway with the parsed address")
        const order = await Order.findById(res.body.orderId)
        assert.strictEqual(order.deliveryAddress.text, "gateway street")
        assert.deepStrictEqual([order.deliveryAddress.latitude, order.deliveryAddress.longitude], [18.5, 73.8])
    })
})
