import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_csrf_secret_key_for_integration_testing"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = ""

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

const TRUSTED_ORIGIN = "http://localhost:5173"

let mongo
let app

const dummyItemId = () => new mongoose.Types.ObjectId().toString()

const seedWorld = async ({ workers = 2, assignments = 1, shopOrders = 1 } = {}) => {
    const owner = await User.create({ fullName: "Owner", email: `o${Date.now()}@t.com`, mobile: "9000000000", role: "owner" })
    const shop = await Shop.create({ name: "Relational Shop", image: "s.png", owner: owner._id, city: "Pune", state: "MH", address: "a", items: [] })
    const workerIds = []
    for (let i = 0; i < workers; i++) {
        const w = await User.create({ fullName: `Worker${i}`, email: `w${i}${Date.now()}@t.com`, mobile: `900000000${i}`, role: "deliveryBoy" })
        workerIds.push(w._id.toString())
    }
    const orders = []
    for (let i = 0; i < assignments; i++) {
        const parentsGermane = []
        const shopOrderRefs = []
        for (let s = 0; s < shopOrders; s++) {
            shopOrderRefs.push({ shop: shop._id, owner: owner._id, status: "out of delivery", subtotal: 100, shopOrderItems: [{ item: dummyItemId(), name: "item", price: 100, quantity: 1 }] })
        }
        const order = await Order.create({
            user: owner._id,
            paymentMethod: "cod",
            totalAmount: 100,
            shopOrders: shopOrderRefs
        })
        orders.push(order)
    }
    const created = []
    for (let i = 0; i < assignments; i++) {
        const order = orders[i]
        const assignment = await DeliveryAssignment.create({
            order: order._id,
            shop: shop._id,
            shopOrderId: order.shopOrders[0]._id,
            brodcastedTo: workerIds,
            status: "brodcasted"
        })
        created.push({ order, assignment })
    }
    return { owner, shop, workerIds, created }
}

const signCsrf = (which = "cs-shared", purpose = "post-login") =>
    jwt.sign({ csrf: which, purpose }, process.env.JWT_SECRET, { expiresIn: "1h" })

const acceptRequest = (assignmentId, workerId, { headerToken, cookieToken, origin = TRUSTED_ORIGIN, withAuth = true, purpose = "post-login" } = {}) => {
    const csrf = jwt.sign({ csrf: "cs-shared", purpose }, process.env.JWT_SECRET, { expiresIn: "1h" })
    const header = headerToken === null ? null : (headerToken === undefined ? csrf : headerToken)
    const cookie = cookieToken === null ? null : (cookieToken === undefined ? csrf : cookieToken)
    const cookies = []
    if (withAuth) cookies.push(`token=${jwt.sign({ userId: workerId }, process.env.JWT_SECRET, { expiresIn: "1h" })}`)
    if (cookie !== null) cookies.push(`XSRF-TOKEN=${cookie}`)
    let req = request(app)
        .post(`/api/order/accept-order/${assignmentId}`)
        .set("Cookie", cookies)
    if (header !== null) req = req.set("X-XSRF-TOKEN", header)
    if (origin !== null) req = req.set("Origin", origin)
    return req
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await DeliveryAssignment.init()
    await User.init()
    await Order.init()
    await Shop.init()
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
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})])
})

