import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_delivery_otp_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { MAX_DELIVERY_OTP_ATTEMPTS } from "../controllers/order.controllers.js"
import { ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import { MailConfigError, setDeliveryOtpMailSenderForTesting } from "../utils/mail.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app
let sentMailCaptures

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-delivery-otp", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postDelivery = (path, token, body) =>
    request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const sendOtp = (token, body) => postDelivery("/api/order/send-delivery-otp", token, body)
const verifyOtpAs = (token, { orderId, shopOrderId, otp }) =>
    postDelivery("/api/order/verify-delivery-otp", token, { orderId, shopOrderId, otp })

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init(), DeliveryAssignment.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/order", csrfMiddleware, orderRouter)

    setDeliveryOtpMailSenderForTesting(async (user, otp) => {
        sentMailCaptures.push({ email: user.email, otp })
    })
})

after(async () => {
    setDeliveryOtpMailSenderForTesting(null)
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
    sentMailCaptures = []
})

const seedDeliveryWorld = async ({ withAssignment = true, status = "out of delivery" } = {}) => {
    const owner = await User.create({ fullName: "Shop Owner", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const owner2 = await User.create({ fullName: "Other Owner", email: `o2${Date.now()}@t.com`, mobile: "9000000004", role: "owner" })
    const customer = await User.create({ fullName: "Hungry Customer", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
    const customer2 = await User.create({ fullName: "Other Customer", email: `c2${Date.now()}@t.com`, mobile: "9000000005", role: "user" })
    const deliveryBoy = await User.create({ fullName: "Assigned Rider", email: `d${Date.now()}@t.com`, mobile: "9000000002", role: "deliveryBoy" })
    const otherDeliveryBoy = await User.create({ fullName: "Unrelated Rider", email: `d2${Date.now()}@t.com`, mobile: "9000000003", role: "deliveryBoy" })

    const shop1 = await Shop.create({ name: "Shop One", image: "s1.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shop2 = await Shop.create({ name: "Shop Two", image: "s2.png", owner: owner2._id, city: "Pune", state: "MH", address: "b", items: [] })
    const item = await Item.create({ name: "Item", image: "i.png", shop: shop1._id, category: "Others", price: 105, foodType: "veg" })

    const order = await Order.create({
        user: customer._id,
        paymentMethod: "cod",
        deliveryAddress: { text: "12 otp road", latitude: 18.5, longitude: 73.8 },
        totalAmount: 145,
        shopOrders: [{
            shop: shop1._id,
            owner: owner._id,
            status,
            subtotal: 105,
            shopOrderItems: [{ item: item._id, name: item.name, price: 105, quantity: 1 }]
        }]
    })
    const shopOrder = order.shopOrders[0]

    let assignment = null
    if (withAssignment) {
        assignment = await DeliveryAssignment.create({
            order: order._id,
            shop: shop1._id,
            shopOrderId: shopOrder._id,
            brodcastedTo: [deliveryBoy._id],
            assignedTo: deliveryBoy._id,
            acceptedAt: new Date(),
            status: "assigned"
        })
        shopOrder.assignment = assignment._id
        shopOrder.assignedDeliveryBoy = deliveryBoy._id
        await order.save()
    }

    return { owner, owner2, customer, customer2, deliveryBoy, otherDeliveryBoy, shop1, shop2, order, shopOrder, assignment }
}

const currentIds = (w) => ({
    orderId: w.order._id.toString(),
    shopOrderId: w.shopOrder._id.toString()
})

const primeOtp = async (w, { status = "out of delivery", otp = "1234" } = {}) => {
    await Order.updateOne(
        { _id: w.order._id, shopOrders: { $elemMatch: { _id: w.shopOrder._id } } },
        {
            $set: {
                "shopOrders.$.status": status,
                "shopOrders.$.deliveryOtp": otp,
                "shopOrders.$.otpExpires": new Date(Date.now() + 60 * 1000),
                "shopOrders.$.otpAttempts": 0
            }
        }
    )
    return otp
}

describe("delivery OTP endpooints (Stage 5B hardening)", () => {
    test("the assigned delivery partner starts the workflow and the OTP is never exposed", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const res = await sendOtp(tokenFor(w.deliveryBoy._id), ids)

        assert.strictEqual(res.status, 200)
        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.match(String(stored.deliveryOtp), /^\d{4}$/)
        assert.ok(stored.otpExpires > Date.now(), "OTP must expire in the future")
        assert.strictEqual(stored.otpAttempts, 0)
        assert.strictEqual(sentMailCaptures.length, 1)
        assert.strictEqual(sentMailCaptures[0].otp, stored.deliveryOtp, "mail must carry the OTP, the API must not")
        assert.ok(!res.body.message.includes(String(stored.deliveryOtp)), "the HTTP response must never contain the OTP")
        assert.ok(res.body.message.includes(w.customer.fullName))
    })

    test("mail configuration failures return a clear service unavailable response", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        setDeliveryOtpMailSenderForTesting(async () => {
            throw new MailConfigError("Email service is not configured correctly")
        })
        try {
            const res = await sendOtp(tokenFor(w.deliveryBoy._id), ids)

            assert.strictEqual(res.status, 503)
            assert.match(res.body.message, /email service/i)
        } finally {
            setDeliveryOtpMailSenderForTesting(async (user, otp) => {
                sentMailCaptures.push({ email: user.email, otp })
            })
        }
    })

    test("unauthenticated requests are rejected before any OTP state changes", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const res = await request(app)
            .post("/api/order/send-delivery-otp")
            .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send(ids)

        assert.strictEqual(res.status, 401)
        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.deliveryOtp, null)
        assert.strictEqual(sentMailCaptures.length, 0)
    })

    test("customers and shop owners are rejected", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const customerRes = await sendOtp(tokenFor(w.customer._id), ids)
        assert.strictEqual(customerRes.status, 403)

        const ownerRes = await sendOtp(tokenFor(w.owner._id), ids)
        assert.strictEqual(ownerRes.status, 403)

        assert.strictEqual(sentMailCaptures.length, 0)
    })

    test("an unrelated delivery partner receives the same generic rejection", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const res = await sendOtp(tokenFor(w.otherDeliveryBoy._id), ids)

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Only the assigned delivery partner can use delivery OTP endpoints")
        assert.strictEqual(sentMailCaptures.length, 0)
    })

    test("invalid order/shop-order combinations are rejected", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const wrongShopOrder = await sendOtp(tokenFor(w.deliveryBoy._id), {
            orderId: ids.orderId,
            shopOrderId: String(new mongoose.Types.ObjectId())
        })
        assert.strictEqual(wrongShopOrder.status, 403)

        const malformed = await sendOtp(tokenFor(w.deliveryBoy._id), { orderId: "not-an-id", shopOrderId: ids.shopOrderId })
        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(malformed.body.message, "enter valid order/shopOrderid")
    })

    test("OTP verification is refused while the order is still pending", async () => {
        const w = await seedDeliveryWorld({ status: "pending" })
        const ids = currentIds(w)
        const otp = await primeOtp(w, { status: "pending" })

        const sendRes = await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        assert.strictEqual(sendRes.status, 400)
        assert.match(sendRes.body.message, /not out for delivery/i)
        assert.strictEqual(sentMailCaptures.length, 0)

        const verifyRes = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(verifyRes.status, 400)
        assert.match(verifyRes.body.message, /not out for delivery/i)

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.status, "pending")
        assert.strictEqual(stored.deliveryOtp, otp, "a rejected stage must not consume or rotate the OTP")
        assert.strictEqual((await DeliveryAssignment.findById(w.assignment._id)).status, "assigned")
    })

    test("OTP verification is refused while the order is still preparing", async () => {
        const w = await seedDeliveryWorld({ status: "preparing" })
        const ids = currentIds(w)
        const otp = await primeOtp(w, { status: "preparing" })

        const sendRes = await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        assert.strictEqual(sendRes.status, 400)
        assert.match(sendRes.body.message, /not out for delivery/i)
        assert.strictEqual(sentMailCaptures.length, 0)

        const verifyRes = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(verifyRes.status, 400)
        assert.match(verifyRes.body.message, /not out for delivery/i)

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.status, "preparing")
        assert.strictEqual(stored.deliveryOtp, otp)
        assert.strictEqual((await DeliveryAssignment.findById(w.assignment._id)).status, "assigned")
    })

    test("a delivery partner without an assignment cannot verify an OTP", async () => {
        const w = await seedDeliveryWorld({ withAssignment: false })
        const ids = currentIds(w)
        const otp = await primeOtp(w)

        const res = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })

        assert.strictEqual(res.status, 403)
        assert.strictEqual((await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).status, "out of delivery")
    })

    test("a previously assigned rider cannot verify after the order is reassigned", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        const replacementRider = await User.create({
            fullName: "Replacement Rider",
            email: `rr${Date.now()}@t.com`,
            mobile: "9000000060",
            role: "deliveryBoy"
        })

        await DeliveryAssignment.updateOne({ _id: w.assignment._id }, { $set: { active: false } })
        const replacementAssignment = await DeliveryAssignment.create({
            order: w.order._id,
            shop: w.shop1._id,
            shopOrderId: w.shopOrder._id,
            brodcastedTo: [replacementRider._id],
            assignedTo: replacementRider._id,
            acceptedAt: new Date(),
            status: "assigned"
        })
        await Order.updateOne(
            { _id: w.order._id, shopOrders: { $elemMatch: { _id: w.shopOrder._id } } },
            {
                $set: {
                    "shopOrders.$.assignment": replacementAssignment._id,
                    "shopOrders.$.assignedDeliveryBoy": replacementRider._id
                }
            }
        )
        const otp = await primeOtp(w)

        const oldRiderRes = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(oldRiderRes.status, 403)
        assert.strictEqual((await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).status, "out of delivery")

        const newRiderRes = await verifyOtpAs(tokenFor(replacementRider._id), { ...ids, otp })
        assert.strictEqual(newRiderRes.status, 200)
        assert.strictEqual((await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).status, "delivered")
    })

    test("OTP values are never exposed in API responses", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        const sendRes = await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        assert.strictEqual(sendRes.status, 200)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp
        assert.ok(!JSON.stringify(sendRes.body).includes(String(otp)))

        const verifyRes = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(verifyRes.status, 200)
        assert.ok(!JSON.stringify(verifyRes.body).includes(String(otp)))
    })

    test("OTP sending is rate limited per delivery partner", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        const limit = ORDER_RATE_LIMITS.sendDeliveryOtp.limit

        const statuses = []
        for (let i = 0; i <= limit; i++) {
            statuses.push((await sendOtp(tokenFor(w.deliveryBoy._id), ids)).status)
        }
        assert.strictEqual(statuses.filter((s) => s === 200).length, limit)
        assert.strictEqual(statuses.at(-1), 429)
        assert.strictEqual(sentMailCaptures.length, limit)
    })

    test("incorrect OTP attempts are counted and capped before the code can be brute-forced", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp

        const statuses = []
        for (let i = 0; i < MAX_DELIVERY_OTP_ATTEMPTS; i++) {
            statuses.push((await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp: "0000" })).status)
        }
        assert.ok(statuses.every((s) => s === 400))

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.otpAttempts, MAX_DELIVERY_OTP_ATTEMPTS)

        const capped = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(capped.status, 400, "even the correct code must be refused once the attempt budget is gone")
        assert.strictEqual(capped.body.message, "Too many incorrect OTP attempts. Request a new OTP.")

        const afterCapped = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(afterCapped.status, "out of delivery", "the order must not be marked delivered by capped attempts")
    })

    test("a fresh OTP after a capped sequence restarts the attempt budget and completes delivery", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)

        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        for (let i = 0; i < MAX_DELIVERY_OTP_ATTEMPTS; i++) {
            await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp: "0000" })
        }

        const resent = await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        assert.strictEqual(resent.status, 200)
        const freshOtp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp
        assert.strictEqual((await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).otpAttempts, 0)

        const done = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp: freshOtp })
        assert.strictEqual(done.status, 200)
        assert.strictEqual(done.body.message, "Order Delivered Successfully!")
        const completed = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(completed.status, "delivered")
        assert.ok(completed.deliveredAt)
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("expired OTPs are rejected", async () => {
        const w = await seedDeliveryWorld({ withAssignment: true })
        await sendOtp(tokenFor(w.deliveryBoy._id), currentIds(w))
        const order = await Order.findById(w.order._id)
        const shopOrder = order.shopOrders.id(w.shopOrder._id)
        const expiredAt = Date.now() - 60 * 1000
        shopOrder.otpExpires = expiredAt
        shopOrder.otpAttempts = 0
        await order.save()

        const res = await verifyOtpAs(tokenFor(w.deliveryBoy._id), {
            orderId: order._id.toString(),
            shopOrderId: shopOrder._id.toString(),
            otp: shopOrder.deliveryOtp
        })

        assert.strictEqual(res.status, 400)
        const stillPending = (await Order.findById(order._id)).shopOrders.id(shopOrder._id)
        assert.strictEqual(stillPending.status, "out of delivery")
    })

    test("delivered orders refuse both OTP sending and verification", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        const order = await Order.findById(w.order._id)
        const shopOrder = order.shopOrders.id(w.shopOrder._id)
        shopOrder.status = "delivered"
        shopOrder.deliveryOtp = "1234"
        shopOrder.otpExpires = Date.now() + 5 * 60 * 1000
        await order.save()

        const sendRes = await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        assert.strictEqual(sendRes.status, 400)
        assert.ok(/already delivered/.test(sendRes.body.message))

        const verifyRes = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp: "1234" })
        assert.strictEqual(verifyRes.status, 400)
        assert.ok(/already delivered/.test(verifyRes.body.message))
        assert.strictEqual((await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).status, "delivered")
    })

    test("concurrent verifications of the same delivery complete exactly once", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp
        const sharedMessage = "Order Delivered Successfully!"

        const [r1, r2] = await Promise.all([
            verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp }),
            verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        ])
        const win = r1.status === 200 ? r1 : r2
        const lose = r1.status === 200 ? r2 : r1

        assert.strictEqual(win.status, 200)
        assert.strictEqual(win.body.message, sharedMessage)
        assert.strictEqual(lose.status, 400, "the losing request must not report a second delivery")

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.status, "delivered")
        assert.strictEqual(stored.deliveryOtp, null, "the used OTP must not stay verifiable")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("verification is refused for unauthorized callers", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp

        const customerRes = await verifyOtpAs(tokenFor(w.customer._id), { ...ids, otp })
        assert.strictEqual(customerRes.status, 403)

        const otherRes = await verifyOtpAs(tokenFor(w.otherDeliveryBoy._id), { ...ids, otp })
        assert.strictEqual(otherRes.status, 403)

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.status, "out of delivery")
    })

    test("an OTP rotated between validation and the atomic update is rejected", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp
        const rotatedOtp = otp === "9999" ? "9998" : "9999"

        const originalFindOneAndUpdate = Order.findOneAndUpdate
        let transitionAttempts = 0
        Order.findOneAndUpdate = function (filter, update, options) {
            transitionAttempts += 1
            const rotate = Order.updateOne(
                { _id: w.order._id, shopOrders: { $elemMatch: { _id: w.shopOrder._id, status: { $ne: "delivered" } } } },
                { $set: { "shopOrders.$.deliveryOtp": rotatedOtp } }
            )
            return rotate.then(() => originalFindOneAndUpdate.call(Order, filter, update, options))
        }
        try {
            const res = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
            assert.strictEqual(res.status, 400)
            assert.strictEqual(res.body.message, "Invalid/Expired Otp")
        } finally {
            Order.findOneAndUpdate = originalFindOneAndUpdate
        }

        assert.strictEqual(transitionAttempts, 1, "the guarded transition must have been evaluated once")
        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.status, "out of delivery", "delivery must not complete when the OTP rotated")
        assert.strictEqual(stored.deliveryOtp, rotatedOtp, "the rotated OTP must survive failed verification")
        assert.strictEqual(stored.otpAttempts, 0, "a rotated window must not consume the attempt budget")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 1)
    })

    test("racing incorrect attempts cannot exceed the attempt budget", async () => {
        const w = await seedDeliveryWorld()
        const ids = currentIds(w)
        await sendOtp(tokenFor(w.deliveryBoy._id), ids)
        const otp = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id).deliveryOtp

        const wrongs = await Promise.all(
            Array.from({ length: MAX_DELIVERY_OTP_ATTEMPTS * 2 }, () =>
                verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp: "0000" })
            )
        )
        assert.ok(wrongs.every((r) => r.status === 400))

        const stored = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(stored.otpAttempts, MAX_DELIVERY_OTP_ATTEMPTS, "attempt counting must stop exactly at the cap")
        assert.strictEqual(stored.status, "out of delivery", "incorrect attempts must never complete delivery")

        const correctRefused = await verifyOtpAs(tokenFor(w.deliveryBoy._id), { ...ids, otp })
        assert.strictEqual(correctRefused.status, 400)
        assert.strictEqual(correctRefused.body.message, "Too many incorrect OTP attempts. Request a new OTP.")

        const final = (await Order.findById(w.order._id)).shopOrders.id(w.shopOrder._id)
        assert.strictEqual(final.status, "out of delivery")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 1)
    })
})
