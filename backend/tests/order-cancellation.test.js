import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_order_cancellation_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import {
    ONLINE_PAYMENT_REQUIRED_MESSAGE,
    ORDER_CANCEL_NOT_ALLOWED_MESSAGE,
    ORDER_CANCEL_REFUND_DETAILS_MESSAGE,
    ORDER_CANCEL_REFUND_FAILED_MESSAGE,
    setRazorpayClientForTesting
} from "../controllers/order.controllers.js"
import { roomForUser } from "../socket.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app
let seq = 0
let refundCalls = []
let refundMode = "success"
let emitted = []

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-order-cancellation", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const razorpayDouble = {
    payments: {
        refund: async (paymentId, payload) => {
            refundCalls.push({ paymentId, payload })
            if (refundMode === "throw") {
                throw new Error("gateway unavailable")
            }
            return {
                id: `rfnd_test_${refundCalls.length}`,
                payment_id: paymentId,
                amount: payload.amount,
                status: "processed"
            }
        }
    }
}

const ioDouble = {
    to: (room) => ({
        emit: (event, payload) => emitted.push({ room, event, payload })
    })
}

const cancelAs = (token, orderId, shopOrderId, body = {}) =>
    request(app)
        .post(`/api/order/cancel/${orderId}/${shopOrderId}`)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const uniqueSuffix = () => {
    seq += 1
    return `${Date.now()}_${seq}`
}

const seedWorld = async ({
    status = "pending",
    paymentMethod = "cod",
    payment = false,
    razorpayPaymentId = "",
    secondStatus = "preparing",
    secondPayment = null
} = {}) => {
    const suffix = uniqueSuffix()
    const ownerOne = await User.create({ fullName: "Owner One", email: `owner1_${suffix}@test.com`, mobile: "9000000001", role: "owner" })
    const ownerTwo = await User.create({ fullName: "Owner Two", email: `owner2_${suffix}@test.com`, mobile: "9000000002", role: "owner" })
    const customer = await User.create({ fullName: "Customer", email: `customer_${suffix}@test.com`, mobile: "9000000003", role: "user" })
    const attacker = await User.create({ fullName: "Attacker", email: `attacker_${suffix}@test.com`, mobile: "9000000004", role: "user" })

    const shopOne = await Shop.create({ name: "Shop One", image: "s1.png", owner: ownerOne._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shopTwo = await Shop.create({ name: "Shop Two", image: "s2.png", owner: ownerTwo._id, city: "Pune", state: "MH", address: "b", items: [] })

    const order = await Order.create({
        user: customer._id,
        paymentMethod,
        payment: secondPayment === null ? payment : secondPayment,
        razorpayPaymentId,
        deliveryAddress: { text: "12 cancellation lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: 160,
        shopOrders: [
            {
                shop: shopOne._id,
                owner: ownerOne._id,
                subtotal: 100,
                status,
                shopOrderItems: [{ item: new mongoose.Types.ObjectId(), name: "Item One", price: 100, quantity: 1 }]
            },
            {
                shop: shopTwo._id,
                owner: ownerTwo._id,
                subtotal: 60,
                status: secondStatus,
                shopOrderItems: [{ item: new mongoose.Types.ObjectId(), name: "Item Two", price: 60, quantity: 1 }]
            }
        ]
    })

    return {
        ownerOne,
        ownerTwo,
        customer,
        attacker,
        shopOne,
        shopTwo,
        order,
        shopOrderOne: order.shopOrders[0],
        shopOrderTwo: order.shopOrders[1]
    }
}

const idsFor = (world) => ({
    orderId: world.order._id.toString(),
    shopOrderId: world.shopOrderOne._id.toString(),
    secondShopOrderId: world.shopOrderTwo._id.toString()
})

const storedShopOrder = async (world, index = 0) => {
    const order = await Order.findById(world.order._id)
    return order.shopOrders[index]
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Order.init(), DeliveryAssignment.init()])

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
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
    refundCalls = []
    refundMode = "success"
    emitted = []
})