describe("Accept-order live integration (auth + CSRF + DB)", () => {
    test("a delivery worker claims a broadcasted assignment successfully", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.message, "order accepted")

        const loaded = await DeliveryAssignment.findById(assignment.assignment._id)
        assert.strictEqual(loaded.status, "assigned")
        assert.strictEqual(loaded.assignedTo.toString(), workerIds[0])
        assert.ok(loaded.acceptedAt)

        const order = await Order.findById(assignment.order._id)
        assert.strictEqual(order.shopOrders.id(assignment.assignment.shopOrderId).assignedDeliveryBoy.toString(), workerIds[0])
    })

    test("only one of two concurrent workers claims the assignment", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const assignmentId = assignment.assignment._id.toString()

        const [r1, r2] = await Promise.all([
            acceptRequest(assignmentId, workerIds[0]),
            acceptRequest(assignmentId, workerIds[1])
        ])

        const statuses = [r1.status, r2.status]
        const win = statuses.indexOf(200)
        assert.ok(win !== -1, "one request must succeed with 200")
        assert.notStrictEqual(statuses[1 - win], 200, "the losing request must not succeed")
        assert.strictEqual(statuses[1 - win], 409)
        assert.strictEqual([r1, r2][1 - win].body.message, "Assignment is no longer available")

        const loaded = await DeliveryAssignment.findById(assignmentId)
        assert.strictEqual(loaded.status, "assigned")
        assert.strictEqual(loaded.assignedTo.toString(), workerIds[win])

        const order = await Order.findById(assignment.order._id)
        assert.strictEqual(order.shopOrders.id(assignment.assignment.shopOrderId).assignedDeliveryBoy.toString(), workerIds[win])
    })

    test("the same worker cannot claim two assignments sequentially", async () => {
        const { workerIds, created } = await seedWorld({ workers: 1, assignments: 2 })
        const [first, second] = created

        const ok = await acceptRequest(first.assignment._id.toString(), workerIds[0])
        assert.strictEqual(ok.status, 200)

        const rejected = await acceptRequest(second.assignment._id.toString(), workerIds[0])
        assert.strictEqual(rejected.status, 400)
        assert.strictEqual(rejected.body.message, "You are already assigned to another order")

        const secondLoaded = await DeliveryAssignment.findById(second.assignment._id)
        assert.strictEqual(secondLoaded.status, "brodcasted")
        assert.strictEqual(secondLoaded.assignedTo, null)
    })

    test("the same worker racing on two assignments claims exactly one", async () => {
        const { workerIds, created } = await seedWorld({ workers: 1, assignments: 2 })
        const [first, second] = created
        const assignmentIdFirst = first.assignment._id.toString()
        const assignmentIdSecond = second.assignment._id.toString()

        const [r1, r2] = await Promise.all([
            acceptRequest(assignmentIdFirst, workerIds[0]),
            acceptRequest(assignmentIdSecond, workerIds[0])
        ])

        const winner = r1.status === 200 ? r1 : r2
        assert.strictEqual(winner.status, 200)
        const loser = r1.status === 200 ? r2 : r1
        assert.strictEqual(loser.status, 400)
        assert.strictEqual(loser.body.message, "You are already assigned to another order")

        const loadedFirst = await DeliveryAssignment.findById(assignmentIdFirst)
        const loadedSecond = await DeliveryAssignment.findById(assignmentIdSecond)
        const claimed = [loadedFirst, loadedSecond].filter(a => a.status === "assigned")
        assert.strictEqual(claimed.length, 1)
        assert.strictEqual(claimed[0].assignedTo.toString(), workerIds[0])
        const broadcast = [loadedFirst, loadedSecond].find(a => a.status === "brodcasted")
        assert.strictEqual(broadcast.assignedTo, null)
    })

    test("claiming an already-assigned assignment returns 409 and preserves the winner", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created

        const first = await acceptRequest(assignment.assignment._id.toString(), workerIds[0])
        assert.strictEqual(first.status, 200)

        const second = await acceptRequest(assignment.assignment._id.toString(), workerIds[1])
        assert.strictEqual(second.status, 409)
        assert.strictEqual(second.body.message, "Assignment is no longer available")

        const loaded = await DeliveryAssignment.findById(assignment.assignment._id)
        assert.strictEqual(loaded.assignedTo.toString(), workerIds[0])
    })

    test("claiming a nonexistent assignment returns assignment not found", async () => {
        const { workerIds } = await seedWorld()
        const missingId = new mongoose.Types.ObjectId().toString()

        const res = await acceptRequest(missingId, workerIds[0])
        assert.strictEqual(res.status, 400)
        assert.strictEqual(res.body.message, "assignment not found")
    })

    test("request without an auth token is rejected with 401", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0], { withAuth: false })

        assert.strictEqual(res.status, 401)
        assert.strictEqual(res.body.message, "Authentication token required")
    })

    test("missing CSRF header is rejected with 403", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const cookieOnly = jwt.sign({ csrf: "cs-cookie-only", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0], {
            headerToken: null,
            cookieToken: cookieOnly
        })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Missing CSRF token")
    })

    test("mismatched CSRF header and cookie are rejected with 403", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const headerToken = jwt.sign({ csrf: "header-side-csrf-id", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
        const cookieToken = jwt.sign({ csrf: "cookie-side-csrf-id", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
        assert.notStrictEqual(headerToken, cookieToken)

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0], {
            headerToken,
            cookieToken
        })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "CSRF token mismatch")
    })

    test("CSRF token with invalid purpose is rejected with 403", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0], { purpose: "random" })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Invalid CSRF token purpose")
    })

    test("request with an untrusted origin is rejected with 403", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created

        const res = await acceptRequest(assignment.assignment._id.toString(), workerIds[0], { origin: "https://evil.example.com" })

        assert.strictEqual(res.status, 403)
        assert.strictEqual(res.body.message, "Invalid origin")
    })

    test("no GET route can trigger the assignment anymore", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const csrf = jwt.sign({ csrf: "cs-shared", purpose: "post-login" }, process.env.JWT_SECRET, { expiresIn: "1h" })
        const auth = jwt.sign({ userId: workerIds[0] }, process.env.JWT_SECRET, { expiresIn: "1h" })

        const res = await request(app)
            .get(`/api/order/accept-order/${assignment.assignment._id.toString()}`)
            .set("Cookie", [`token=${auth}`, `XSRF-TOKEN=${csrf}`])

        assert.strictEqual(res.status, 404)
    })

    test("order update throwing after claim rolls the assignment back and frees it for retry", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const assignmentId = assignment.assignment._id.toString()
        const simulatedFailure = new Error("simulated order update write failure")

        const patched = Order.updateOne
        Order.updateOne = async () => { throw simulatedFailure }
        const logs = []
        const originalConsoleError = console.error
        console.error = (...args) => { logs.push(args.map(String).join(" ")) }
        let res
        try {
            res = await acceptRequest(assignmentId, workerIds[0])
        } finally {
            Order.updateOne = patched
            console.error = originalConsoleError
        }

        assert.strictEqual(res.status, 500)
        assert.strictEqual(res.body.message, "Failed to accept order. Please try again.")

        const rolledBack = await DeliveryAssignment.findById(assignmentId)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)

        assert.ok(logs.some(l => l.includes("order update not applied")), logs.join("\n"))
        assert.ok(logs.some(l => l.includes("claim rolled back")), logs.join("\n"))

        const retry = await acceptRequest(assignmentId, workerIds[1])
        assert.strictEqual(retry.status, 200)
    })

    test("a failing rollback keeps the claim attached and logs both the original and rollback failures", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const assignmentId = assignment.assignment._id.toString()
        const simulatedFailure = new Error("simulated order update write failure")
        const simulatedRollbackFailure = new Error("simulated rollback write failure")

        const patchedUpdate = Order.updateOne
        const patchedFindAndUpdate = DeliveryAssignment.findOneAndUpdate
        Order.updateOne = async () => { throw simulatedFailure }
        let findOneAndUpdateCalls = 0
        DeliveryAssignment.findOneAndUpdate = async (...args) => {
            findOneAndUpdateCalls++
            if (findOneAndUpdateCalls === 1) {
                return patchedFindAndUpdate.apply(DeliveryAssignment, args)
            }
            throw simulatedRollbackFailure
        }
        const logs = []
        const originalConsoleError = console.error
        console.error = (...args) => { logs.push(args.map(String).join(" ")) }
        let res
        try {
            res = await acceptRequest(assignmentId, workerIds[0])
        } finally {
            Order.updateOne = patchedUpdate
            DeliveryAssignment.findOneAndUpdate = patchedFindAndUpdate
            console.error = originalConsoleError
        }

        assert.strictEqual(res.status, 500)

        const loaded = await DeliveryAssignment.findById(assignmentId)
        assert.strictEqual(loaded.status, "assigned")
        assert.strictEqual(loaded.assignedTo.toString(), workerIds[0])

        assert.ok(logs.some(l => l.includes("order update not applied")), logs.join("\n"))
        assert.ok(logs.some(l => l.includes("simulated rollback write failure")), logs.join("\n"))
    })

    test("rollback cannot clear an assignment whose ownership changed during the failure", async () => {
        const { workerIds, created } = await seedWorld({ workers: 2 })
        const [assignment] = created
        const assignmentId = assignment.assignment._id.toString()
        const simulatedFailure = new Error("simulated order update write failure")

        const patched = Order.updateOne
        Order.updateOne = async () => {
            await DeliveryAssignment.updateOne(
                { _id: assignment.assignment._id },
                { $set: { assignedTo: workerIds[1], status: "assigned", acceptedAt: new Date() } }
            )
            throw simulatedFailure
        }
        const logs = []
        const originalConsoleError = console.error
        console.error = (...args) => { logs.push(args.map(String).join(" ")) }
        let res
        try {
            res = await acceptRequest(assignmentId, workerIds[0])
        } finally {
            Order.updateOne = patched
            console.error = originalConsoleError
        }

        assert.strictEqual(res.status, 500)

        const loaded = await DeliveryAssignment.findById(assignmentId)
        assert.strictEqual(loaded.assignedTo.toString(), workerIds[1])
        assert.strictEqual(loaded.status, "assigned")

        assert.ok(logs.some(l => l.includes("did not revert")), logs.join("\n"))
    })

    test("order update resolving with zero modifications rolls the claim back with 409", async () => {
        const { workerIds, created } = await seedWorld()
        const [assignment] = created
        const assignmentId = assignment.assignment._id.toString()

        const patched = Order.updateOne
        Order.updateOne = async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
        let res
        try {
            res = await acceptRequest(assignmentId, workerIds[0])
        } finally {
            Order.updateOne = patched
        }

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, "Assignment is no longer available")

        const rolledBack = await DeliveryAssignment.findById(assignmentId)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)
    })

    test("unique index rejects a same-worker second claim directly with duplicate key code 11000", async () => {
        const { workerIds, created } = await seedWorld({ workers: 1, assignments: 2 })
        const [first, second] = created

        const claim = await DeliveryAssignment.findOneAndUpdate(
            { _id: first.assignment._id, status: "brodcasted", assignedTo: null },
            { $set: { status: "assigned", assignedTo: workerIds[0], acceptedAt: new Date() } },
            { new: true, runValidators: true }
        )
        assert.ok(claim, "first direct claim must succeed")

        await assert.rejects(
            () => DeliveryAssignment.findOneAndUpdate(
                { _id: second.assignment._id, status: "brodcasted", assignedTo: null },
                { $set: { status: "assigned", assignedTo: workerIds[0], acceptedAt: new Date() } },
                { new: true, runValidators: true }
            ),
            (err) => err.code === 11000 && err.message.includes("unique_active_assignment_per_worker")
        )
    })
})

