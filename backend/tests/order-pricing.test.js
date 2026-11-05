import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "crypto"
import http from "node:http"
import express from "express"
import cookieParser from "cookie-parser"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_order_pricing_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.RAZORPAY_KEY_SECRET = "test_razor_secret_for_order_pricing"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { setRazorpayClientForTesting, getRazorpayInstance } from "../controllers/order.controllers.js"
import { ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import { roomForUser } from "../socket.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const TEST_SECRET = process.env.RAZORPAY_KEY_SECRET

const expectedTotal = (subtotal) => subtotal + (subtotal > 500 ? 0 : 40)

let mongo
let app

const Razorpay_double = {
    orderSeq: 0,
    ordersCreated: [],
    paymentsFetchResult: null,
    orders: {
        create: async (payload) => {
            Razorpay_double.ordersCreated.push(payload)
            Razorpay_double.orderSeq += 1
            return {
                id: `order_test_${Razorpay_double.orderSeq}`,
                amount: payload.amount,
                currency: payload.currency,
                receipt: payload.receipt
            }
        }
    },
    payments: {
        fetch: async (paymentId) => {
            if (!Razorpay_double.paymentsFetchResult) {
                throw new Error("payments.fetch not configured for this test")
            }
            return Razorpay_double.paymentsFetchResult
        }
    }
}

const ioEvents = []
const ioTestDouble = {
    to: (room) => ({
        emit: (event, payload) => {
            ioEvents.push({ room, event, payload })
        }
    })
}

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })

