import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import express from "express"
import cookieParser from "cookie-parser"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_order_discount_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.RAZORPAY_KEY_SECRET = "test_order_discount_razorpay_secret"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { setRazorpayClientForTesting } from "../controllers/order.controllers.js"

const TRUSTED_ORIGIN = "http://localhost:5173"
const TEST_SECRET = process.env.RAZORPAY_KEY_SECRET

let mongo
let app
let sequence = 0
let razorpayOrderSequence = 0
let refundSequence = 0

const razorpayDouble = {
    ordersCreated: [],
    paymentsFetchResult: null,
    refundCalls: [],
    orders: {
        create: async (payload) => {
            razorpayDouble.ordersCreated.push(payload)
            razorpayOrderSequence += 1
            return {
                id: `order_discount_${razorpayOrderSequence}`,
                amount: payload.amount,
                currency: payload.currency,
                receipt: payload.receipt
            }
        }
    },
    payments: {
        fetch: async () => {
            if (!razorpayDouble.paymentsFetchResult) {
                throw new Error("payments.fetch not configured for this test")
            }
            return razorpayDouble.paymentsFetchResult
        },
        refund: async (paymentId, payload) => {
            razorpayDouble.refundCalls.push({ paymentId, payload })
            refundSequence += 1
            return {
                id: `rfnd_discount_${refundSequence}`,
                payment_id: paymentId,
                amount: payload.amount,
                status: "processed"
            }
        }
    }
}

const ioDouble = {
    to: () => ({
        emit: () => {}
    })
}

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-order-discount", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
const signatureFor = (razorOrderId, paymentId) =>
    crypto.createHmac("sha256", TEST_SECRET).update(`${razorOrderId}|${paymentId}`).digest("hex")

const postTo = (path, token, body) => {
    const csrf = csrfToken()
    return request(app)
        .post(path)
        .set("Cookie", [`token=${token}`, `XSRF-TOKEN=${csrf}`])
        .set("X-XSRF-TOKEN", csrf)
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)
}

const placeOrderVia = (token, cartItems, { paymentMethod = "cod", totalAmount } = {}) =>
    postTo("/api/order/place-order", token, {
        paymentMethod,
        deliveryAddress: { text: "12 discount road", latitude: 18.5, longitude: 73.8 },
        totalAmount,
        cartItems
    })

const verifyPaymentVia = (token, orderId, razorpayOrderId, paymentId = "pay_discount_1") =>
    postTo("/api/order/verify-payment", token, {
        razorpay_payment_id: paymentId,
        razorpay_order_id: razorpayOrderId,
        razorpay_signature: signatureFor(razorpayOrderId, paymentId),
        orderId
    })

const cancelVia = (token, orderId, shopOrderId) =>
    postTo(`/api/order/cancel/${orderId}/${shopOrderId}`, token, {})

const uniqueSuffix = () => {
    sequence += 1
    return `${Date.now()}_${sequence}`
}

const seedWorld = async () => {
    const suffix = uniqueSuffix()
    const owner = await User.create({ fullName: "Owner One", email: `order_discount_owner_${suffix}@test.com`, mobile: "9300000001", role: "owner" })
    const ownerTwo = await User.create({ fullName: "Owner Two", email: `order_discount_owner2_${suffix}@test.com`, mobile: "9300000002", role: "owner" })
    const customer = await User.create({ fullName: "Customer", email: `order_discount_customer_${suffix}@test.com`, mobile: "9300000003", role: "user" })
    const attacker = await User.create({ fullName: "Attacker", email: `order_discount_attacker_${suffix}@test.com`, mobile: "9300000004", role: "user" })

    const shopOne = await Shop.create({ name: "Shop One", image: "s1.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shopTwo = await Shop.create({ name: "Shop Two", image: "s2.png", owner: ownerTwo._id, city: "Pune", state: "MH", address: "b", items: [] })

    return { owner, ownerTwo, customer, attacker, shopOne, shopTwo }
}

const makeItem = async (world, {
    name = "Dish",
    price = 200,
    discount,
    isAvailable = true
} = {}) => Item.create({
    name,
    image: "i.png",
    shop: world.shopOne._id,
    category: "Others",
    price,
    foodType: "veg",
    isAvailable,
    ...(discount ? { discount } : {})
})

const lineOf = (item, shop, overrides = {}) => ({
    id: String(item._id),
    shop: String(shop._id),
    name: item.name,
    price: item.price,
    quantity: 1,
    ...overrides
})

const storedOrder = (orderId) => Order.findById(orderId)

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/order", csrfMiddleware, orderRouter)
    app.set("io", ioDouble)

    setRazorpayClientForTesting(razorpayDouble)
})

