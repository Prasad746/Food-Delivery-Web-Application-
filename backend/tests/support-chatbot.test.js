import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_support_chatbot_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = "test"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Order from "../models/order.model.js"
import supportRouter from "../routes/support.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app
let seq = 0

const tokenFor = (userId) =>
    jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })

const csrfToken = () =>
    jwt.sign(
        { csrf: "cs-support-chat", purpose: "post-login" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    )

const chatAs = (token, body, { withCsrf = true } = {}) => {
    const csrf = csrfToken()
    let requestBuilder = request(app)
        .post("/api/support/chat")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", `token=${token || ""}; XSRF-TOKEN=${csrf}`)

    if (withCsrf) {
        requestBuilder = requestBuilder.set("X-XSRF-TOKEN", csrf)
    }

    return requestBuilder.send(body)
}

const uniqueSuffix = () => {
    seq += 1
    return `${Date.now()}_${seq}`
}

const createUser = async (role, name) => {
    const suffix = uniqueSuffix()
    return User.create({
        fullName: name,
        email: `${role}_${suffix}@test.com`,
        mobile: `9${String(seq).padStart(9, "0").slice(-9)}`,
        role
    })
}

const createShop = async (owner, name = "Support Shop") =>
    Shop.create({
        name,
        image: `${name.replace(/\s+/g, "-").toLowerCase()}.png`,
        owner: owner._id,
        city: "Pune",
        state: "MH",
        address: `${name} address`,
        items: []
    })

const createOrderFor = async ({
    user,
    owner,
    shop,
    status = "pending",
    paymentMethod = "cod",
    payment = false,
    razorpayPaymentId = "",
    assignedDeliveryBoy = null,
    assignment = null,
    refund = undefined,
    itemName = "Support Item",
    createdAtOffset = 0
}) => {
    const order = await Order.create({
        user: user._id,
        paymentMethod,
        payment,
        razorpayPaymentId,
        deliveryAddress: {
            text: "Secret customer address",
            latitude: 18.5,
            longitude: 73.8
        },
        totalAmount: 140,
        shopOrders: [
            {
                shop: shop._id,
                owner: owner._id,
                subtotal: 100,
                status,
                assignment,
                assignedDeliveryBoy,
                deliveryOtp: "123456",
                otpExpires: new Date(Date.now() + 10 * 60 * 1000),
                otpAttempts: 1,
                shopOrderItems: [
                    {
                        item: new mongoose.Types.ObjectId(),
                        name: itemName,
                        price: 100,
                        quantity: 1
                    }
                ],
                ...(refund ? { refund } : {})
            }
        ]
    })

    if (createdAtOffset) {
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() + createdAtOffset) } }
        )
    }

    return order
}

const seedWorld = async () => {
    const owner = await createUser("owner", "Support Owner")
    const customer = await createUser("user", "Support Customer")
    const attacker = await createUser("user", "Support Attacker")
    const rider = await createUser("deliveryBoy", "Support Rider")
    const shop = await createShop(owner)
    return { owner, customer, attacker, rider, shop }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Order.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/support", csrfMiddleware, supportRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Order.deleteMany({})])
})

describe("support chat authentication and validation", () => {
    test("rejects unauthenticated requests", async () => {
        const res = await chatAs(null, { message: "hello" })

        assert.strictEqual(res.status, 401)
        assert.match(res.body.message, /Authentication token required/)
    })

    test("requires a valid CSRF token", async () => {
        const customer = await createUser("user", "CSRF Customer")
        const res = await chatAs(tokenFor(customer._id), { message: "hello" }, { withCsrf: false })

        assert.strictEqual(res.status, 403)
        assert.match(res.body.message, /Missing CSRF token/)
    })

    test("rejects owner, delivery partner, and admin accounts", async () => {
        const owner = await createUser("owner", "Role Owner")
        const rider = await createUser("deliveryBoy", "Role Rider")
        const admin = await createUser("admin", "Role Admin")

        for (const user of [owner, rider, admin]) {
            const res = await chatAs(tokenFor(user._id), { message: "hello" })
            assert.strictEqual(res.status, 403)
            assert.match(res.body.message, /customer accounts only/)
        }
    })

    test("validates message and order context inputs", async () => {
        const customer = await createUser("user", "Validation Customer")
        const token = tokenFor(customer._id)

        for (const body of [
            {},
            { message: "" },
            { message: "   " },
            { message: 42 },
            { message: "hello", orderId: "not-an-order-id" },
            { message: "hello", unexpected: true }
        ]) {
            const res = await chatAs(token, body)
            assert.strictEqual(res.status, 400, JSON.stringify(body))
            assert.strictEqual(res.body.success, false)
            assert.strictEqual(typeof res.body.message, "string")
        }

        const boundary = await chatAs(token, { message: "a".repeat(500) })
        assert.strictEqual(boundary.status, 200)

        const tooLong = await chatAs(token, { message: "a".repeat(501) })
        assert.strictEqual(tooLong.status, 400)
        assert.match(tooLong.body.message, /500 characters or fewer/)
    })
})