const csrfToken = () => jwt.sign({ csrf: "cs-shared-order", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postTo = (path, token,csrf, body) =>
    request(app)
        .post(path)
        .set("Cookie", [`token=${token}`, `XSRF-TOKEN=${csrf}`])
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const placeOrderVia = (token, cartItems, { totalAmount, paymentMethod = "cod" } = {}) =>
    postTo("/api/order/place-order", token, csrfToken(), {
        paymentMethod,
        deliveryAddress: { text: "12 test road", latitude: 18.5, longitude: 73.8 },
        totalAmount,
        cartItems
    })

const verifyPaymentVia = (token, orderId, { razorpayOrderId = "order_test_TARGET", paymentId = "pay_test_1", signature } = {}) =>
    postTo("/api/order/verify-payment", token, csrfToken(), {
        razorpay_payment_id: paymentId,
        razorpay_order_id: razorpayOrderId,
        razorpay_signature: signature,
        orderId
    })

const signatureFor = (razorOrderId, paymentId) =>
    crypto.createHmac("sha256", TEST_SECRET).update(`${razorOrderId}|${paymentId}`).digest("hex")

const seedWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const owner2 = await User.create({ fullName: "Owner Two", email: `o2${Date.now()}@t.com`, mobile: "9000000002", role: "owner" })
    const customer = await User.create({ fullName: "Customer", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
    const attacker = await User.create({ fullName: "Attacker", email: `a${Date.now()}@t.com`, mobile: "9000000003", role: "user" })

    const shop1 = await Shop.create({ name: "Shop One", image: "s1.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shop2 = await Shop.create({ name: "Shop Two", image: "s2.png", owner: owner2._id, city: "Pune", state: "MH", address: "a", items: [] })

    const item100 = await Item.create({ name: "Item 100", image: "i1.png", shop: shop1._id, category: "Others", price: 100, foodType: "veg" })
    const item500 = await Item.create({ name: "Item 500", image: "i2.png", shop: shop1._id, category: "Others", price: 500, foodType: "veg" })
    const item501 = await Item.create({ name: "Item 501", image: "i3.png", shop: shop1._id, category: "Others", price: 501, foodType: "veg" })

    return { owner, owner2, customer, attacker, shop1, shop2, item100, item500, item501 }
}

const cartLineOf = (item, shop, overrides = {}) => ({
    id: String(item._id),
    shop: String(shop._id),
    name: item.name,
    price: overrides.price ?? item.price,
    quantity: overrides.quantity ?? 1
})

const seedPaidTarget = async (w, { totalAmount = 105 } = {}) => {
    const order = await Order.create({
        user: w.customer._id,
        paymentMethod: "online",
        deliveryAddress: { text: "12 test road", latitude: 18.5, longitude: 73.8 },
        totalAmount,
        shopOrders: [{
            shop: w.shop1._id,
            owner: w.owner._id,
            subtotal: 105,
            shopOrderItems: [{ item: w.item100._id, name: w.item100.name, price: 105, quantity: 1 }]
        }],
        razorpayOrderId: "order_test_TARGET",
        payment: false
    })
    return order
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
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
    Razorpay_double.ordersCreated = []
    Razorpay_double.orderSeq = 0
    Razorpay_double.paymentsFetchResult = null
    ioEvents.length = 0
})

describe("place-order server-side pricing contract (Stage 2 targets, red today)", () => {
    test("a client-submitted item price lower than the database price cannot undercut the payable amount", async () => {
        const w = await seedWorld()
        const clientLine = cartLineOf(w.item100, w.shop1, { price: 1 })

        const res = await placeOrderVia(tokenFor(w.customer._id), [clientLine], { totalAmount: 1, paymentMethod: "online" })

        assert.strictEqual(res.status, 200)
        const order = await Order.findById(res.body.orderId)
        assert.ok(order, "order must exist")
        assert.strictEqual(order.shopOrders[0].shopOrderItems[0].price, 100, "stored line price must be the database price, not the client value")
        assert.strictEqual(order.shopOrders[0].subtotal, 100)
        const expectedPaise = Math.round(expectedTotal(100) * 100)
        assert.strictEqual(Razorpay_double.ordersCreated.at(-1)?.amount, expectedPaise, "razorpay authorization amount must equal the server-computed total")
    })

    test("an item belonging to a different shop is rejected and no order is created", async () => {
        const w = await seedWorld()
        const crossLine = cartLineOf(w.item100, w.shop2)

        const res = await placeOrderVia(tokenFor(w.customer._id), [crossLine], { totalAmount: 140 })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(await Order.countDocuments({}), 0)
    })

    test("a nonexistent item id is rejected and no order is created", async () => {
        const w = await seedWorld()
        const ghostLine = { id: String(new mongoose.Types.ObjectId()), shop: String(w.shop1._id), name: "Ghost", price: 100, quantity: 1 }

        const res = await placeOrderVia(tokenFor(w.customer._id), [ghostLine], { totalAmount: 140 })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(await Order.countDocuments({}), 0)
    })

    test("a deleted item id is rejected and no order is created", async () => {
        const w = await seedWorld()
        const doomed = await Item.create({ name: "Doomed", image: "d.png", shop: w.shop1._id, category: "Others", price: 100, foodType: "non veg" })
        await Item.findByIdAndDelete(doomed._id)
        const deletedLine = cartLineOf(doomed, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [deletedLine], { totalAmount: 140 })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(await Order.countDocuments({}), 0)
    })

    test("an unavailable item is rejected and no order is created", async () => {
        const w = await seedWorld()
        const unavailable = await Item.create({
            name: "Sold Out",
            image: "s.png",
            shop: w.shop1._id,
            category: "Others",
            price: 100,
            foodType: "veg",
            isAvailable: false
        })
        const line = cartLineOf(unavailable, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: 140 })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "item is not available")
        assert.strictEqual(await Order.countDocuments({}), 0)
    })

    test("zero, negative, fractional, non-numeric and oversized quantities are all rejected", async () => {
        const w = await seedWorld()
        for (const quantity of [0, -5, 2.5, "abc", 1000000000]) {
            const line = cartLineOf(w.item100, w.shop1, { quantity })
            const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: 140 })
            assert.strictEqual(res.status, 400, `quantity ${JSON.stringify(quantity)} must be rejected`)
            assert.strictEqual(await Order.countDocuments({}), 0, `quantity ${JSON.stringify(quantity)} must not create an order`)
        }
    })

    test("a manipulated client totalAmount cannot discount the order below the line-item-derived total", async () => {
        const w = await seedWorld()
        const honestLine = cartLineOf(w.item100, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [honestLine], { totalAmount: 10 })

        assert.strictEqual(res.status, 201)
        const order = await Order.findById(res.body._id)
        assert.ok(order)
        assert.strictEqual(order.totalAmount, expectedTotal(100), "stored total must equal server-computed subtotal plus delivery fee")
    })
})