after(async () => {
    setRazorpayClientForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({})])
    razorpayDouble.ordersCreated = []
    razorpayDouble.paymentsFetchResult = null
    razorpayDouble.refundCalls = []
    razorpayOrderSequence = 0
    refundSequence = 0
})

describe("order creation uses backend-authoritative discount pricing", () => {
    test("a percentage discount is applied from MongoDB and manipulated client pricing is ignored", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const line = lineOf(item, world.shopOne, {
            price: 1,
            originalPrice: 1,
            finalPrice: 1,
            discountType: "percentage",
            discountValue: 100,
            discountAmount: 199
        })

        const res = await placeOrderVia(tokenFor(world.customer._id), [line], { totalAmount: 1 })

        assert.strictEqual(res.status, 201)
        const order = await storedOrder(res.body._id)
        const shopOrder = order.shopOrders[0]
        const storedLine = shopOrder.shopOrderItems[0]
        assert.strictEqual(shopOrder.subtotal, 180)
        assert.strictEqual(order.totalAmount, 220)
        assert.strictEqual(storedLine.price, 180)
        assert.strictEqual(storedLine.originalPrice, 200)
        assert.strictEqual(storedLine.discountType, "percentage")
        assert.strictEqual(storedLine.discountValue, 10)
        assert.strictEqual(storedLine.discountAmount, 20)
        assert.strictEqual(storedLine.finalPrice, 180)
        assert.strictEqual(storedLine.quantity, 1)
    })

    test("fixed discounts, disabled discounts and missing discounts produce the expected totals", async () => {
        const world = await seedWorld()
        const fixedItem = await makeItem(world, {
            name: "Fixed Dish",
            price: 200,
            discount: { type: "fixed", value: 30, enabled: true }
        })
        const disabledItem = await makeItem(world, {
            name: "Disabled Dish",
            price: 200,
            discount: { type: "percentage", value: 10, enabled: false }
        })
        const plainItem = await makeItem(world, { name: "Plain Dish", price: 200 })
        const token = tokenFor(world.customer._id)

        const fixedRes = await placeOrderVia(token, [lineOf(fixedItem, world.shopOne)])
        const disabledRes = await placeOrderVia(token, [lineOf(disabledItem, world.shopOne)])
        const plainRes = await placeOrderVia(token, [lineOf(plainItem, world.shopOne)])

        assert.strictEqual(fixedRes.status, 201)
        assert.strictEqual(disabledRes.status, 201)
        assert.strictEqual(plainRes.status, 201)

        const fixedOrder = await storedOrder(fixedRes.body._id)
        const disabledOrder = await storedOrder(disabledRes.body._id)
        const plainOrder = await storedOrder(plainRes.body._id)

        assert.strictEqual(fixedOrder.shopOrders[0].subtotal, 170)
        assert.strictEqual(fixedOrder.totalAmount, 210)
        assert.strictEqual(fixedOrder.shopOrders[0].shopOrderItems[0].discountType, "fixed")
        assert.strictEqual(fixedOrder.shopOrders[0].shopOrderItems[0].discountAmount, 30)

        assert.strictEqual(disabledOrder.shopOrders[0].subtotal, 200)
        assert.strictEqual(disabledOrder.totalAmount, 240)
        assert.strictEqual(disabledOrder.shopOrders[0].shopOrderItems[0].discountApplied, undefined)
        assert.strictEqual(disabledOrder.shopOrders[0].shopOrderItems[0].finalPrice, 200)

        assert.strictEqual(plainOrder.shopOrders[0].subtotal, 200)
        assert.strictEqual(plainOrder.totalAmount, 240)
        assert.strictEqual(plainOrder.shopOrders[0].shopOrderItems[0].discountType, "")
    })

    test("time-based discounts use server time and ignore promotions outside their window", async () => {
        const world = await seedWorld()
        const hour = 60 * 60 * 1000
        const beforeItem = await makeItem(world, {
            name: "Future Promo",
            price: 100,
            discount: {
                type: "percentage",
                value: 10,
                enabled: true,
                startDate: new Date(Date.now() + hour),
                endDate: new Date(Date.now() + 2 * hour)
            }
        })
        const afterItem = await makeItem(world, {
            name: "Expired Promo",
            price: 100,
            discount: {
                type: "percentage",
                value: 10,
                enabled: true,
                startDate: new Date(Date.now() - 2 * hour),
                endDate: new Date(Date.now() - hour)
            }
        })
        const activeItem = await makeItem(world, {
            name: "Active Promo",
            price: 100,
            discount: {
                type: "percentage",
                value: 10,
                enabled: true,
                startDate: new Date(Date.now() - hour),
                endDate: new Date(Date.now() + hour)
            }
        })

        const res = await placeOrderVia(tokenFor(world.customer._id), [
            lineOf(beforeItem, world.shopOne),
            lineOf(afterItem, world.shopOne),
            lineOf(activeItem, world.shopOne)
        ])

        assert.strictEqual(res.status, 201)
        const order = await storedOrder(res.body._id)
        const lines = order.shopOrders[0].shopOrderItems
        assert.strictEqual(lines.find((line) => line.name === "Future Promo").finalPrice, 100)
        assert.strictEqual(lines.find((line) => line.name === "Expired Promo").finalPrice, 100)
        assert.strictEqual(lines.find((line) => line.name === "Active Promo").finalPrice, 90)
        assert.strictEqual(order.shopOrders[0].subtotal, 290)
        assert.strictEqual(order.totalAmount, 330)
    })

    test("historical order item pricing does not change when the item is repriced", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const token = tokenFor(world.customer._id)

        const first = await placeOrderVia(token, [lineOf(item, world.shopOne)])
        assert.strictEqual(first.status, 201)

        await Item.findByIdAndUpdate(item._id, {
            $set: {
                price: 400,
                discount: { type: "percentage", value: 50, enabled: true }
            }
        })

        const originalOrder = await storedOrder(first.body._id)
        const originalLine = originalOrder.shopOrders[0].shopOrderItems[0]
        assert.strictEqual(originalOrder.shopOrders[0].subtotal, 180)
        assert.strictEqual(originalOrder.totalAmount, 220)
        assert.strictEqual(originalLine.price, 180)
        assert.strictEqual(originalLine.originalPrice, 200)
        assert.strictEqual(originalLine.discountValue, 10)
        assert.strictEqual(originalLine.discountAmount, 20)
        assert.strictEqual(originalLine.finalPrice, 180)

        const second = await placeOrderVia(token, [lineOf(item, world.shopOne)])
        assert.strictEqual(second.status, 201)
        const newOrder = await storedOrder(second.body._id)
        assert.strictEqual(newOrder.shopOrders[0].subtotal, 200)
        assert.strictEqual(newOrder.totalAmount, 240)
        assert.strictEqual(newOrder.shopOrders[0].shopOrderItems[0].finalPrice, 200)
        assert.strictEqual(newOrder.shopOrders[0].shopOrderItems[0].originalPrice, 400)
        assert.strictEqual(newOrder.shopOrders[0].shopOrderItems[0].discountAmount, 200)
    })

    test("invalid quantities are rejected without creating an order", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const token = tokenFor(world.customer._id)

        for (const quantity of [0, -1, 2.5, "1", 1000000000]) {
            const res = await placeOrderVia(token, [lineOf(item, world.shopOne, { quantity })])
            assert.strictEqual(res.status, 400, `quantity ${JSON.stringify(quantity)} must be rejected`)
            assert.strictEqual(await Order.countDocuments({}), 0)
        }
    })

    test("unavailable food cannot be ordered even when it has a discount", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            isAvailable: false,
            discount: { type: "percentage", value: 10, enabled: true }
        })

        const res = await placeOrderVia(tokenFor(world.customer._id), [lineOf(item, world.shopOne)])

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "item is not available")
        assert.strictEqual(await Order.countDocuments({}), 0)
    })
})

