import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_order_status_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import { ONLINE_PAYMENT_REQUIRED_MESSAGE } from "../controllers/order.controllers.js"
import { setDeliveryOtpMailSenderForTesting } from "../utils/mail.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app
let sentMailCaptures

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-order-status", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const postStatus = (whichToken, orderId, shopId, status, extra = {}) =>
    request(app)
        .post(`/api/order/update-status/${orderId}/${shopId}`)
        .set("Cookie", `token=${whichToken}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send({ status, ...extra })

const apiPost = (path, token, body = {}) =>
    request(app)
        .post(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)
        .send(body)

const apiGet = (path, token) =>
    request(app)
        .get(path)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)

const acceptAs = (token, assignmentId, extra = {}) =>
    apiPost(`/api/order/accept-order/${assignmentId}`, token, extra)

const sendOtpAs = (token, body) => apiPost("/api/order/send-delivery-otp", token, body)

const verifyOtpAs = (token, body) => apiPost("/api/order/verify-delivery-otp", token, body)

const dummyItemId = () => new mongoose.Types.ObjectId().toString()

const RIDER_NEAR = [73.8, 18.5]
const RIDER_FAR = [73.8, 13.92]

const seedWorld = async ({
    status = "pending",
    nearBoys = 0,
    farBoys = 0,
    paymentMethod = "cod",
    payment = false
} = {}) => {
    const owner = await User.create({ fullName: "Owner", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const customer = await User.create({ fullName: "Customer", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
    const riders = []
    for (let i = 0; i < nearBoys + farBoys; i++) {
        const rider = await User.create({
            fullName: `Rider ${i}`,
            email: `r${i}${Date.now()}@t.com`,
            mobile: `900000002${i}`,
            role: "deliveryBoy",
            location: {
                type: "Point",
                coordinates: i < nearBoys ? RIDER_NEAR : RIDER_FAR
            }
        })
        riders.push(rider)
    }
    const shop = await Shop.create({ name: "Shop One", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const order = await Order.create({
        user: customer._id,
        paymentMethod,
        payment,
        deliveryAddress: { text: "12 status lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: 160,
        shopOrders: [{
            shop: shop._id,
            owner: owner._id,
            status,
            subtotal: 120,
            shopOrderItems: [{ item: dummyItemId(), name: "Bread", price: 120, quantity: 1 }]
        }]
    })
    return { owner, customer, riders, shop, order, shopOrder: order.shopOrders[0] }
}

const idsFor = (w) => ({
    orderId: w.order._id.toString(),
    shopId: w.shop._id.toString(),
    shopOrderId: w.shopOrder._id.toString()
})

const storedShopOrder = (w) =>
    Order.findById(w.order._id).then((doc) => doc.shopOrders.id(w.shopOrder._id))

const attachAssignment = async (w, rider, { status = "brodcasted", assigned = false } = {}) => {
    const assignment = await DeliveryAssignment.create({
        order: w.order._id,
        shop: w.shop._id,
        shopOrderId: w.shopOrder._id,
        brodcastedTo: [rider._id],
        assignedTo: assigned ? rider._id : null,
        status,
        acceptedAt: assigned ? new Date() : undefined
    })
    if (assigned) {
        await Order.updateOne(
            { _id: w.order._id, "shopOrders._id": w.shopOrder._id },
            { $set: { "shopOrders.$.assignedDeliveryBoy": rider._id, "shopOrders.$.assignment": assignment._id } }
        )
    }
    return assignment
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Order.init(), DeliveryAssignment.init()])

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
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
    sentMailCaptures = []
})

describe("owner-side order status transitions (Stage 6A)", () => {
    test("a shop owner cannot mark an order delivered directly", async () => {
        const w = await seedWorld({ status: "preparing" })
        const ids = idsFor(w)

        const res = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "delivered")

        assert.strictEqual(res.status, 400)
        assert.match(res.body.message, /delivered/i)
        assert.strictEqual((await storedShopOrder(w)).status, "preparing")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)

        await Order.updateOne(
            { _id: w.order._id, shopOrders: { $elemMatch: { _id: w.shopOrder._id } } },
            { $set: { "shopOrders.$.status": "delivered" } }
        )
        const resAfter = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "preparing")
        assert.strictEqual(resAfter.status, 409)
        assert.strictEqual((await storedShopOrder(w)).status, "delivered")
    })

    test("valid owner transitions still work", async () => {
        const w = await seedWorld({ status: "pending" })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const toPreparing = await postStatus(ownerToken, ids.orderId, ids.shopId, "preparing")
        assert.strictEqual(toPreparing.status, 200)
        assert.strictEqual((await storedShopOrder(w)).status, "preparing")

        const backToPending = await postStatus(ownerToken, ids.orderId, ids.shopId, "pending")
        assert.strictEqual(backToPending.status, 409, "an order must not move backward from preparing to pending")
        assert.strictEqual((await storedShopOrder(w)).status, "preparing")

        const jump = await seedWorld({ status: "pending" })

        const crossOwner = await postStatus(ownerToken, jump.order._id.toString(), jump.shop._id.toString(), "preparing")
        assert.strictEqual(crossOwner.status, 403)
        assert.strictEqual(crossOwner.body.message, "You are not the owner of this shop")

        const jumpRes = await postStatus(tokenFor(jump.owner._id), jump.order._id.toString(), jump.shop._id.toString(), "out of delivery")
        assert.strictEqual(jumpRes.status, 200)
        assert.strictEqual(jumpRes.body.message, "order status updated but there is no available delivery boys")
        assert.strictEqual((await storedShopOrder(jump)).status, "out of delivery")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("preparing cannot regress to pending", async () => {
        const w = await seedWorld({ status: "preparing" })
        const ids = idsFor(w)

        const res = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "pending")

        assert.strictEqual(res.status, 409)
        assert.strictEqual((await storedShopOrder(w)).status, "preparing")
    })

    test("out of delivery cannot regress to pending while the rider assignment is active", async () => {
        const w = await seedWorld({ status: "out of delivery" })
        const ids = idsFor(w)
        const rider = await User.create({
            fullName: "Assigned Rider",
            email: `ar${Date.now()}@t.com`,
            mobile: "9000000050",
            role: "deliveryBoy"
        })
        const assignment = await attachAssignment(w, rider, { status: "assigned", assigned: true })

        const res = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "pending")

        assert.strictEqual(res.status, 409)
        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "out of delivery")
        assert.strictEqual(String(stored.assignedDeliveryBoy), String(rider._id))
        assert.strictEqual(String(stored.assignment), String(assignment._id))
        assert.strictEqual((await DeliveryAssignment.findById(assignment._id)).status, "assigned")
    })

    test("out of delivery cannot regress to preparing while the rider assignment is active", async () => {
        const w = await seedWorld({ status: "out of delivery" })
        const ids = idsFor(w)
        const rider = await User.create({
            fullName: "Assigned Rider Two",
            email: `ar2${Date.now()}@t.com`,
            mobile: "9000000051",
            role: "deliveryBoy"
        })
        const assignment = await attachAssignment(w, rider, { status: "assigned", assigned: true })

        const res = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "preparing")

        assert.strictEqual(res.status, 409)
        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "out of delivery")
        assert.strictEqual(String(stored.assignedDeliveryBoy), String(rider._id))
        assert.strictEqual(String(stored.assignment), String(assignment._id))
        assert.strictEqual((await DeliveryAssignment.findById(assignment._id)).status, "assigned")
    })

    test("an order already out of delivery cannot be moved backward even without an active assignment", async () => {
        const w = await seedWorld({ status: "out of delivery" })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        for (const backwards of ["pending", "preparing"]) {
            const res = await postStatus(ownerToken, ids.orderId, ids.shopId, backwards)
            assert.strictEqual(res.status, 409, `${backwards} must be rejected after out of delivery`)
            assert.strictEqual((await storedShopOrder(w)).status, "out of delivery")
        }
    })

    test("concurrent status updates cannot move an order backward", async () => {
        const w = await seedWorld({ status: "pending", nearBoys: 1 })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const [toPreparing, toOutOfDelivery] = await Promise.all([
            postStatus(ownerToken, ids.orderId, ids.shopId, "preparing"),
            postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery")
        ])

        assert.ok([200, 409].includes(toPreparing.status))
        assert.strictEqual(toOutOfDelivery.status, 200)
        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "out of delivery", "concurrent updates must settle on the furthest valid lifecycle stage")

        const assignments = await DeliveryAssignment.find({ shopOrderId: w.shopOrder._id })
        assert.strictEqual(assignments.length, 1)
        assert.strictEqual(assignments[0].status, "brodcasted")
        assert.strictEqual(String(stored.assignment), String(assignments[0]._id))
    })

    test("invalid status values are rejected with 400", async () => {
        const w = await seedWorld({ status: "pending" })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        for (const invalid of ["cancelled", "delivered soon", "DELIVERED", "", undefined]) {
            const res = await postStatus(ownerToken, ids.orderId, ids.shopId, invalid)
            assert.strictEqual(res.status, 400, `status ${invalid} must be rejected`)
            assert.match(res.body.message, /invalid status/i)
        }
        assert.strictEqual((await storedShopOrder(w)).status, "pending")

        const duplicate = await postStatus(ownerToken, ids.orderId, ids.shopId, "pending")
        assert.strictEqual(duplicate.status, 200, "idempotent re-send of the current status stays allowed")
        assert.strictEqual((await storedShopOrder(w)).status, "pending")
    })

    test("unauthorized users cannot change order status", async () => {
        const w = await seedWorld({ status: "pending" })
        const ids = idsFor(w)

        const customerRes = await postStatus(tokenFor(w.customer._id), ids.orderId, ids.shopId, "preparing")
        assert.strictEqual(customerRes.status, 403)
        assert.strictEqual(customerRes.body.message, "You are not the owner of this shop")

        const danglingShopId = new mongoose.Types.ObjectId()
        const dangling = await Order.create({
            user: w.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 status lane", latitude: 18.5, longitude: 73.8 },
            totalAmount: 90,
            shopOrders: [{ shop: danglingShopId, owner: w.owner._id, status: "pending", subtotal: 90, shopOrderItems: [{ item: dummyItemId(), name: "Chips", price: 90, quantity: 1 }] }]
        })
        const danglingRes = await postStatus(tokenFor(w.owner._id), dangling._id.toString(), danglingShopId.toString(), "preparing")
        assert.strictEqual(danglingRes.status, 403)
        assert.match(danglingRes.body.message, /unauthorized/i)

        const otherOwner = await User.create({ fullName: "Other Owner", email: `oo${Date.now()}@t.com`, mobile: "9000000040", role: "owner" })
        await Shop.create({ name: "Shop Two", image: "s2.png", owner: otherOwner._id, city: "Pune", state: "MH", address: "b", items: [] })
        const otherRes = await postStatus(tokenFor(otherOwner._id), ids.orderId, ids.shopId, "preparing")
        assert.strictEqual(otherRes.status, 403)
        assert.strictEqual(otherRes.body.message, "You are not the owner of this shop")

        const anon = await request(app)
            .post(`/api/order/update-status/${ids.orderId}/${ids.shopId}`)
            .set("Cookie", `XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send({ status: "preparing" })
        assert.strictEqual(anon.status, 401)

        assert.strictEqual((await storedShopOrder(w)).status, "pending")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("two concurrent owner requests create exactly one broadcast assignment", async () => {
        const w = await seedWorld({ status: "preparing", nearBoys: 3 })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const [r1, r2] = await Promise.all([
            postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery"),
            postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery")
        ])

        assert.strictEqual(r1.status, 200)
        assert.strictEqual(r2.status, 200)

        const assignments = await DeliveryAssignment.find({})
        assert.strictEqual(assignments.length, 1, "exactly one open broadcast assignment must exist")

        const broadcast = assignments[0]
        assert.strictEqual(String(broadcast.shopOrderId), ids.shopOrderId)
        assert.strictEqual(broadcast.status, "brodcasted")
        assert.deepStrictEqual(
            [...new Set(broadcast.brodcastedTo.map(id => String(id)))].sort(),
            w.riders.map(r => String(r._id)).sort()
        )
        assert.ok(r1.body.assignment, "the response must reference the broadcast assignment")
        assert.strictEqual(String(broadcast._id), String(r1.body.assignment))
        assert.strictEqual(String(broadcast._id), String(r2.body.assignment))

        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "out of delivery")
        assert.strictEqual(stored.assignment.toString(), String(broadcast._id))
    })

    test("different shop orders still receive their own assignments", async () => {
        const w = await seedWorld({ status: "preparing", nearBoys: 2 })
        const ownerToken = tokenFor(w.owner._id)
        const shop2 = await Shop.create({ name: "Shop Two", image: "s2.png", owner: w.owner._id, city: "Pune", state: "MH", address: "b", items: [] })
        const other = await Order.create({
            user: w.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 status lane", latitude: 18.5, longitude: 73.8 },
            totalAmount: 130,
            shopOrders: [{
                shop: shop2._id,
                owner: w.owner._id,
                status: "preparing",
                subtotal: 130,
                shopOrderItems: [{ item: dummyItemId(), name: "Cake", price: 130, quantity: 1 }]
            }]
        })

        const [first, second] = await Promise.all([
            postStatus(ownerToken, w.order._id.toString(), w.shop._id.toString(), "out of delivery"),
            postStatus(ownerToken, other._id.toString(), shop2._id.toString(), "out of delivery")
        ])

        assert.strictEqual(first.status, 200)
        assert.strictEqual(second.status, 200)

        const assignments = await DeliveryAssignment.find({})
        assert.strictEqual(assignments.length, 2)
        assert.strictEqual(new Set(assignments.map(a => String(a.shopOrderId))).size, 2)
        assert.strictEqual(new Set(assignments.map(a => String(a._id))).size, 2)

        const combined = await Order.create({
            user: w.customer._id,
            paymentMethod: "cod",
            deliveryAddress: { text: "12 status lane", latitude: 18.5, longitude: 73.8 },
            totalAmount: 250,
            shopOrders: [
                { shop: w.shop._id, owner: w.owner._id, status: "preparing", subtotal: 100, shopOrderItems: [{ item: dummyItemId(), name: "Dosa", price: 100, quantity: 1 }] },
                { shop: shop2._id, owner: w.owner._id, status: "pending", subtotal: 150, shopOrderItems: [{ item: dummyItemId(), name: "Pasta", price: 150, quantity: 1 }] }
            ]
        })
        const combinedRes = await postStatus(ownerToken, combined._id.toString(), w.shop._id.toString(), "out of delivery")
        assert.strictEqual(combinedRes.status, 200)
        const combinedSecond = (await Order.findById(combined._id)).shopOrders.id(combined.shopOrders[1]._id)
        assert.strictEqual(combinedSecond.status, "pending", "the untouched sibling shop order keeps its status")
    })

    test("delivery partner claim and OTP verification workflow still works", async () => {
        const w = await seedWorld({ status: "preparing", nearBoys: 1 })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const broadcastRes = await postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery")
        assert.strictEqual(broadcastRes.status, 200)
        assert.strictEqual(broadcastRes.body.availableBoys, undefined, "rider identity and location must not be returned to owners")

        const broadcast = await DeliveryAssignment.findOne({})
        assert.ok(broadcast)
        assert.strictEqual(broadcast.status, "brodcasted")

        const riderToken = tokenFor(w.riders[0]._id)
        const acceptRes = await request(app)
            .post(`/api/order/accept-order/${broadcast._id.toString()}`)
            .set("Cookie", `token=${riderToken}; XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
        assert.strictEqual(acceptRes.status, 200)
        assert.strictEqual(acceptRes.body.message, "order accepted")

        const claimed = await DeliveryAssignment.findById(broadcast._id)
        assert.strictEqual(claimed.status, "assigned")
        assert.strictEqual(String(claimed.assignedTo), String(w.riders[0]._id))

        const sendRes = await request(app)
            .post("/api/order/send-delivery-otp")
            .set("Cookie", `token=${riderToken}; XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send({ orderId: ids.orderId, shopOrderId: ids.shopOrderId })
        assert.strictEqual(sendRes.status, 200)
        assert.ok(sentMailCaptures.length > 0, "the OTP is delivered through the mail channel")
        const otp = sentMailCaptures[sentMailCaptures.length - 1].otp

        const verifyRes = await request(app)
            .post("/api/order/verify-delivery-otp")
            .set("Cookie", `token=${riderToken}; XSRF-TOKEN=${csrfToken()}`)
            .set("X-XSRF-TOKEN", csrfToken())
            .set("Origin", TRUSTED_ORIGIN)
            .send({ orderId: ids.orderId, shopOrderId: ids.shopOrderId, otp })
        assert.strictEqual(verifyRes.status, 200)

        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "delivered")
        assert.ok(stored.deliveredAt)
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0, "verified delivery drops the open assignment")
    })
})