describe("customer shop-order cancellation", () => {
    test("COD cancellation only cancels the selected restaurant order", async () => {
        const world = await seedWorld()
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId, { reason: "Changed my mind" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.alreadyCancelled, false)
        assert.strictEqual(res.body.shopOrder.status, "cancelled")
        assert.strictEqual(res.body.shopOrder.cancellationReason, "Changed my mind")
        assert.strictEqual(res.body.shopOrder.refund.status, "not_required")
        assert.strictEqual(res.body.shopOrder.refund.amount, 0)
        assert.ok(res.body.shopOrder.cancelledAt)
        assert.strictEqual(String(res.body.shopOrder.cancelledBy), String(world.customer._id))
        for (const field of ["deliveryOtp", "otpExpires", "otpAttempts"]) {
            assert.ok(!(field in res.body.shopOrder), `cancellation response must not expose ${field}`)
        }

        const cancelled = await storedShopOrder(world, 0)
        const sibling = await storedShopOrder(world, 1)
        assert.strictEqual(cancelled.status, "cancelled")
        assert.strictEqual(sibling.status, "preparing")
        assert.strictEqual(sibling.assignment, null)
        assert.strictEqual(refundCalls.length, 0)

        const customerEvents = emitted.filter((entry) => entry.room === roomForUser(world.customer._id))
        const ownerEvents = emitted.filter((entry) => entry.room === roomForUser(world.ownerOne._id))
        assert.strictEqual(customerEvents.length, 1)
        assert.strictEqual(ownerEvents.length, 1)
        assert.strictEqual(customerEvents[0].event, "update-status")
        assert.strictEqual(customerEvents[0].payload.status, "cancelled")
        assert.strictEqual(customerEvents[0].payload.shopId, String(world.shopOne._id))
        assert.strictEqual(customerEvents[0].payload.ownerId, String(world.ownerOne._id))
        assert.strictEqual(emitted.filter((entry) => entry.room === roomForUser(world.ownerTwo._id)).length, 0)
    })

    test("paid online cancellation refunds only the cancelled subtotal", async () => {
        const world = await seedWorld({
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_cancel_123"
        })
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.shopOrder.status, "cancelled")
        assert.strictEqual(res.body.refund.status, "processed")
        assert.strictEqual(res.body.refund.amount, 100)
        assert.strictEqual(res.body.refund.razorpayRefundId, "rfnd_test_1")
        assert.strictEqual(refundCalls.length, 1)
        assert.strictEqual(refundCalls[0].paymentId, "pay_cancel_123")
        assert.strictEqual(refundCalls[0].payload.amount, 10000)
        assert.strictEqual(refundCalls[0].payload.notes.orderId, ids.orderId)
        assert.strictEqual(refundCalls[0].payload.notes.shopOrderId, ids.shopOrderId)

        const cancelled = await storedShopOrder(world, 0)
        const sibling = await storedShopOrder(world, 1)
        assert.strictEqual(cancelled.refund.status, "processed")
        assert.strictEqual(cancelled.refund.attempts, 1)
        assert.strictEqual(sibling.status, "preparing")
        assert.strictEqual(sibling.refund.status, "not_required")
    })

    test("unpaid online orders cannot be cancelled", async () => {
        const world = await seedWorld({ paymentMethod: "online", payment: false })
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")
        assert.strictEqual(refundCalls.length, 0)
    })

    test("paid online orders without a payment id are not cancelled", async () => {
        const world = await seedWorld({ paymentMethod: "online", payment: true, razorpayPaymentId: "" })
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, ORDER_CANCEL_REFUND_DETAILS_MESSAGE)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")
        assert.strictEqual(refundCalls.length, 0)
    })

    test("other customers and shop owners cannot cancel an order", async () => {
        const world = await seedWorld()
        const ids = idsFor(world)

        const attackerRes = await cancelAs(tokenFor(world.attacker._id), ids.orderId, ids.shopOrderId)
        const ownerRes = await cancelAs(tokenFor(world.ownerOne._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(attackerRes.status, 403)
        assert.strictEqual(ownerRes.status, 403)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")
    })

    test("unknown and malformed identifiers are rejected without side effects", async () => {
        const world = await seedWorld()
        const ids = idsFor(world)
        const missingShopOrderId = new mongoose.Types.ObjectId().toString()

        const malformed = await cancelAs(tokenFor(world.customer._id), "not-an-id", ids.shopOrderId)
        const missing = await cancelAs(tokenFor(world.customer._id), ids.orderId, missingShopOrderId)

        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(missing.status, 404)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")
    })

    test("out for delivery and delivered orders cannot be cancelled", async () => {
        for (const status of ["out of delivery", "delivered"]) {
            const world = await seedWorld({ status })
            const ids = idsFor(world)

            const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

            assert.strictEqual(res.status, 409)
            assert.strictEqual(res.body.message, ORDER_CANCEL_NOT_ALLOWED_MESSAGE)
            assert.strictEqual((await storedShopOrder(world, 0)).status, status)
        }
        assert.strictEqual(refundCalls.length, 0)
    })

    test("orders with an active delivery assignment cannot be cancelled", async () => {
        const world = await seedWorld()
        const rider = await User.create({
            fullName: "Rider",
            email: `rider_${uniqueSuffix()}@test.com`,
            mobile: "9000000005",
            role: "deliveryBoy"
        })
        await DeliveryAssignment.create({
            order: world.order._id,
            shop: world.shopOne._id,
            shopOrderId: world.shopOrderOne._id,
            brodcastedTo: [rider._id],
            status: "brodcasted"
        })
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 409)
        assert.match(res.body.message, /delivery partner/i)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")
        assert.strictEqual(refundCalls.length, 0)
    })

    test("a shop order already carrying a rider cannot be cancelled", async () => {
        const world = await seedWorld({ status: "preparing" })
        const rider = await User.create({
            fullName: "Assigned Rider",
            email: `assigned_${uniqueSuffix()}@test.com`,
            mobile: "9000000006",
            role: "deliveryBoy"
        })
        await Order.updateOne(
            { _id: world.order._id, "shopOrders._id": world.shopOrderOne._id },
            { $set: { "shopOrders.$.assignedDeliveryBoy": rider._id } }
        )
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 409)
        assert.match(res.body.message, /delivery partner/i)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "preparing")
    })

    test("duplicate cancellation is idempotent and issues at most one refund", async () => {
        const world = await seedWorld({
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_duplicate_123"
        })
        const ids = idsFor(world)

        const [first, second] = await Promise.all([
            cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId),
            cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)
        ])

        assert.strictEqual(first.status, 200)
        assert.strictEqual(second.status, 200)
        assert.strictEqual(refundCalls.length, 1)
        assert.ok([first, second].some((res) => res.body.alreadyCancelled === false))
        assert.ok([first, second].some((res) => res.body.alreadyCancelled === true))
        const stored = await storedShopOrder(world, 0)
        assert.strictEqual(stored.status, "cancelled")
        assert.strictEqual(stored.refund.status, "processed")
        assert.strictEqual(stored.refund.attempts, 1)
    })

    test("a gateway refund failure leaves the cancellation recorded for support follow-up", async () => {
        refundMode = "throw"
        const world = await seedWorld({
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_failure_123"
        })
        const ids = idsFor(world)

        const res = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.shopOrder.status, "cancelled")
        assert.strictEqual(res.body.refund.status, "failed")
        assert.strictEqual(res.body.refund.failureReason, ORDER_CANCEL_REFUND_FAILED_MESSAGE)
        assert.strictEqual(res.body.message, ORDER_CANCEL_REFUND_FAILED_MESSAGE)
        assert.strictEqual(refundCalls.length, 1)

        const stored = await storedShopOrder(world, 0)
        assert.strictEqual(stored.status, "cancelled")
        assert.strictEqual(stored.refund.status, "failed")
        assert.strictEqual(stored.refund.attempts, 1)

        const retry = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)
        assert.strictEqual(retry.status, 200)
        assert.strictEqual(retry.body.alreadyCancelled, true)
        assert.strictEqual(retry.body.refund.status, "failed")
        assert.strictEqual(refundCalls.length, 1)
    })

    test("cancellation reasons are optional but capped at 300 characters", async () => {
        const world = await seedWorld()
        const ids = idsFor(world)

        const tooLong = await cancelAs(
            tokenFor(world.customer._id),
            ids.orderId,
            ids.shopOrderId,
            { reason: "x".repeat(301) }
        )

        assert.strictEqual(tooLong.status, 400)
        assert.match(tooLong.body.message, /300/)
        assert.strictEqual((await storedShopOrder(world, 0)).status, "pending")

        const withoutReason = await cancelAs(tokenFor(world.customer._id), ids.orderId, ids.shopOrderId)
        assert.strictEqual(withoutReason.status, 200)
        assert.strictEqual((await storedShopOrder(world, 0)).cancellationReason, "")
    })

    test("cancellation is rate limited per customer", async () => {
        const world = await seedWorld()
        const ids = idsFor(world)
        const token = tokenFor(world.customer._id)
        const limit = ORDER_RATE_LIMITS.cancelOrder.limit

        for (let attempt = 0; attempt < limit; attempt += 1) {
            const res = await cancelAs(token, ids.orderId, ids.shopOrderId)
            assert.notStrictEqual(res.status, 429)
        }

        const throttled = await cancelAs(token, ids.orderId, ids.shopOrderId)
        assert.strictEqual(throttled.status, 429)
    })
})