describe("delivery fee uses the discounted backend subtotal", () => {
    test("500 keeps the fee, 501 removes it, and a discount crossing the boundary re-applies it", async () => {
        const world = await seedWorld()
        const item500 = await makeItem(world, { name: "Item 500", price: 500 })
        const item501 = await makeItem(world, { name: "Item 501", price: 501 })
        const discounted501 = await makeItem(world, {
            name: "Discounted 501",
            price: 501,
            discount: { type: "fixed", value: 2, enabled: true }
        })
        const token = tokenFor(world.customer._id)

        const at500 = await placeOrderVia(token, [lineOf(item500, world.shopOne)])
        const at501 = await placeOrderVia(token, [lineOf(item501, world.shopOne)])
        const crossing = await placeOrderVia(token, [lineOf(discounted501, world.shopOne)])

        assert.strictEqual(at500.status, 201)
        assert.strictEqual(at501.status, 201)
        assert.strictEqual(crossing.status, 201)

        const order500 = await storedOrder(at500.body._id)
        const order501 = await storedOrder(at501.body._id)
        const orderCrossing = await storedOrder(crossing.body._id)

        assert.strictEqual(order500.shopOrders[0].subtotal, 500)
        assert.strictEqual(order500.totalAmount, 540)

        assert.strictEqual(order501.shopOrders[0].subtotal, 501)
        assert.strictEqual(order501.totalAmount, 501)

        assert.strictEqual(orderCrossing.shopOrders[0].subtotal, 499)
        assert.strictEqual(orderCrossing.totalAmount, 539)
    })
})