describe("assignment and shop-order relationship validation", () => {
    const storedAssignment = async (assignmentId) =>
        DeliveryAssignment.findById(assignmentId)

    test("a matching assignment pointer can still be claimed", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const shopOrder = order.shopOrders.id(assignment.shopOrderId)
        shopOrder.assignment = assignment._id
        await order.save()

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.message, "order accepted")
    })

    test("a shop-order shop mismatch is rejected and the claim rolls back", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const shopOrder = order.shopOrders.id(assignment.shopOrderId)
        shopOrder.shop = new mongoose.Types.ObjectId()
        await order.save()

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, "Assignment is no longer available")
        const rolledBack = await storedAssignment(assignment._id)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)
        assert.strictEqual(rolledBack.active, true)
    })

    test("non-delivery-stage shop orders cannot be claimed", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const shopOrder = order.shopOrders.id(assignment.shopOrderId)
        shopOrder.status = "preparing"
        await order.save()

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 409)
        const rolledBack = await storedAssignment(assignment._id)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)
    })

    test("a conflicting assignedDeliveryBoy on the shop order cannot be overwritten", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const shopOrder = order.shopOrders.id(assignment.shopOrderId)
        shopOrder.assignedDeliveryBoy = workerIds[1]
        await order.save()

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 409)
        const rolledBack = await storedAssignment(assignment._id)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)
    })

    test("a different assignment pointer prevents the claim from passing", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const shopOrder = order.shopOrders.id(assignment.shopOrderId)
        shopOrder.assignment = new mongoose.Types.ObjectId()
        await order.save()

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 409)
        const rolledBack = await storedAssignment(assignment._id)
        assert.strictEqual(rolledBack.status, "brodcasted")
        assert.strictEqual(rolledBack.assignedTo, null)
        assert.strictEqual(rolledBack.acceptedAt, null)
    })

    test("an inactive broadcast cannot be claimed", async () => {
        const { workerIds, created } = await seedWorld({ workers: 1 })
        const [{ assignment }] = created
        await DeliveryAssignment.updateOne(
            { _id: assignment._id },
            { $set: { active: false } }
        )

        const res = await acceptRequest(assignment._id.toString(), workerIds[0])

        assert.strictEqual(res.status, 409)
        assert.strictEqual(res.body.message, "Assignment is no longer available")
        const stored = await storedAssignment(assignment._id)
        assert.strictEqual(stored.status, "brodcasted")
        assert.strictEqual(stored.assignedTo, null)
        assert.strictEqual(stored.active, false)
    })

    test("getCurrentOrder rejects an active assignment whose relationship is no longer valid", async () => {
        const { workerIds, created } = await seedWorld()
        const [{ order, assignment }] = created
        const workerId = workerIds[0]

        const acceptRes = await acceptRequest(assignment._id.toString(), workerId)
        assert.strictEqual(acceptRes.status, 200)

        const before = await request(app)
            .get("/api/order/get-current-order")
            .set("Cookie", `token=${jwt.sign({ userId: workerId }, process.env.JWT_SECRET, { expiresIn: "1h" })}`)
        assert.strictEqual(before.status, 200)

        const shopOrderBefore = await Order.findById(order._id)
        const storedShopOrder = shopOrderBefore.shopOrders.id(assignment.shopOrderId)
        storedShopOrder.shop = new mongoose.Types.ObjectId()
        await shopOrderBefore.save()

        const after = await request(app)
            .get("/api/order/get-current-order")
            .set("Cookie", `token=${jwt.sign({ userId: workerId }, process.env.JWT_SECRET, { expiresIn: "1h" })}`)
        assert.strictEqual(after.status, 400)
        assert.strictEqual(after.body.message, "assignment not found")
    })
})
