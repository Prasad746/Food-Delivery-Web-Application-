import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_order_authorization_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const tokenFor = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })
const csrfToken = () => jwt.sign({ csrf: "cs-order-auth", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

const getOrderById = (token, orderId) =>
    request(app)
        .get(`/api/order/get-order-by-id/${orderId}`)
        .set("Cookie", `token=${token}`)

const getMyOrders = (token) =>
    request(app)
        .get("/api/order/my-orders")
        .set("Cookie", `token=${token}`)

const claimAssignment = (assignmentId, token) =>
    request(app)
        .post(`/api/order/accept-order/${assignmentId}`)
        .set("Cookie", `token=${token}; XSRF-TOKEN=${csrfToken()}`)
        .set("X-XSRF-TOKEN", csrfToken())
        .set("Origin", TRUSTED_ORIGIN)

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init(), DeliveryAssignment.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/order", csrfMiddleware, orderRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
})

const seedAuthWorld = async () => {
    const owner = await User.create({ fullName: "Owner One", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const owner2 = await User.create({ fullName: "Owner Two", email: `o2${Date.now()}@t.com`, mobile: "9000000004", role: "owner" })
    const customer = await User.create({ fullName: "Customer One", email: `c${Date.now()}@t.com`, mobile: "9000000001", role: "user" })
    const customer2 = await User.create({ fullName: "Customer Two", email: `c2${Date.now()}@t.com`, mobile: "9000000005", role: "user" })
    const assignedRider = await User.create({ fullName: "Assigned Rider", email: `d${Date.now()}@t.com`, mobile: "9000000002", role: "deliveryBoy" })
    const unrelatedRider = await User.create({ fullName: "Unrelated Rider", email: `d2${Date.now()}@t.com`, mobile: "9000000003", role: "deliveryBoy" })
    const claimantRider = await User.create({ fullName: "Claimant Rider", email: `d3${Date.now()}@t.com`, mobile: "9000000006", role: "deliveryBoy" })

    const shop1 = await Shop.create({ name: "Shop One", image: "s1.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shop2 = await Shop.create({ name: "Shop Two", image: "s2.png", owner: owner2._id, city: "Pune", state: "MH", address: "b", items: [] })
    const item = await Item.create({ name: "Paneer Roll", image: "i.png", shop: shop1._id, category: "Others", price: 100, foodType: "veg" })

    const order = await Order.create({
        user: customer._id,
        paymentMethod: "cod",
        deliveryAddress: { text: "12 auth road", latitude: 18.5, longitude: 73.8 },
        totalAmount: 140,
        shopOrders: [{
            shop: shop1._id,
            owner: owner._id,
            subtotal: 100,
            shopOrderItems: [{ item: item._id, name: item.name, price: 100, quantity: 1 }]
        }]
    })
    const shopOrder = order.shopOrders[0]

    await DeliveryAssignment.create({
        order: order._id,
        shop: shop1._id,
        shopOrderId: shopOrder._id,
        brodcastedTo: [claimantRider._id],
        assignedTo: assignedRider._id,
        acceptedAt: new Date(),
        status: "assigned"
    })
    shopOrder.assignedDeliveryBoy = assignedRider._id
    await order.save()

    return { owner, owner2, customer, customer2, assignedRider, unrelatedRider, claimantRider, shop1, shop2, item, order, shopOrder }
}

const seedBroadcastAssignment = async (w) => {
    const order = await Order.create({
        user: w.customer2._id,
        paymentMethod: "cod",
        deliveryAddress: { text: "9 broadcast road", latitude: 18.5, longitude: 73.8 },
        totalAmount: 140,
        shopOrders: [{
            shop: w.shop1._id,
            owner: w.owner._id,
            status: "out of delivery",
            subtotal: 100,
            shopOrderItems: [{ item: w.item._id, name: w.item.name, price: 100, quantity: 1 }]
        }]
    })
    const assignment = await DeliveryAssignment.create({
        order: order._id,
        shop: w.shop1._id,
        shopOrderId: order.shopOrders[0]._id,
        brodcastedTo: [w.claimantRider._id],
        status: "brodcasted"
    })
    return { order, assignment, shopOrder: order.shopOrders[0] }
}

const seedMultiShopWorld = async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const ownerOne = await User.create({ fullName: "Multi Owner One", email: `mo1-${stamp}@t.com`, mobile: "9100000001", role: "owner" })
    const ownerTwo = await User.create({ fullName: "Multi Owner Two", email: `mo2-${stamp}@t.com`, mobile: "9100000002", role: "owner" })
    const unrelatedOwner = await User.create({ fullName: "Multi Owner Three", email: `mo3-${stamp}@t.com`, mobile: "9100000003", role: "owner" })
    const customer = await User.create({ fullName: "Multi Customer", email: `mc-${stamp}@t.com`, mobile: "9100000004", role: "user" })
    const riderOne = await User.create({ fullName: "Multi Rider One", email: `mr1-${stamp}@t.com`, mobile: "9100000005", role: "deliveryBoy" })
    const riderTwo = await User.create({ fullName: "Multi Rider Two", email: `mr2-${stamp}@t.com`, mobile: "9100000006", role: "deliveryBoy" })
    const unrelatedRider = await User.create({ fullName: "Multi Rider Three", email: `mr3-${stamp}@t.com`, mobile: "9100000007", role: "deliveryBoy" })

    const shopOne = await Shop.create({ name: "Multi Shop One", image: "m1.png", owner: ownerOne._id, city: "Pune", state: "MH", address: "a", items: [] })
    const shopTwo = await Shop.create({ name: "Multi Shop Two", image: "m2.png", owner: ownerTwo._id, city: "Pune", state: "MH", address: "b", items: [] })
    const itemOne = await Item.create({ name: "Multi Item One", image: "mi1.png", shop: shopOne._id, category: "Others", price: 100, foodType: "veg" })
    const itemTwo = await Item.create({ name: "Multi Item Two", image: "mi2.png", shop: shopTwo._id, category: "Others", price: 100, foodType: "veg" })

    const order = await Order.create({
        user: customer._id,
        paymentMethod: "online",
        payment: true,
        razorpayOrderId: "order_multishop_secret",
        razorpayPaymentId: "pay_multishop_secret",
        deliveryAddress: { text: "12 multi-shop road", latitude: 18.5, longitude: 73.8 },
        totalAmount: 340,
        shopOrders: [
            {
                shop: shopOne._id,
                owner: ownerOne._id,
                subtotal: 100,
                status: "preparing",
                shopOrderItems: [{ item: itemOne._id, name: itemOne.name, price: 100, quantity: 1 }]
            },
            {
                shop: shopTwo._id,
                owner: ownerTwo._id,
                subtotal: 200,
                status: "pending",
                shopOrderItems: [{ item: itemTwo._id, name: itemTwo.name, price: 100, quantity: 2 }]
            }
        ]
    })
    const shopOrderOne = order.shopOrders[0]
    const shopOrderTwo = order.shopOrders[1]

    const assignmentOne = await DeliveryAssignment.create({
        order: order._id,
        shop: shopOne._id,
        shopOrderId: shopOrderOne._id,
        brodcastedTo: [riderOne._id],
        assignedTo: riderOne._id,
        acceptedAt: new Date(),
        status: "assigned"
    })
    const assignmentTwo = await DeliveryAssignment.create({
        order: order._id,
        shop: shopTwo._id,
        shopOrderId: shopOrderTwo._id,
        brodcastedTo: [riderTwo._id],
        assignedTo: riderTwo._id,
        acceptedAt: new Date(),
        status: "assigned"
    })

    shopOrderOne.assignment = assignmentOne._id
    shopOrderOne.assignedDeliveryBoy = riderOne._id
    shopOrderOne.deliveryOtp = "1111"
    shopOrderOne.otpExpires = new Date(Date.now() + 5 * 60 * 1000)
    shopOrderOne.otpAttempts = 1
    shopOrderTwo.assignment = assignmentTwo._id
    shopOrderTwo.assignedDeliveryBoy = riderTwo._id
    shopOrderTwo.deliveryOtp = "2222"
    shopOrderTwo.otpExpires = new Date(Date.now() + 5 * 60 * 1000)
    shopOrderTwo.otpAttempts = 2
    await order.save()

    return {
        ownerOne, ownerTwo, unrelatedOwner, customer, riderOne, riderTwo, unrelatedRider,
        shopOne, shopTwo, itemOne, itemTwo, order, shopOrderOne, shopOrderTwo,
        assignmentOne, assignmentTwo
    }
}

const sensitiveUserFields = ["password", "resetOtp", "otpExpires", "isOtpVerified", "resetPasswordTokenHash", "resetPasswordExpires", "socketId", "firebaseUid"]

describe("order object-level authorization and data minimization (Stage 5B)", () => {
    test("the customer can read their own order and sees only safe user fields", async () => {
        const w = await seedAuthWorld()

        const res = await getOrderById(tokenFor(w.customer._id), w.order._id.toString())

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.user.fullName, w.customer.fullName)
        assert.strictEqual(res.body.user.email, w.customer.email)
        for (const field of sensitiveUserFields) {
            assert.strictEqual(res.body.user[field], undefined, `user.${field} must not leak`)
        }
        assert.strictEqual(res.body.shopOrders[0].shop.name, w.shop1.name)
        assert.strictEqual(res.body.shopOrders[0].shopOrderItems[0].name, w.item.name)
    })

    test("another customer cannot read someone else's order", async () => {
        const w = await seedAuthWorld()

        const res = await getOrderById(tokenFor(w.customer2._id), w.order._id.toString())

        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "order not found")
    })

    test("an owner of a different shop is rejected while the order's shop owner passes", async () => {
        const w = await seedAuthWorld()

        const foreign = await getOrderById(tokenFor(w.owner2._id), w.order._id.toString())
        assert.strictEqual(foreign.status, 400)
        assert.strictEqual(foreign.body.message, "order not found")

        const own = await getOrderById(tokenFor(w.owner._id), w.order._id.toString())
        assert.strictEqual(own.status, 200)
        assert.strictEqual(own.body.shopOrders[0].shop.name, w.shop1.name)
    })

    test("only the assigned delivery partner (or none at all) may read the order by id", async () => {
        const w = await seedAuthWorld()

        const unrelated = await getOrderById(tokenFor(w.unrelatedRider._id), w.order._id.toString())
        assert.strictEqual(unrelated.status, 400)
        assert.strictEqual(unrelated.body.message, "order not found")

        const assigned = await getOrderById(tokenFor(w.assignedRider._id), w.order._id.toString())
        assert.strictEqual(assigned.status, 200)
        assert.strictEqual(assigned.body.shopOrders[0].assignedDeliveryBoy.fullName, w.assignedRider.fullName)
        for (const field of sensitiveUserFields) {
            assert.strictEqual(assigned.body.shopOrders[0].assignedDeliveryBoy[field], undefined)
        }
    })

    test("malformed order ids get the same generic failure", async () => {
        const w = await seedAuthWorld()

        const res = await getOrderById(tokenFor(w.customer._id), "not-an-object-id")
        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "order not found")
    })

    test("getMyOrders keeps role-specific output without leaking sensitive user data", async () => {
        const w = await seedAuthWorld()

        const customerOrders = await getMyOrders(tokenFor(w.customer._id))
        assert.strictEqual(customerOrders.status, 200)
        assert.strictEqual(customerOrders.body.length, 1)
        assert.strictEqual(typeof customerOrders.body[0].user, "string", "customer view must not embed a populated user document")

        const ownerOrders = await getMyOrders(tokenFor(w.owner._id))
        assert.strictEqual(ownerOrders.status, 200)
        assert.strictEqual(ownerOrders.body.length, 1)
        assert.strictEqual(ownerOrders.body[0].user.fullName, w.customer.fullName)
        for (const field of sensitiveUserFields) {
            assert.strictEqual(ownerOrders.body[0].user[field], undefined, `owner view must not expose user.${field}`)
        }
        assert.ok(ownerOrders.body[0].shopOrders.shopOrderItems.length > 0)
    })

    test("delivery partners and unrelated customers get an empty order list instead of a hanging request", async () => {
        const w = await seedAuthWorld()

        const riderRes = await getMyOrders(tokenFor(w.assignedRider._id))
        assert.strictEqual(riderRes.status, 200)
        assert.deepStrictEqual(riderRes.body, [])

        const strangerRes = await getMyOrders(tokenFor(w.customer2._id))
        assert.strictEqual(strangerRes.status, 200)
        assert.deepStrictEqual(strangerRes.body, [])
    })
})