describe("payment authorization uses the discounted backend total", () => {
    test("Razorpay receives the discounted amount and existing signature verification still completes payment", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const token = tokenFor(world.customer._id)
        const line = lineOf(item, world.shopOne, { price: 1, quantity: 1 })

        const res = await placeOrderVia(token, [line], {
            paymentMethod: "online",
            totalAmount: 1
        })

        assert.strictEqual(res.status, 200)
        assert.ok(res.body.razorOrder?.id)
        const order = await storedOrder(res.body.orderId)
        assert.strictEqual(order.totalAmount, 220)
        assert.strictEqual(razorpayDouble.ordersCreated.at(-1).amount, 22000)
        assert.strictEqual(razorpayDouble.ordersCreated.at(-1).currency, "INR")

        razorpayDouble.paymentsFetchResult = {
            id: "pay_discount_1",
            status: "captured",
            amount: 22000,
            currency: "INR",
            order_id: res.body.razorOrder.id
        }

        const verified = await verifyPaymentVia(token, String(order._id), res.body.razorOrder.id)
        assert.strictEqual(verified.status, 200)
        const paidOrder = await storedOrder(order._id)
        assert.strictEqual(paidOrder.payment, true)
        assert.strictEqual(paidOrder.razorpayPaymentId, "pay_discount_1")
    })
})

