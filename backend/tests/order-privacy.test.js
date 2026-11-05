import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"
import express from "express"
import cookieParser from "cookie-parser"

process.env.JWT_SECRET = "test_order_privacy_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const OTP_FIELDS = ["deliveryOtp", "otpExpires", "otpAttempts"]

let mongo
let app
let emitted = []

const ioDouble = {
    to: (room) => ({
        emit: (event, payload) => emitted.push({ event, room, payload })
    })
}

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-order-privacy", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const attachAuth = (req, token) => {
    const csrf = csrfToken()
    req.set("Cookie", `token=${token}; XSRF-TOKEN=${csrf}`)
    req.set("X-XSRF-TOKEN", csrf)
    req.set("Origin", TRUSTED_ORIGIN)
    return req
}

const getOrderById = (token, orderId) =>
    request(app).get(`/api/order/get-order-by-id/${orderId}`).set("Cookie", `token=${token}`)

const getMyOrders = (token) =>
    request(app).get("/api/order/my-orders").set("Cookie", `token=${token}`)

const getCurrentOrder = (token) =>
    request(app).get("/api/order/get-current-order").set("Cookie", `token=${token}`)

const getAssignments = (token) =>
    request(app).get("/api/order/get-assignments").set("Cookie", `token=${token}`)

const postStatus = (token, orderId, shopId, status) =>
    attachAuth(request(app).post(`/api/order/update-status/${orderId}/${shopId}`), token).send({ status })

const placeOrder = (token, payload) =>
    attachAuth(request(app).post("/api/order/place-order"), token).send(payload)

const assertNoOtpFields = (shopOrder, label) => {
    for (const field of OTP_FIELDS) {
        assert.ok(!(field in shopOrder), `${label} must not expose ${field}`)
    }
}

let seq = 0
const seedUser = (role) => {
    seq += 1
    return User.create({
        fullName: `${role} ${seq}`,
        email: `${role}${seq}@privacy.test`,
        mobile: `92000000${String(seq).padStart(2, "0")}`,
        role
    })
}