describe("place-order invariants that hold with an honest client (guards after Stage 2)", () => {
    test("an honest online cart authorizes exactly the line-item-derived payable amount in paise", async () => {
        const w = await seedWorld()
        const honestLine = cartLineOf(w.item100, w.shop1)
        const subtotal = 100
        const res = await placeOrderVia(tokenFor(w.customer._id), [honestLine], { totalAmount: expectedTotal(subtotal), paymentMethod: "online" })

        assert.strictEqual(res.status, 200)
        assert.ok(res.body.razorOrder?.id)
        const order = await Order.findById(res.body.orderId)
        assert.strictEqual(order.totalAmount, expectedTotal(subtotal))
        assert.strictEqual(Razorpay_double.ordersCreated.at(-1)?.amount, Math.round(expectedTotal(subtotal) * 100))
        assert.strictEqual(Razorpay_double.ordersCreated.at(-1)?.currency, "INR")
    })

    test("delivery fee boundary: subtotal of exactly 500 gets a 40 fee for a 540 total", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item500, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(500) })

        assert.strictEqual(res.status, 201)
        const order = await Order.findById(res.body._id)
        assert.strictEqual(order.shopOrders[0].subtotal, 500)
        assert.strictEqual(order.totalAmount, 540)
    })

    test("delivery fee boundary: subtotal of 501 carries no fee for a 501 total, and the online paise amount matches", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item501, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(501), paymentMethod: "online" })

        assert.strictEqual(res.status, 200)
        const order = await Order.findById(res.body.orderId)
        assert.strictEqual(order.shopOrders[0].subtotal, 501)
        assert.strictEqual(order.totalAmount, 501)
        assert.strictEqual(Razorpay_double.ordersCreated.at(-1)?.amount, 50100)
    })

    test("a plain COD placement keeps the room-based owner notification shape", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item100, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(100) })

        assert.strictEqual(res.status, 201)
        const newOrderEvents = ioEvents.filter((e) => e.event === "newOrder")
        assert.strictEqual(newOrderEvents.length, 1, "exactly one owner notification per shopOrder")
        assert.strictEqual(newOrderEvents[0].room, roomForUser(w.owner._id))
        assert.strictEqual(newOrderEvents[0].payload.paymentMethod, "cod")
        assert.ok(newOrderEvents[0].payload.shopOrders?.shopOrderItems?.length === 1)
    })
})