describe("cancellation and refunds use the historical discounted amount", () => {
    test("a paid discounted order refunds the charged discounted subtotal, not the original price", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const order = await Order.create({
            user: world.customer._id,
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_discount_refund",
            deliveryAddress: { text: "12 discount road", latitude: 18.5, longitude: 73.8 },
            totalAmount: 220,
            shopOrders: [{
                shop: world.shopOne._id,
                owner: world.owner._id,
                subtotal: 180,
                status: "pending",
                shopOrderItems: [{
                    item: item._id,
                    name: item.name,
                    price: 180,
                    originalPrice: 200,
                    discountType: "percentage",
                    discountValue: 10,
                    discountAmount: 20,
                    finalPrice: 180,
                    quantity: 1
                }]
            }]
        })

        const res = await cancelVia(tokenFor(world.customer._id), String(order._id), String(order.shopOrders[0]._id))

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.shopOrder.status, "cancelled")
        assert.strictEqual(res.body.refund.status, "processed")
        assert.strictEqual(res.body.refund.amount, 180)
        assert.strictEqual(razorpayDouble.refundCalls.length, 1)
        assert.strictEqual(razorpayDouble.refundCalls[0].paymentId, "pay_discount_refund")
        assert.strictEqual(razorpayDouble.refundCalls[0].payload.amount, 18000)

        const stored = await Order.findById(order._id)
        assert.strictEqual(stored.shopOrders[0].refund.amount, 180)
        assert.strictEqual(stored.shopOrders[0].shopOrderItems[0].price, 180)
        assert.strictEqual(stored.shopOrders[0].shopOrderItems[0].originalPrice, 200)
    })

    test("COD discounted orders cancel without a refund and existing restrictions are preserved", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "fixed", value: 30, enabled: true }
        })
        const makeDiscountedOrder = (status) => Order.create({
            user: world.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 discount road", latitude: 18.5, longitude: 73.8 },
            totalAmount: 210,
            shopOrders: [{
                shop: world.shopOne._id,
                owner: world.owner._id,
                subtotal: 170,
                status,
                shopOrderItems: [{
                    item: item._id,
                    name: item.name,
                    price: 170,
                    originalPrice: 200,
                    discountType: "fixed",
                    discountValue: 30,
                    discountAmount: 30,
                    finalPrice: 170,
                    quantity: 1
                }]
            }]
        })

        const pendingOrder = await makeDiscountedOrder("pending")
        const pendingRes = await cancelVia(
            tokenFor(world.customer._id),
            String(pendingOrder._id),
            String(pendingOrder.shopOrders[0]._id)
        )

        assert.strictEqual(pendingRes.status, 200)
        assert.strictEqual(pendingRes.body.shopOrder.status, "cancelled")
        assert.strictEqual(pendingRes.body.refund.status, "not_required")
        assert.strictEqual(pendingRes.body.refund.amount, 0)
        assert.strictEqual(razorpayDouble.refundCalls.length, 0)

        const advancedOrder = await makeDiscountedOrder("out of delivery")
        const advancedRes = await cancelVia(
            tokenFor(world.customer._id),
            String(advancedOrder._id),
            String(advancedOrder.shopOrders[0]._id)
        )

        assert.strictEqual(advancedRes.status, 409)
        assert.match(advancedRes.body.message, /out for delivery or delivered/)
        const storedAdvanced = await Order.findById(advancedOrder._id)
        assert.strictEqual(storedAdvanced.shopOrders[0].status, "out of delivery")
        assert.strictEqual(razorpayDouble.refundCalls.length, 0)
    })

    test("analytics continues to use the historical charged line price for revenue", async () => {
        const world = await seedWorld()
        const item = await makeItem(world, {
            price: 200,
            discount: { type: "percentage", value: 10, enabled: true }
        })
        const order = await Order.create({
            user: world.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 discount road", latitude: 18.5, longitude: 73.8 },
            totalAmount: 220,
            shopOrders: [{
                shop: world.shopOne._id,
                owner: world.owner._id,
                subtotal: 180,
                status: "delivered",
                shopOrderItems: [{
                    item: item._id,
                    name: item.name,
                    price: 180,
                    originalPrice: 200,
                    discountType: "percentage",
                    discountValue: 10,
                    discountAmount: 20,
                    finalPrice: 180,
                    quantity: 1
                }]
            }]
        })
        assert.ok(order)

        const res = await request(app)
            .get("/api/order/analytics?period=today")
            .set("Cookie", `token=${tokenFor(world.owner._id)}`)

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.summary.revenue, 180)
        const performance = res.body.foodPerformance.find((row) => String(row.itemId) === String(item._id))
        assert.ok(performance)
        assert.strictEqual(performance.revenue, 180)
        assert.strictEqual(performance.quantitySold, 1)
    })
})