describe("support chat FAQ and fallback guidance", () => {
    test("answers payment method questions from account policy", async () => {
        const customer = await createUser("user", "Payment FAQ Customer")
        const res = await chatAs(tokenFor(customer._id), {
            message: "What payment methods are available?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "faq_payment_methods")
        assert.match(res.body.reply, /Cash on Delivery/)
        assert.match(res.body.reply, /Razorpay/)
        assert.ok(Array.isArray(res.body.quickReplies))
        assert.ok(res.body.quickReplies.length > 0)
        assert.ok(Array.isArray(res.body.links))
        assert.strictEqual(res.body.data, undefined)
    })

    test("answers delivery, account, and navigation FAQs with actual app behavior", async () => {
        const customer = await createUser("user", "FAQ Customer")
        const token = tokenFor(customer._id)

        const delivery = await chatAs(token, { message: "What is the delivery fee?" })
        assert.strictEqual(delivery.body.intent, "faq_delivery")
        assert.match(delivery.body.reply, /₹40/)
        assert.match(delivery.body.reply, /₹500/)
        assert.match(delivery.body.reply, /guaranteed delivery-time estimate/)

        const account = await chatAs(token, { message: "Can I change my profile?" })
        assert.strictEqual(account.body.intent, "faq_account")
        assert.match(account.body.reply, /does not provide a profile page/)
        assert.match(account.body.reply, /Forgot Password/)

        const navigation = await chatAs(token, {
            message: "How do I find food and use the website?"
        })
        assert.strictEqual(navigation.body.intent, "faq_navigation")
        assert.match(navigation.body.reply, /header search/)
        assert.match(navigation.body.reply, /restaurant cards/)

        const address = await chatAs(token, {
            message: "How do I change my delivery address?"
        })
        assert.strictEqual(address.body.intent, "faq_delivery_address")
        assert.match(address.body.reply, /checkout page/)
        assert.match(address.body.reply, /order-editing flow/)
    })

    test("greets customers and safely handles unknown questions", async () => {
        const customer = await createUser("user", "Fallback Customer")
        const token = tokenFor(customer._id)

        const greeting = await chatAs(token, { message: "Hello" })
        assert.strictEqual(greeting.body.intent, "greeting")
        assert.match(greeting.body.reply, /order status and tracking/)

        const unknown = await chatAs(token, {
            message: "Can you recommend a good movie for tonight?"
        })
        assert.strictEqual(unknown.body.intent, "unknown")
        assert.match(unknown.body.reply, /don't have information/)
        assert.strictEqual(unknown.body.data, undefined)
    })
})

describe("support chat order status and ownership", () => {
    test("returns the customer's latest order with safe tracking details", async () => {
        const { owner, customer, shop } = await seedWorld()
        const older = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "delivered",
            itemName: "Older Item",
            createdAtOffset: -60 * 60 * 1000
        })
        const latest = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "preparing",
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_secret_support",
            itemName: "Latest Item"
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: "Where is my latest order?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "order_status")
        assert.match(res.body.reply, /Your latest order/)
        assert.match(res.body.reply, new RegExp(latest._id.toString().slice(-6)))
        assert.match(res.body.reply, /preparing/)
        assert.match(res.body.reply, /online payment confirmed/)
        assert.match(res.body.reply, /No delivery partner is assigned yet/)
        assert.strictEqual(res.body.data.order.reference, latest._id.toString().slice(-6))
        assert.notStrictEqual(
            res.body.data.order.reference,
            older._id.toString().slice(-6)
        )
        assert.strictEqual(
            res.body.data.order.trackingPath,
            `/track-order/${latest._id}`
        )
        assert.strictEqual(res.body.data.order.shopOrders[0].status, "preparing")

        const serialized = JSON.stringify(res.body)
        for (const secret of [
            "pay_secret_support",
            "123456",
            "Secret customer address",
            "deliveryOtp",
            "otpExpires",
            "razorpayPaymentId",
            "razorpayOrderId"
        ]) {
            assert.ok(!serialized.includes(secret), `response must not expose ${secret}`)
        }
        assert.ok(!("user" in res.body.data.order))
        assert.ok(!("deliveryAddress" in res.body.data.order))

        const stored = await Order.findById(latest._id)
        assert.strictEqual(stored.shopOrders[0].status, "preparing")
        assert.strictEqual(stored.payment, true)
    })

    test("looks up an explicit owned order by full id", async () => {
        const { owner, customer, shop } = await seedWorld()
        const target = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "out of delivery"
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: `What is the status of order ${target._id}?`
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "order_status")
        assert.strictEqual(res.body.data.order.reference, target._id.toString().slice(-6))
        assert.match(res.body.reply, /out of delivery/)
    })

    test("does not expose another customer's order by full id or short reference", async () => {
        const { owner, customer, attacker, shop } = await seedWorld()
        await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "delivered",
            itemName: "Customer Item"
        })
        const foreign = await createOrderFor({
            user: attacker,
            owner,
            shop,
            status: "preparing",
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_foreign_secret",
            itemName: "Foreign Secret Item"
        })

        for (const message of [
            `Where is order ${foreign._id}?`,
            `Track order #${foreign._id.toString().slice(-6)}`
        ]) {
            const res = await chatAs(tokenFor(customer._id), { message })
            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.body.intent, "order_status")
            assert.strictEqual(res.body.data.order, null)
            assert.match(res.body.reply, /couldn't find/)
            assert.ok(!res.body.reply.includes("Foreign Secret Item"))
            assert.ok(!JSON.stringify(res.body).includes("pay_foreign_secret"))
        }
    })

    test("uses an owned context order but falls back safely for a foreign context", async () => {
        const { owner, customer, attacker, shop } = await seedWorld()
        const older = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "pending",
            createdAtOffset: -60 * 60 * 1000
        })
        const latest = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "delivered"
        })
        const foreign = await createOrderFor({
            user: attacker,
            owner,
            shop,
            status: "preparing"
        })
        const token = tokenFor(customer._id)

        const ownedContext = await chatAs(token, {
            message: "What is my order status?",
            orderId: older._id.toString()
        })
        assert.strictEqual(ownedContext.body.data.order.reference, older._id.toString().slice(-6))
        assert.match(ownedContext.body.reply, /pending/)

        const foreignContext = await chatAs(token, {
            message: "What is my order status?",
            orderId: foreign._id.toString()
        })
        assert.strictEqual(
            foreignContext.body.data.order.reference,
            latest._id.toString().slice(-6)
        )
        assert.strictEqual(foreignContext.body.data.order.shopOrders[0].status, "delivered")
    })

    test("handles customers with no orders without fabricating one", async () => {
        const customer = await createUser("user", "No Orders Customer")
        const token = tokenFor(customer._id)

        for (const message of ["Where is my order?", "Where is my food?"]) {
            const res = await chatAs(token, { message })
            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.body.intent, "order_status")
            assert.strictEqual(res.body.data.order, null)
            assert.match(res.body.reply, /don't have any orders/)
        }
    })

    test("reports multiple restaurant statuses in one order", async () => {
        const { owner, customer, shop } = await seedWorld()
        const secondShop = await createShop(owner, "Second Support Shop")
        const order = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "pending",
            itemName: "First Restaurant Item"
        })

        order.shopOrders.push({
            shop: secondShop._id,
            owner: owner._id,
            subtotal: 80,
            status: "out of delivery",
            shopOrderItems: [
                {
                    item: new mongoose.Types.ObjectId(),
                    name: "Second Restaurant Item",
                    price: 80,
                    quantity: 1
                }
            ]
        })
        await order.save()

        const res = await chatAs(tokenFor(customer._id), {
            message: "What is my latest order status?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.data.order.shopOrders.length, 2)
        assert.match(res.body.reply, /Support Shop: pending/)
        assert.match(res.body.reply, /Second Support Shop: out of delivery/)
    })
})