describe("verify-payment protections (real controller roundtrip)", () => {
    test("a captured payment matching order, user, amount and currency marks the order paid once and notifies the owner once", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w, { totalAmount: 105 })
        Razorpay_double.paymentsFetchResult = {
            id: "pay_test_1",
            status: "captured",
            amount: 10500,
            currency: "INR",
            order_id: "order_test_TARGET"
        }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 200)
        const order = await Order.findById(res.body._id)
        assert.strictEqual(order.payment, true)
        assert.strictEqual(order.razorpayPaymentId, "pay_test_1")
        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, 1)
        assert.strictEqual(ioEvents[0].room, roomForUser(w.owner._id))
    })

    test("a tampered signature is rejected and the order stays unpaid", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        const valid = signatureFor("order_test_TARGET", "pay_test_1")
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: valid.slice(0, -2) + "00"
        })

        assert.strictEqual(res.status, 400)
        const order = await Order.findById((await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id)
        assert.strictEqual(order.payment, false)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("a signature minted for a different razorpay order is rejected", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_OTHER", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("verify-payment on another user's order is rejected with 403 and nothing is marked paid", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.attacker._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 403)
        const order = await Order.findById((await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id)
        assert.strictEqual(order.payment, false)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("an authorized-but-not-captured payment is rejected", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "authorized", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("a gateway amount disagreeing with the order amount is rejected", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 99999, currency: "INR", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("a non-INR gateway currency is rejected", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "USD", order_id: "order_test_TARGET" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("a captured payment referencing a different razorpay order is rejected", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_OTHER" }

        const res = await verifyPaymentVia(tokenFor(w.customer._id), (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        assert.strictEqual(ioEvents.length, 0)
    })

    test("a repeated verification request after success is idempotent and emits no second notification", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }
        const orderId = (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString()

        const first = await verifyPaymentVia(tokenFor(w.customer._id), orderId, { signature: signatureFor("order_test_TARGET", "pay_test_1") })
        const second = await verifyPaymentVia(tokenFor(w.customer._id), orderId, { signature: signatureFor("order_test_TARGET", "pay_test_1") })

        assert.strictEqual(first.status, 200)
        assert.strictEqual(second.status, 200)
        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, 1)
        const order = await Order.findById(orderId)
        assert.strictEqual(order.payment, true)
        assert.strictEqual(order.razorpayPaymentId, "pay_test_1")
    })

    test("two concurrent verification requests of the same payment produce exactly one state transition and one notification", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w)
        Razorpay_double.paymentsFetchResult = { id: "pay_test_1", status: "captured", amount: 10500, currency: "INR", order_id: "order_test_TARGET" }
        const orderId = (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString()

        const [r1, r2] = await Promise.all([
            verifyPaymentVia(tokenFor(w.customer._id), orderId, { signature: signatureFor("order_test_TARGET", "pay_test_1") }),
            verifyPaymentVia(tokenFor(w.customer._id), orderId, { signature: signatureFor("order_test_TARGET", "pay_test_1") })
        ])

        const statuses = [r1.status, r2.status]
        assert.ok(statuses.every((s) => s === 200), "both idempotent responses must be 200")
        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, 1)
        const order = await Order.findById(orderId)
        assert.strictEqual(order.payment, true)
        assert.strictEqual(order.razorpayPaymentId, "pay_test_1")
    })

    test("verify-payment rejects an order that was never placed for online payment", async () => {
        const w = await seedWorld()
        const codOrder = await Order.create({
            user: w.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 test road", latitude: 18.5, longitude: 73.8 },
            totalAmount: 140,
            shopOrders: [{
                shop: w.shop1._id,
                owner: w.owner._id,
                subtotal: 100,
                shopOrderItems: [{ item: w.item100._id, name: w.item100.name, price: 100, quantity: 1 }]
            }]
        })

        const res = await verifyPaymentVia(tokenFor(w.customer._id), codOrder._id.toString(), {
            signature: signatureFor("order_test_TARGET", "pay_test_1")
        })

        assert.strictEqual(res.status, 400)
        const reloaded = await Order.findById(codOrder._id)
        assert.strictEqual(reloaded.payment, false)
        assert.strictEqual(ioEvents.length, 0)
    })
})

describe("order endpoints are rate limited per authenticated user (Stage 3)", () => {
    test("order placement throttles a single user after the configured limit and leaves other users unaffected", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item100, w.shop1)
        const limit = ORDER_RATE_LIMITS.placeOrder.limit

        const statuses = []
        for (let i = 0; i <= limit; i++) {
            const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(100), paymentMethod: "cod" })
            statuses.push(res.status)
        }

        assert.strictEqual(statuses.filter((s) => s === 201).length, limit, "all requests up to the limit must still place orders")
        assert.strictEqual(statuses.at(-1), 429, "the request after the limit must be throttled")

        const otherUser = await placeOrderVia(tokenFor(w.attacker._id), [line], { totalAmount: expectedTotal(100), paymentMethod: "cod" })
        assert.strictEqual(otherUser.status, 201, "rate limiting must be per user, not global")
    })

    test("payment verification throttles only after a generous budget so idempotent retries survive", async () => {
        const w = await seedWorld()
        await seedPaidTarget(w, { totalAmount: 105 })
        Razorpay_double.paymentsFetchResult = {
            id: "pay_test_1",
            status: "captured",
            amount: 10500,
            currency: "INR",
            order_id: "order_test_TARGET"
        }
        const orderId = (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString()
        const token = tokenFor(w.customer._id)
        const signature = signatureFor("order_test_TARGET", "pay_test_1")
        const budget = ORDER_RATE_LIMITS.verifyPayment.limit

        for (let i = 0; i < budget; i++) {
            const res = await verifyPaymentVia(token, orderId, { signature })
            assert.strictEqual(res.status, 200, `retry ${i + 1} inside the budget must stay idempotent`)
        }

        const throttled = await verifyPaymentVia(token, orderId, { signature })
        assert.strictEqual(throttled.status, 429)
        assert.strictEqual(throttled.body.message, "Too many requests. Please try again later.")

        assert.strictEqual(ioEvents.filter((e) => e.event === "newOrder").length, 1, "throttling must not change payment semantics")
        const order = await Order.findById(orderId)
        assert.strictEqual(order.payment, true)
    })
})