const seedPrivacyWorld = async () => {
    const owner = await seedUser("owner")
    const customer = await seedUser("user")
    const rider = await seedUser("deliveryBoy")
    const shop = await Shop.create({ name: "Privacy Shop", image: "p.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const item = await Item.create({ name: "Privacy Roll", image: "i.png", shop: shop._id, category: "Others", price: 100, foodType: "veg" })

    const order = await Order.create({
        user: customer._id,
        paymentMethod: "cod",
        deliveryAddress: { text: "12 privacy lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: 140,
        shopOrders: [{
            shop: shop._id,
            owner: owner._id,
            subtotal: 100,
            status: "out of delivery",
            assignedDeliveryBoy: rider._id,
            shopOrderItems: [{ item: item._id, name: item.name, price: 100, quantity: 1 }]
        }]
    })
    const shopOrder = order.shopOrders[0]
    const assignment = await DeliveryAssignment.create({
        order: order._id,
        shop: shop._id,
        shopOrderId: shopOrder._id,
        brodcastedTo: [rider._id],
        assignedTo: rider._id,
        acceptedAt: new Date(),
        status: "assigned"
    })
    shopOrder.assignment = assignment._id
    shopOrder.deliveryOtp = "4321"
    shopOrder.otpExpires = new Date(Date.now() + 5 * 60 * 1000)
    shopOrder.otpAttempts = 2
    await order.save()

    return { owner, customer, rider, shop, item, order, shopOrder }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init(), DeliveryAssignment.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/order", csrfMiddleware, orderRouter)
    app.set("io", ioDouble)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
    emitted = []
})

describe("order and delivery response minimization (Stage 6E)", () => {
    test("customer order lists drop OTP material and shop-owner contact data", async () => {
        const w = await seedPrivacyWorld()

        const res = await getMyOrders(tokenFor(w.customer._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)

        const responseOrder = res.body[0]
        assert.strictEqual(typeof responseOrder.user, "string", "customer view keeps the id reference only")
        assertNoOtpFields(responseOrder.shopOrders[0], "customer order list shopOrder")

        const owner = responseOrder.shopOrders[0].owner
        assert.strictEqual(owner.fullName, w.owner.fullName)
        assert.strictEqual(owner.email, undefined, "the customer must not receive the owner's email")
        assert.strictEqual(owner.mobile, undefined, "the customer must not receive the owner's mobile")
    })

    test("owner order lists expose only fulfillment contact fields and no OTP material", async () => {
        const w = await seedPrivacyWorld()

        const res = await getMyOrders(tokenFor(w.owner._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)

        const responseOrder = res.body[0]
        assert.strictEqual(responseOrder.user.fullName, w.customer.fullName)
        assert.strictEqual(responseOrder.user.mobile, w.customer.mobile)
        assert.strictEqual(responseOrder.user.email, undefined, "the owner must not receive the customer's email")
        assertNoOtpFields(responseOrder.shopOrders, "owner order list shopOrder")
    })

    test("single-order reads never leak the delivery OTP to any authorized caller", async () => {
        const w = await seedPrivacyWorld()

        const asCustomer = await getOrderById(tokenFor(w.customer._id), w.order._id.toString())
        assert.strictEqual(asCustomer.status, 200)
        assert.strictEqual(asCustomer.body.user.fullName, w.customer.fullName)
        assert.strictEqual(asCustomer.body.user.email, w.customer.email, "own email stays visible to the customer")
        assertNoOtpFields(asCustomer.body.shopOrders[0], "customer single order")

        const asOwner = await getOrderById(tokenFor(w.owner._id), w.order._id.toString())
        assert.strictEqual(asOwner.status, 200)
        assert.strictEqual(asOwner.body.user.fullName, w.customer.fullName)
        assert.strictEqual(asOwner.body.user.mobile, w.customer.mobile)
        assert.strictEqual(asOwner.body.user.email, undefined)
        assert.strictEqual(asOwner.body.shopOrders[0].assignedDeliveryBoy.fullName, w.rider.fullName)
        assert.strictEqual(asOwner.body.shopOrders[0].assignedDeliveryBoy.mobile, w.rider.mobile)
        assertNoOtpFields(asOwner.body.shopOrders[0], "owner single order")

        const asRider = await getOrderById(tokenFor(w.rider._id), w.order._id.toString())
        assert.strictEqual(asRider.status, 200)
        assert.strictEqual(asRider.body.user.fullName, w.customer.fullName)
        assert.strictEqual(asRider.body.user.email, undefined)
        assertNoOtpFields(asRider.body.shopOrders[0], "rider single order")
    })

    test("the active assignment response never carries the delivery OTP", async () => {
        const w = await seedPrivacyWorld()

        await User.updateOne(
            { _id: w.customer._id },
            { location: { type: "Point", coordinates: [73.85, 18.52] } }
        )

        const res = await getCurrentOrder(tokenFor(w.rider._id))
        assert.strictEqual(res.status, 200)
        assertNoOtpFields(res.body.shopOrder, "get-current-order shopOrder")
        assert.strictEqual(res.body.user.fullName, w.customer.fullName)
        assert.strictEqual(res.body.user.email, undefined)
        assert.strictEqual(res.body.user.location, undefined, "riders receive the delivery address, not the customer's stored coordinates")
        assert.strictEqual(res.body.deliveryAddress.text, "12 privacy lane")
    })

    test("broadcast assignments reveal only enough detail to decide whether to accept", async () => {
        const w = await seedPrivacyWorld()
        await DeliveryAssignment.updateOne(
            { "brodcastedTo": w.rider._id },
            { status: "brodcasted", assignedTo: null, acceptedAt: null }
        )

        const res = await getAssignments(tokenFor(w.rider._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.length, 1)
        assert.deepStrictEqual(
            Object.keys(res.body[0]).sort(),
            ["assignmentId", "itemCount", "shopName", "subtotal"]
        )
        assert.strictEqual(res.body[0].itemCount, 1)
        assert.strictEqual(res.body[0].shopName, w.shop.name)
        assert.strictEqual(res.body[0].deliveryAddress, undefined)
        assert.strictEqual(res.body[0].items, undefined)
        assert.strictEqual(res.body[0].orderId, undefined)

        const asCustomer = await getAssignments(tokenFor(w.customer._id))
        assert.strictEqual(asCustomer.status, 403)
    })

    test("non-customer single-order and active-delivery views omit rider coordinates", async () => {
        const w = await seedPrivacyWorld()
        await User.updateOne(
            { _id: w.rider._id },
            { location: { type: "Point", coordinates: [73.81, 18.51] } }
        )

        const ownerView = await getOrderById(tokenFor(w.owner._id), w.order._id.toString())
        assert.strictEqual(ownerView.status, 200)
        assert.strictEqual(ownerView.body.shopOrders[0].assignedDeliveryBoy.fullName, w.rider.fullName)
        assert.strictEqual(ownerView.body.shopOrders[0].assignedDeliveryBoy.location, undefined)

        const customerView = await getOrderById(tokenFor(w.customer._id), w.order._id.toString())
        assert.strictEqual(customerView.status, 200)
        assert.ok(customerView.body.shopOrders[0].assignedDeliveryBoy.location, "the customer may see live rider coordinates")
    })

    test("status updates never return OTP material but keep the stored code intact", async () => {
        const w = await seedPrivacyWorld()

        const res = await postStatus(tokenFor(w.owner._id), w.order._id.toString(), w.shop._id.toString(), "out of delivery")
        assert.strictEqual(res.status, 200)
        assertNoOtpFields(res.body.shopOrder, "update-status shopOrder")
        assert.strictEqual(res.body.assignedDeliveryBoy.fullName, w.rider.fullName)
        assert.strictEqual(res.body.assignedDeliveryBoy.mobile, w.rider.mobile)
        assert.strictEqual(res.body.assignedDeliveryBoy.email, undefined)

        const stored = await Order.findById(w.order._id)
        assert.strictEqual(stored.shopOrders[0].deliveryOtp, "4321", "the stored OTP must survive the response scrub")
    })

    test("placing an order emits and returns only minimal customer contact data", async () => {
        const owner = await seedUser("owner")
        const customer = await seedUser("user")
        const shop = await Shop.create({ name: "New Order Shop", image: "n.png", owner: owner._id, city: "Pune", state: "MH", address: "b", items: [] })
        const item = await Item.create({ name: "Fresh Roll", image: "f.png", shop: shop._id, category: "Others", price: 90, foodType: "veg" })

        const res = await placeOrder(tokenFor(customer._id), {
            cartItems: [{ id: item._id.toString(), shop: shop._id.toString(), quantity: 1 }],
            paymentMethod: "cod",
            deliveryAddress: { text: "9 new order road", latitude: 18.5, longitude: 73.8 }
        })

        assert.strictEqual(res.status, 201)
        assert.strictEqual(res.body.user.fullName, customer.fullName)
        assert.strictEqual(res.body.user.mobile, customer.mobile)
        assert.strictEqual(res.body.user.email, undefined, "order responses must not carry the customer email")
        assertNoOtpFields(res.body.shopOrders[0], "place-order response shopOrder")
        assert.strictEqual(res.body.shopOrders[0].owner.fullName, owner.fullName)
        assert.strictEqual(res.body.shopOrders[0].owner.socketId, undefined, "routing internals must never be serialized")

        const newOrderEvent = emitted.find(event => event.event === "newOrder")
        assert.ok(newOrderEvent, "the shop owner must still receive the newOrder event")
        assert.strictEqual(newOrderEvent.payload.user.fullName, customer.fullName)
        assert.strictEqual(newOrderEvent.payload.user.mobile, customer.mobile)
        assert.strictEqual(newOrderEvent.payload.user.email, undefined)
        assert.strictEqual(newOrderEvent.payload.shopOrders.owner.fullName, owner.fullName)
        assert.strictEqual(newOrderEvent.payload.shopOrders.owner.socketId, undefined)
        assertNoOtpFields(newOrderEvent.payload.shopOrders, "newOrder socket payload")
    })
})