describe("support chat cancellation guidance", () => {
    test("explains the actual cancellation policy and eligible order without changing it", async () => {
        const { owner, customer, shop } = await seedWorld()
        const order = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "pending",
            paymentMethod: "online",
            payment: true
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: "How do I cancel my order?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "cancellation_info")
        assert.match(res.body.reply, /pending or preparing/)
        assert.match(res.body.reply, /delivery partner is assigned/)
        assert.match(res.body.reply, /restaurant subtotal/)
        assert.match(res.body.reply, /chatbot cannot change or refund/)
        assert.match(res.body.reply, /Support Shop/)
        assert.strictEqual(res.body.data.order.canCancel, true)

        const stored = await Order.findById(order._id)
        assert.strictEqual(stored.shopOrders[0].status, "pending")
        assert.strictEqual(stored.shopOrders[0].refund.status, "not_required")
    })

    test("explains when rider assignment or current status blocks cancellation", async () => {
        const { owner, customer, shop, rider } = await seedWorld()
        const assigned = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "pending",
            assignment: new mongoose.Types.ObjectId(),
            assignedDeliveryBoy: rider._id
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: "Can I cancel my order?"
        })

        assert.strictEqual(res.status, 200)
        assert.match(res.body.reply, /no restaurant part is currently eligible/)
        assert.match(res.body.reply, /pending/)
        assert.strictEqual(res.body.data.order.canCancel, false)

        const stored = await Order.findById(assigned._id)
        assert.strictEqual(stored.shopOrders[0].status, "pending")
    })

    test("gives the cancellation policy when the customer has no order", async () => {
        const customer = await createUser("user", "No Cancel Order Customer")
        const token = tokenFor(customer._id)

        for (const message of [
            "What is the cancellation policy?",
            "Do you offer refunds?"
        ]) {
            const res = await chatAs(token, { message })
            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.body.intent, "cancellation_info")
            assert.strictEqual(res.body.data.order, null)
            assert.match(res.body.reply, /don't have any orders/)
            assert.match(res.body.reply, /restaurant subtotal/)
        }
    })
})