describe("razorpay order metadata (Stage 3)", () => {
    test("the razorpay order receives the internal order id in its notes", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item100, w.shop1)

        const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(100), paymentMethod: "online" })

        assert.strictEqual(res.status, 200)
        const order = await Order.findById(res.body.orderId)
        const captured = Razorpay_double.ordersCreated.at(-1)
        assert.strictEqual(captured.notes?.internalOrderId, String(order._id), "gateway notes must carry the internal order id")
        assert.strictEqual(order.razorpayOrderId, res.body.razorOrder.id, "internal order must keep its gateway binding")
        assert.strictEqual(captured.amount, Math.round(expectedTotal(100) * 100), "metadata must not replace amount-based authorization")
    })

    test("a gateway failure during online placement removes the provisional internal order", async () => {
        const w = await seedWorld()
        const line = cartLineOf(w.item100, w.shop1)
        const originalCreate = Razorpay_double.orders.create
        Razorpay_double.orders.create = async () => {
            throw new Error("simulated gateway outage")
        }

        try {
            const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(100), paymentMethod: "online" })

            assert.strictEqual(res.status, 500)
            assert.strictEqual(res.body.message, "Failed to place order. Please try again.")
            assert.strictEqual(await Order.countDocuments({}), 0, "no payable-looking order may survive a failed gateway call")
            assert.strictEqual(ioEvents.length, 0)
        } finally {
            Razorpay_double.orders.create = originalCreate
        }
    })
})

describe("razorpay configuration fails safely (Stage 3)", () => {
    const withClearedRazorpayEnv = async ({ clearKeyId, clearKeySecret }, fn) => {
        const snapshotId = process.env.RAZORPAY_KEY_ID
        const snapshotSecret = process.env.RAZORPAY_KEY_SECRET
        if (clearKeyId) {
            delete process.env.RAZORPAY_KEY_ID
        }
        if (clearKeySecret) {
            delete process.env.RAZORPAY_KEY_SECRET
        }
        try {
            await fn()
        } finally {
            if (snapshotId === undefined) {
                delete process.env.RAZORPAY_KEY_ID
            } else {
                process.env.RAZORPAY_KEY_ID = snapshotId
            }
            if (snapshotSecret === undefined) {
                delete process.env.RAZORPAY_KEY_SECRET
            } else {
                process.env.RAZORPAY_KEY_SECRET = snapshotSecret
            }
            setRazorpayClientForTesting(Razorpay_double)
        }
    }

    test("placing an online order without Razorpay credentials fails safely before creating any order", async () => {
        await withClearedRazorpayEnv({ clearKeyId: true, clearKeySecret: true }, async () => {
            const w = await seedWorld()
            const line = cartLineOf(w.item100, w.shop1)
            setRazorpayClientForTesting(null)

            const res = await placeOrderVia(tokenFor(w.customer._id), [line], { totalAmount: expectedTotal(100), paymentMethod: "online" })

            assert.strictEqual(res.status, 500)
            assert.strictEqual(res.body.message, "Payment configuration error")
            assert.strictEqual(await Order.countDocuments({}), 0, "unconfigured gateway must not leave an order behind")
        })
    })

    test("payment verification fails safely when Razorpay configuration is incomplete", async () => {
        await withClearedRazorpayEnv({ clearKeyId: true, clearKeySecret: false }, async () => {
            const w = await seedWorld()
            await seedPaidTarget(w)
            const orderId = (await Order.findOne({ razorpayOrderId: "order_test_TARGET" }))._id.toString()

            const res = await verifyPaymentVia(tokenFor(w.customer._id), orderId, {
                signature: signatureFor("order_test_TARGET", "pay_test_1")
            })

            assert.strictEqual(res.status, 500)
            assert.strictEqual(res.body.message, "Payment verification configuration error")
            const order = await Order.findById(orderId)
            assert.strictEqual(order.payment, false)
            assert.strictEqual(ioEvents.length, 0)
        })
    })

    test("getRazorpayInstance builds from environment only and never falls back to placeholder credentials", async () => {
        await withClearedRazorpayEnv({ clearKeyId: true, clearKeySecret: true }, async () => {
            setRazorpayClientForTesting(null)
            assert.throws(() => getRazorpayInstance(), /Payment configuration error/)

            setRazorpayClientForTesting({ orders: { create: async () => ({}) } })
            assert.deepStrictEqual(typeof getRazorpayInstance().orders.create, "function", "test double injection must keep working without real credentials")

            setRazorpayClientForTesting(null)
            process.env.RAZORPAY_KEY_ID = "rzp_test_probe"
            process.env.RAZORPAY_KEY_SECRET = "probe_key_secret_literal"
            const configured = getRazorpayInstance()
            assert.ok(configured, "real construction from environment values must work")
            assert.strictEqual(typeof configured.orders.create, "function")
        })
    })
})