describe("multi-shop get-order-by-id isolation (Stage 7A.3)", () => {
    test("each shop owner receives only the shop order they own", async () => {
        const w = await seedMultiShopWorld()

        const first = await getOrderById(tokenFor(w.ownerOne._id), w.order._id.toString())
        assert.strictEqual(first.status, 200)
        assert.strictEqual(first.body.shopOrders.length, 1)
        assert.strictEqual(String(first.body.shopOrders[0]._id), String(w.shopOrderOne._id))
        assert.strictEqual(first.body.shopOrders[0].shop.name, w.shopOne.name)
        assert.strictEqual(first.body.shopOrders[0].shopOrderItems.length, 1)
        assert.strictEqual(first.body.shopOrders[0].shopOrderItems[0].name, w.itemOne.name)
        assert.strictEqual(first.body.shopOrders[0].assignedDeliveryBoy.fullName, w.riderOne.fullName)
        assert.strictEqual(String(first.body.shopOrders[0].assignment), String(w.assignmentOne._id))
        assert.strictEqual(first.body.user.mobile, w.customer.mobile)
        assert.strictEqual(first.body.user.email, undefined)
        assert.strictEqual(first.body.totalAmount, undefined)
        assert.strictEqual(first.body.razorpayOrderId, undefined)
        assert.strictEqual(first.body.razorpayPaymentId, undefined)
        assert.ok(!("deliveryOtp" in first.body.shopOrders[0]))

        const firstJson = JSON.stringify(first.body)
        assert.ok(!firstJson.includes(w.shopTwo.name))
        assert.ok(!firstJson.includes(w.itemTwo.name))
        assert.ok(!firstJson.includes(w.riderTwo.fullName))
        assert.ok(!firstJson.includes(String(w.assignmentTwo._id)))

        const second = await getOrderById(tokenFor(w.ownerTwo._id), w.order._id.toString())
        assert.strictEqual(second.status, 200)
        assert.strictEqual(second.body.shopOrders.length, 1)
        assert.strictEqual(String(second.body.shopOrders[0]._id), String(w.shopOrderTwo._id))
        assert.strictEqual(second.body.shopOrders[0].shop.name, w.shopTwo.name)
        assert.strictEqual(second.body.shopOrders[0].shopOrderItems[0].name, w.itemTwo.name)
        assert.strictEqual(second.body.shopOrders[0].assignedDeliveryBoy.fullName, w.riderTwo.fullName)

        const secondJson = JSON.stringify(second.body)
        assert.ok(!secondJson.includes(w.shopOne.name))
        assert.ok(!secondJson.includes(w.itemOne.name))
        assert.ok(!secondJson.includes(w.riderOne.fullName))
        assert.ok(!secondJson.includes(String(w.assignmentOne._id)))
    })

    test("each assigned rider receives only their shop order and delivery contact", async () => {
        const w = await seedMultiShopWorld()

        const first = await getOrderById(tokenFor(w.riderOne._id), w.order._id.toString())
        assert.strictEqual(first.status, 200)
        assert.strictEqual(first.body.shopOrders.length, 1)
        assert.strictEqual(String(first.body.shopOrders[0]._id), String(w.shopOrderOne._id))
        assert.strictEqual(first.body.shopOrders[0].shop.name, w.shopOne.name)
        assert.strictEqual(first.body.shopOrders[0].shopOrderItems[0].name, w.itemOne.name)
        assert.strictEqual(first.body.shopOrders[0].subtotal, 100)
        assert.strictEqual(first.body.shopOrders[0].assignedDeliveryBoy.fullName, w.riderOne.fullName)
        assert.strictEqual(first.body.user.fullName, w.customer.fullName)
        assert.strictEqual(first.body.user.mobile, w.customer.mobile)
        assert.strictEqual(first.body.user.email, undefined)
        assert.strictEqual(first.body.deliveryAddress.text, "12 multi-shop road")
        assert.strictEqual(first.body.totalAmount, undefined)
        assert.strictEqual(first.body.razorpayOrderId, undefined)
        assert.strictEqual(first.body.razorpayPaymentId, undefined)

        const firstJson = JSON.stringify(first.body)
        assert.ok(!firstJson.includes(w.shopTwo.name))
        assert.ok(!firstJson.includes(w.itemTwo.name))
        assert.ok(!firstJson.includes(w.riderTwo.fullName))
        assert.ok(!firstJson.includes(String(w.assignmentTwo._id)))
        assert.ok(!("deliveryOtp" in first.body.shopOrders[0]))

        const second = await getOrderById(tokenFor(w.riderTwo._id), w.order._id.toString())
        assert.strictEqual(second.status, 200)
        assert.strictEqual(second.body.shopOrders.length, 1)
        assert.strictEqual(String(second.body.shopOrders[0]._id), String(w.shopOrderTwo._id))
        assert.strictEqual(second.body.shopOrders[0].shop.name, w.shopTwo.name)
        assert.strictEqual(second.body.shopOrders[0].assignedDeliveryBoy.fullName, w.riderTwo.fullName)

        const secondJson = JSON.stringify(second.body)
        assert.ok(!secondJson.includes(w.shopOne.name))
        assert.ok(!secondJson.includes(w.itemOne.name))
        assert.ok(!secondJson.includes(w.riderOne.fullName))
        assert.ok(!secondJson.includes(String(w.assignmentOne._id)))
    })

    test("the customer still receives the complete multi-shop tracking view", async () => {
        const w = await seedMultiShopWorld()

        const res = await getOrderById(tokenFor(w.customer._id), w.order._id.toString())
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.shopOrders.length, 2)
        assert.deepStrictEqual(
            res.body.shopOrders.map(so => so.shop.name).sort(),
            [w.shopOne.name, w.shopTwo.name].sort()
        )
        assert.deepStrictEqual(
            res.body.shopOrders.map(so => so.shopOrderItems[0].name).sort(),
            [w.itemOne.name, w.itemTwo.name].sort()
        )
        assert.deepStrictEqual(
            res.body.shopOrders.map(so => so.assignedDeliveryBoy.fullName).sort(),
            [w.riderOne.fullName, w.riderTwo.fullName].sort()
        )
        assert.strictEqual(res.body.totalAmount, 340)
        assert.strictEqual(res.body.user.email, w.customer.email)
        assert.strictEqual(res.body.deliveryAddress.text, "12 multi-shop road")
        for (const shopOrder of res.body.shopOrders) {
            assert.ok(!("deliveryOtp" in shopOrder))
            assert.ok(!("otpExpires" in shopOrder))
            assert.ok(!("otpAttempts" in shopOrder))
        }
    })

    test("unrelated owners and riders get the same denial for a multi-shop order", async () => {
        const w = await seedMultiShopWorld()

        const foreignOwner = await getOrderById(tokenFor(w.unrelatedOwner._id), w.order._id.toString())
        assert.strictEqual(foreignOwner.status, 400)
        assert.strictEqual(foreignOwner.body.message, "order not found")

        const foreignRider = await getOrderById(tokenFor(w.unrelatedRider._id), w.order._id.toString())
        assert.strictEqual(foreignRider.status, 400)
        assert.strictEqual(foreignRider.body.message, "order not found")
    })
})