describe("support chat payment guidance", () => {
    test("reports Cash on Delivery without inventing an online payment", async () => {
        const { owner, customer, shop } = await seedWorld()
        await createOrderFor({ user: customer, owner, shop, paymentMethod: "cod" })

        const res = await chatAs(tokenFor(customer._id), {
            message: "What is my payment status?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "payment_status")
        assert.strictEqual(res.body.data.order.paymentStatus, "cash_on_delivery")
        assert.match(res.body.reply, /Cash on Delivery/)
        assert.match(res.body.reply, /chatbot cannot initiate a payment or refund/)
    })

    test("does not claim an unverified online payment succeeded", async () => {
        const { owner, customer, shop } = await seedWorld()
        await createOrderFor({
            user: customer,
            owner,
            shop,
            paymentMethod: "online",
            payment: false,
            razorpayPaymentId: "pay_unconfirmed_secret"
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: "Did my online payment fail?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "payment_status")
        assert.strictEqual(res.body.data.order.paymentStatus, "not_confirmed")
        assert.match(res.body.reply, /does not have a confirmed online payment/)
        assert.ok(!JSON.stringify(res.body).includes("pay_unconfirmed_secret"))
    })

    test("reports verified online payment and refund status without gateway ids", async () => {
        const { owner, customer, shop } = await seedWorld()
        const order = await createOrderFor({
            user: customer,
            owner,
            shop,
            status: "cancelled",
            paymentMethod: "online",
            payment: true,
            razorpayPaymentId: "pay_confirmed_secret",
            refund: {
                status: "processed",
                amount: 60,
                razorpayRefundId: "rfnd_secret_support"
            }
        })

        const res = await chatAs(tokenFor(customer._id), {
            message: "What is my refund status?"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.intent, "payment_status")
        assert.strictEqual(res.body.data.order.paymentStatus, "confirmed")
        assert.match(res.body.reply, /confirmed online payment/)
        assert.match(res.body.reply, /refund status processed/)
        assert.match(res.body.reply, /₹60/)
        assert.strictEqual(res.body.data.order.shopOrders[0].refund.status, "processed")
        assert.strictEqual(res.body.data.order.shopOrders[0].refund.amount, 60)

        const serialized = JSON.stringify(res.body)
        assert.ok(!serialized.includes("pay_confirmed_secret"))
        assert.ok(!serialized.includes("rfnd_secret_support"))
        assert.ok(!serialized.includes("razorpayRefundId"))

        const stored = await Order.findById(order._id)
        assert.strictEqual(stored.shopOrders[0].refund.status, "processed")
        assert.strictEqual(stored.razorpayPaymentId, "pay_confirmed_secret")
    })

    test("gives payment guidance when there is no order", async () => {
        const customer = await createUser("user", "No Payment Order Customer")
        const token = tokenFor(customer._id)

        for (const message of ["What is my payment status?", "Where is my refund?"]) {
            const res = await chatAs(token, { message })
            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.body.intent, "payment_status")
            assert.strictEqual(res.body.data.order, null)
            assert.match(res.body.reply, /no payment record/)
        }
    })
})