describe("online payment gate before fulfillment (Stage 7A.2)", () => {
    test("an unpaid online order cannot advance status or create an assignment", async () => {
        const w = await seedWorld({
            status: "pending",
            nearBoys: 1,
            paymentMethod: "online",
            payment: false
        })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const toPreparing = await postStatus(ownerToken, ids.orderId, ids.shopId, "preparing", {
            payment: true,
            paymentMethod: "cod",
            status: "preparing"
        })
        assert.strictEqual(toPreparing.status, 400)
        assert.strictEqual(toPreparing.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)
        assert.strictEqual((await storedShopOrder(w)).status, "pending")

        const toOutOfDelivery = await postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery", {
            payment: true
        })
        assert.strictEqual(toOutOfDelivery.status, 400)
        assert.strictEqual(toOutOfDelivery.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)

        const storedOrder = await Order.findById(w.order._id)
        assert.strictEqual(storedOrder.payment, false)
        assert.strictEqual(storedOrder.paymentMethod, "online")
        assert.strictEqual((await storedShopOrder(w)).status, "pending")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("a properly paid online order can complete the full fulfillment workflow", async () => {
        const w = await seedWorld({
            status: "preparing",
            nearBoys: 1,
            paymentMethod: "online",
            payment: true
        })
        const ids = idsFor(w)
        const riderToken = tokenFor(w.riders[0]._id)

        const broadcastRes = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "out of delivery")
        assert.strictEqual(broadcastRes.status, 200)
        assert.strictEqual(broadcastRes.body.availableBoys, undefined, "rider identity and location must not be returned to owners")

        const assignment = await DeliveryAssignment.findOne({ shopOrderId: w.shopOrder._id })
        assert.ok(assignment)
        assert.strictEqual(assignment.status, "brodcasted")

        const acceptRes = await acceptAs(riderToken, assignment._id.toString())
        assert.strictEqual(acceptRes.status, 200)
        assert.strictEqual(acceptRes.body.message, "order accepted")

        const sendRes = await sendOtpAs(riderToken, ids)
        assert.strictEqual(sendRes.status, 200)
        assert.strictEqual(sentMailCaptures.length, 1)
        const otp = sentMailCaptures[0].otp

        const verifyRes = await verifyOtpAs(riderToken, { ...ids, otp })
        assert.strictEqual(verifyRes.status, 200)

        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "delivered")
        assert.ok(stored.deliveredAt)
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
    })

    test("COD remains exempt from the online payment gate", async () => {
        const w = await seedWorld({ status: "preparing", nearBoys: 1 })
        const ids = idsFor(w)

        const res = await postStatus(tokenFor(w.owner._id), ids.orderId, ids.shopId, "out of delivery")
        assert.strictEqual(res.status, 200)
        assert.strictEqual((await storedShopOrder(w)).status, "out of delivery")
        assert.strictEqual(await DeliveryAssignment.countDocuments({ shopOrderId: w.shopOrder._id }), 1)
        assert.strictEqual((await Order.findById(w.order._id)).payment, false)
    })

    test("an unpaid online broadcast is hidden and cannot be accepted", async () => {
        const w = await seedWorld({
            status: "preparing",
            nearBoys: 1,
            paymentMethod: "online",
            payment: false
        })
        const rider = w.riders[0]
        const assignment = await attachAssignment(w, rider)

        const listRes = await apiGet("/api/order/get-assignments", tokenFor(rider._id))
        assert.strictEqual(listRes.status, 200)
        assert.deepStrictEqual(listRes.body, [])

        const acceptRes = await acceptAs(tokenFor(rider._id), assignment._id.toString(), {
            payment: true,
            paymentMethod: "cod",
            status: "out of delivery"
        })
        assert.strictEqual(acceptRes.status, 400)
        assert.strictEqual(acceptRes.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)

        const storedAssignment = await DeliveryAssignment.findById(assignment._id)
        assert.strictEqual(storedAssignment.status, "brodcasted")
        assert.strictEqual(storedAssignment.assignedTo, null)
        assert.strictEqual((await storedShopOrder(w)).assignedDeliveryBoy, undefined)
    })

    test("an unpaid online assigned order cannot be progressed through delivery OTP", async () => {
        const w = await seedWorld({
            status: "preparing",
            nearBoys: 1,
            paymentMethod: "online",
            payment: false
        })
        const rider = w.riders[0]
        const assignment = await attachAssignment(w, rider, { status: "assigned", assigned: true })
        await Order.updateOne(
            { _id: w.order._id, "shopOrders._id": w.shopOrder._id },
            { $set: { "shopOrders.$.status": "out of delivery" } }
        )
        const ids = idsFor(w)
        const riderToken = tokenFor(rider._id)

        const currentRes = await apiGet("/api/order/get-current-order", riderToken)
        assert.strictEqual(currentRes.status, 400)
        assert.strictEqual(currentRes.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)

        const sendRes = await sendOtpAs(riderToken, { ...ids, payment: true })
        assert.strictEqual(sendRes.status, 400)
        assert.strictEqual(sendRes.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)
        assert.strictEqual(sentMailCaptures.length, 0)
        assert.strictEqual((await storedShopOrder(w)).deliveryOtp, null)

        await Order.updateOne(
            { _id: w.order._id, shopOrders: { $elemMatch: { _id: w.shopOrder._id } } },
            {
                $set: {
                    "shopOrders.$.deliveryOtp": "1234",
                    "shopOrders.$.otpExpires": new Date(Date.now() + 60_000),
                    "shopOrders.$.otpAttempts": 0
                }
            }
        )

        const verifyRes = await verifyOtpAs(riderToken, {
            ...ids,
            otp: "1234",
            payment: true,
            status: "delivered"
        })
        assert.strictEqual(verifyRes.status, 400)
        assert.strictEqual(verifyRes.body.message, ONLINE_PAYMENT_REQUIRED_MESSAGE)

        const stored = await storedShopOrder(w)
        assert.strictEqual(stored.status, "out of delivery")
        assert.strictEqual(stored.deliveryOtp, "1234")
        assert.strictEqual((await DeliveryAssignment.findById(assignment._id)).status, "assigned")
    })

    test("concurrent unpaid online fulfillment requests cannot bypass the gate", async () => {
        const w = await seedWorld({
            status: "pending",
            nearBoys: 2,
            paymentMethod: "online",
            payment: false
        })
        const ids = idsFor(w)
        const ownerToken = tokenFor(w.owner._id)

        const responses = await Promise.all([
            postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery"),
            postStatus(ownerToken, ids.orderId, ids.shopId, "out of delivery")
        ])

        assert.deepStrictEqual(responses.map(r => r.status), [400, 400])
        assert.ok(responses.every(r => r.body.message === ONLINE_PAYMENT_REQUIRED_MESSAGE))
        assert.strictEqual((await storedShopOrder(w)).status, "pending")
        assert.strictEqual(await DeliveryAssignment.countDocuments({}), 0)
        assert.strictEqual((await Order.findById(w.order._id)).payment, false)
    })
})