describe("delivery assignment claiming authorization (Stage 5B)", () => {
    test("a delivery partner in the broadcast list can claim the assignment", async () => {
        const w = await seedAuthWorld()
        const { assignment } = await seedBroadcastAssignment(w)

        const res = await claimAssignment(assignment._id.toString(), tokenFor(w.claimantRider._id))

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.message, "order accepted")
        const loaded = await DeliveryAssignment.findById(assignment._id)
        assert.strictEqual(loaded.status, "assigned")
        assert.strictEqual(loaded.assignedTo.toString(), w.claimantRider._id.toString())
    })

    test("a delivery partner outside the broadcast list cannot claim it", async () => {
        const w = await seedAuthWorld()
        const { assignment } = await seedBroadcastAssignment(w)

        const res = await claimAssignment(assignment._id.toString(), tokenFor(w.unrelatedRider._id))

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, "Assignment is no longer available")
        const loaded = await DeliveryAssignment.findById(assignment._id)
        assert.strictEqual(loaded.status, "brodcasted")
        assert.strictEqual(loaded.assignedTo, null)
    })

    test("customers and shop owners are rejected by the role gate", async () => {
        const w = await seedAuthWorld()
        const { assignment } = await seedBroadcastAssignment(w)

        const customerRes = await claimAssignment(assignment._id.toString(), tokenFor(w.customer._id))
        assert.strictEqual(customerRes.status, 403)
        assert.strictEqual(customerRes.body.message, "Only delivery partners can accept assignments")

        const ownerRes = await claimAssignment(assignment._id.toString(), tokenFor(w.owner._id))
        assert.strictEqual(ownerRes.status, 403)

        const loaded = await DeliveryAssignment.findById(assignment._id)
        assert.strictEqual(loaded.status, "brodcasted")
        assert.strictEqual(loaded.assignedTo, null)
    })

    test("racing claims by the single broadcast member preserve one-winner semantics", async () => {
        const w = await seedAuthWorld()
        const { assignment } = await seedBroadcastAssignment(w)
        const target = assignment._id.toString()

        const [r1, r2] = await Promise.all([
            claimAssignment(target, tokenFor(w.claimantRider._id)),
            claimAssignment(target, tokenFor(w.claimantRider._id))
        ])

        assert.strictEqual([r1.status, r2.status].filter((s) => s === 200).length, 1)
        assert.strictEqual([r1.status, r2.status].filter((s) => s === 409).length, 1)

        const loaded = await DeliveryAssignment.findById(target)
        assert.strictEqual(loaded.status, "assigned")
        assert.strictEqual(loaded.assignedTo.toString(), w.claimantRider._id.toString())
    })
})
