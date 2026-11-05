import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_restaurant_analytics_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = "test"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import orderRouter from "../routes/order.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"

let mongo
let app
let seq = 0

const tokenFor = (userId) =>
    jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })

const getAnalytics = (token, params = {}) => {
    const query = new URLSearchParams(params).toString()
    return request(app)
        .get(`/api/order/analytics${query ? `?${query}` : ""}`)
        .set("Cookie", `token=${token}`)
}

const uniqueSuffix = () => {
    seq += 1
    return `${Date.now()}_${seq}`
}

const startOfToday = () => {
    const date = new Date()
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1)
const daysInMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()

const seedWorld = async () => {
    const suffix = uniqueSuffix()
    const owner1 = await User.create({ fullName: "Analytics Owner One", email: `analytics_owner1_${suffix}@test.com`, mobile: "9200000001", role: "owner" })
    const owner2 = await User.create({ fullName: "Analytics Owner Two", email: `analytics_owner2_${suffix}@test.com`, mobile: "9200000002", role: "owner" })
    const ownerNoShop = await User.create({ fullName: "No Shop Owner", email: `analytics_owner3_${suffix}@test.com`, mobile: "9200000003", role: "owner" })
    const customer = await User.create({ fullName: "Private Customer", email: `analytics_customer_${suffix}@test.com`, mobile: "9200000004", role: "user" })
    const rider = await User.create({ fullName: "Analytics Rider", email: `analytics_rider_${suffix}@test.com`, mobile: "9200000005", role: "deliveryBoy" })
    const admin = await User.create({ fullName: "Analytics Admin", email: `analytics_admin_${suffix}@test.com`, mobile: "9200000006", role: "admin" })

    const shop1 = await Shop.create({ name: "Analytics Shop One", image: "a1.png", owner: owner1._id, city: "Pune", state: "MH", address: "one", items: [] })
    const shop2 = await Shop.create({ name: "Analytics Shop Two", image: "a2.png", owner: owner2._id, city: "Pune", state: "MH", address: "two", items: [] })

    return { owner1, owner2, ownerNoShop, customer, rider, admin, shop1, shop2 }
}

const createFoodItem = async (shop, {
    name = "Test Food",
    image = "food.png",
    price = 100
} = {}) => Item.create({
    name,
    image,
    shop: shop._id,
    category: "Fast Food",
    price,
    foodType: "veg"
})

const createOrderAt = async (world, {
    owner = world.owner1,
    shop = world.shop1,
    subtotal = 100,
    status = "pending",
    paymentMethod = "cod",
    payment = false,
    createdAt = new Date(),
    totalAmount,
    items = []
} = {}) => {
    const order = await Order.create({
        user: world.customer._id,
        paymentMethod,
        payment,
        deliveryAddress: { text: "12 analytics lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: totalAmount ?? subtotal + 40,
        shopOrders: [{
            shop: shop._id,
            owner: owner._id,
            subtotal,
            status,
            shopOrderItems: items.map((line) => ({
                item: line.item,
                name: line.name,
                price: line.price,
                quantity: line.quantity
            }))
        }]
    })
    await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt } })
    return order
}

const createCheckoutAt = async (world, shopOrders, {
    paymentMethod = "cod",
    payment = false,
    createdAt = new Date(),
    totalAmount
} = {}) => {
    const subtotal = shopOrders.reduce((sum, item) => sum + item.subtotal, 0)
    const order = await Order.create({
        user: world.customer._id,
        paymentMethod,
        payment,
        deliveryAddress: { text: "12 analytics lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: totalAmount ?? subtotal + 40,
        shopOrders: shopOrders.map((item) => ({
            shop: item.shop._id,
            owner: item.owner._id,
            subtotal: item.subtotal,
            status: item.status || "pending",
            payment: item.payment,
            shopOrderItems: []
        }))
    })
    await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt } })
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
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Shop.deleteMany({}), Item.deleteMany({}), Order.deleteMany({})])
})

describe("restaurant analytics authorization", () => {
    test("unauthenticated, customer, rider, and admin callers are rejected", async () => {
        const world = await seedWorld()
        await createOrderAt(world, { status: "delivered" })

        const anonymous = await request(app).get("/api/order/analytics")
        const customer = await getAnalytics(tokenFor(world.customer._id))
        const rider = await getAnalytics(tokenFor(world.rider._id))
        const admin = await getAnalytics(tokenFor(world.admin._id))

        assert.strictEqual(anonymous.status, 401)
        assert.strictEqual(customer.status, 403)
        assert.strictEqual(rider.status, 403)
        assert.strictEqual(admin.status, 403)
    })

    test("an owner without a restaurant receives not found", async () => {
        const world = await seedWorld()

        const res = await getAnalytics(tokenFor(world.ownerNoShop._id))

        assert.strictEqual(res.status, 404)
        assert.match(res.body.message, /restaurant/i)
    })

    test("analytics ignore a frontend-supplied shop id and stay scoped to the owner", async () => {
        const world = await seedWorld()
        const now = new Date()

        await createOrderAt(world, { owner: world.owner1, shop: world.shop1, subtotal: 100, status: "delivered", createdAt: now })
        await createOrderAt(world, { owner: world.owner2, shop: world.shop2, subtotal: 900, status: "delivered", createdAt: now })
        await createOrderAt(world, { owner: world.owner1, shop: world.shop2, subtotal: 777, status: "delivered", createdAt: now })

        const ownerOne = await getAnalytics(tokenFor(world.owner1._id), { period: "today", shopId: String(world.shop2._id) })
        const ownerTwo = await getAnalytics(tokenFor(world.owner2._id), { period: "today", shopId: String(world.shop1._id) })

        assert.strictEqual(ownerOne.status, 200)
        assert.strictEqual(ownerOne.body.summary.totalOrders, 1)
        assert.strictEqual(ownerOne.body.summary.revenue, 100)
        assert.strictEqual(ownerTwo.status, 200)
        assert.strictEqual(ownerTwo.body.summary.totalOrders, 1)
        assert.strictEqual(ownerTwo.body.summary.revenue, 900)
    })

    test("responses exclude customer and delivery information", async () => {
        const world = await seedWorld()
        await createOrderAt(world, { status: "delivered", createdAt: new Date() })

        const res = await getAnalytics(tokenFor(world.owner1._id), { period: "today" })
        const body = JSON.stringify(res.body)

        assert.strictEqual(res.status, 200)
        assert.ok(!body.includes(world.customer.email))
        assert.ok(!body.includes(world.customer.fullName))
        assert.ok(!body.includes("12 analytics lane"))
        assert.ok(!body.includes("18.5"))
    })
})

describe("restaurant analytics metrics", () => {
    test("counts restaurant suborders and calculates revenue, statuses, and average order value", async () => {
        const world = await seedWorld()
        const range = { period: "custom", startDate: "2025-02-01", endDate: "2025-02-10" }
        const at = (day) => new Date(2025, 1, day, 12, 0, 0)

        await createOrderAt(world, { status: "delivered", subtotal: 100, paymentMethod: "cod", createdAt: at(1), totalAmount: 9999 })
        await createOrderAt(world, { status: "delivered", subtotal: 200, paymentMethod: "online", payment: true, createdAt: at(2) })
        await createOrderAt(world, { status: "delivered", subtotal: 300, paymentMethod: "online", payment: false, createdAt: at(3) })
        await createOrderAt(world, { status: "cancelled", subtotal: 400, paymentMethod: "online", payment: true, createdAt: at(4) })
        await createOrderAt(world, { status: "pending", subtotal: 500, paymentMethod: "online", payment: true, createdAt: at(5) })
        await createOrderAt(world, { status: "preparing", subtotal: 60, paymentMethod: "cod", createdAt: at(6) })
        await createOrderAt(world, { status: "out of delivery", subtotal: 70, paymentMethod: "online", payment: true, createdAt: at(7) })
        await createCheckoutAt(world, [
            { owner: world.owner1, shop: world.shop1, subtotal: 50, status: "delivered" },
            { owner: world.owner2, shop: world.shop2, subtotal: 900, status: "delivered" }
        ], { paymentMethod: "cod", createdAt: at(8) })
        await createOrderAt(world, { owner: world.owner2, shop: world.shop2, status: "delivered", subtotal: 1000, createdAt: at(9) })
        await createOrderAt(world, { status: "delivered", subtotal: 25, paymentMethod: "cod", createdAt: new Date(2025, 0, 25, 12) })

        const res = await getAnalytics(tokenFor(world.owner1._id), range)

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.shop.name, world.shop1.name)
        assert.strictEqual(res.body.summary.totalOrders, 8)
        assert.strictEqual(res.body.summary.completedOrders, 4)
        assert.strictEqual(res.body.summary.pendingOrders, 3)
        assert.strictEqual(res.body.summary.cancelledOrders, 1)
        assert.strictEqual(res.body.summary.revenue, 350)
        assert.strictEqual(res.body.summary.averageOrderValue, 116.67)
        assert.strictEqual(res.body.summary.completionPercentage, 50)
        assert.strictEqual(res.body.summary.cancellationPercentage, 12.5)

        const statuses = Object.fromEntries(res.body.statusDistribution.map((item) => [item.status, item.count]))
        assert.deepStrictEqual(statuses, {
            pending: 1,
            preparing: 1,
            "out of delivery": 1,
            delivered: 4,
            cancelled: 1
        })

        assert.strictEqual(res.body.previous.totalOrders, 1)
        assert.strictEqual(res.body.previous.revenue, 25)
        assert.strictEqual(res.body.previous.completedOrders, 1)
        assert.strictEqual(res.body.previous.averageOrderValue, 25)
    })

    test("cancelled and unpaid online orders never contribute revenue", async () => {
        const world = await seedWorld()
        const createdAt = new Date(2025, 5, 10, 12)

        await createOrderAt(world, { status: "cancelled", subtotal: 400, paymentMethod: "online", payment: true, createdAt })
        await createOrderAt(world, { status: "cancelled", subtotal: 450, paymentMethod: "cod", createdAt })
        await createOrderAt(world, { status: "delivered", subtotal: 300, paymentMethod: "online", payment: false, createdAt })

        const res = await getAnalytics(tokenFor(world.owner1._id), {
            period: "custom",
            startDate: "2025-06-10",
            endDate: "2025-06-10"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.summary.revenue, 0)
        assert.strictEqual(res.body.summary.averageOrderValue, 0)
        assert.strictEqual(res.body.summary.completedOrders, 1)
        assert.strictEqual(res.body.summary.cancelledOrders, 2)
    })
})

describe("restaurant food analytics", () => {
    const foodAt = new Date(2025, 3, 10, 12, 0, 0)
    const foodRange = { period: "custom", startDate: "2025-04-10", endDate: "2025-04-10" }

    test("best sellers aggregate quantities, count distinct orders, and return the top five", async () => {
        const world = await seedWorld()
        const foods = []
        for (let index = 0; index < 6; index += 1) {
            foods.push(await createFoodItem(world.shop1, {
                name: `Food ${index + 1}`,
                image: `food-${index + 1}.png`,
                price: (index + 1) * 10
            }))
        }
        const line = (food, quantity, price = food.price) => ({
            item: food._id,
            name: food.name,
            price,
            quantity
        })

        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 110,
            items: [line(foods[0], 2, 100), line(foods[0], 1, 100), line(foods[1], 1)]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "online",
            payment: true,
            createdAt: foodAt,
            subtotal: 450,
            items: [line(foods[0], 4, 100), line(foods[2], 5)]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 60,
            items: [line(foods[3], 6)]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 40,
            items: [line(foods[4], 4)]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 20,
            items: [line(foods[5], 2)]
        })
        await createOrderAt(world, {
            status: "pending",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 500,
            items: [line(foods[5], 50)]
        })
        await createOrderAt(world, {
            status: "cancelled",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 500,
            items: [line(foods[4], 50)]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "online",
            payment: false,
            createdAt: foodAt,
            subtotal: 500,
            items: [line(foods[3], 50)]
        })

        const res = await getAnalytics(tokenFor(world.owner1._id), foodRange)

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.bestSellers.length, 5)
        assert.deepStrictEqual(
            res.body.bestSellers.map((item) => ({
                rank: item.rank,
                name: item.name,
                quantitySold: item.quantitySold,
                orderCount: item.orderCount
            })),
            [
                { rank: 1, name: "Food 1", quantitySold: 7, orderCount: 2 },
                { rank: 2, name: "Food 4", quantitySold: 6, orderCount: 1 },
                { rank: 3, name: "Food 3", quantitySold: 5, orderCount: 1 },
                { rank: 4, name: "Food 5", quantitySold: 4, orderCount: 1 },
                { rank: 5, name: "Food 6", quantitySold: 2, orderCount: 1 }
            ]
        )
        assert.strictEqual(res.body.bestSellers[0].image, "food-1.png")
    })

    test("food performance uses historical prices and consistent revenue contributions", async () => {
        const world = await seedWorld()
        const burger = await createFoodItem(world.shop1, {
            name: "Burger",
            image: "burger.png",
            price: 999
        })
        const pizza = await createFoodItem(world.shop1, {
            name: "Pizza",
            image: "pizza.png",
            price: 999
        })

        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 400,
            items: [
                { item: burger._id, name: burger.name, price: 100, quantity: 2 },
                { item: pizza._id, name: pizza.name, price: 200, quantity: 1 }
            ]
        })
        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "online",
            payment: true,
            createdAt: foodAt,
            subtotal: 50,
            items: [{ item: burger._id, name: burger.name, price: 50, quantity: 1 }]
        })
        await createOrderAt(world, {
            status: "cancelled",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 50000,
            items: [{ item: burger._id, name: burger.name, price: 500, quantity: 100 }]
        })

        const res = await getAnalytics(tokenFor(world.owner1._id), foodRange)
        const performance = Object.fromEntries(res.body.foodPerformance.map((item) => [item.name, item]))

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body.foodPerformance.map((item) => item.name), ["Burger", "Pizza"])
        assert.deepStrictEqual(performance.Burger, {
            itemId: String(burger._id),
            name: "Burger",
            image: "burger.png",
            quantitySold: 3,
            orderCount: 2,
            revenue: 250,
            contributionPercentage: 55.6
        })
        assert.deepStrictEqual(performance.Pizza, {
            itemId: String(pizza._id),
            name: "Pizza",
            image: "pizza.png",
            quantitySold: 1,
            orderCount: 1,
            revenue: 200,
            contributionPercentage: 44.4
        })
        assert.strictEqual(
            res.body.foodPerformance.reduce((sum, item) => sum + item.contributionPercentage, 0),
            100
        )
    })

    test("deleted food references and zero-revenue items are handled safely", async () => {
        const world = await seedWorld()
        const deletedItemId = new mongoose.Types.ObjectId()
        const freeItem = await createFoodItem(world.shop1, {
            name: "Free Sample",
            image: "free.png",
            price: 0
        })

        await createOrderAt(world, {
            status: "delivered",
            paymentMethod: "cod",
            createdAt: foodAt,
            subtotal: 150,
            items: [
                { item: deletedItemId, name: "Removed Dish", price: 75, quantity: 2 },
                { item: freeItem._id, name: freeItem.name, price: 0, quantity: 3 }
            ]
        })

        const res = await getAnalytics(tokenFor(world.owner1._id), foodRange)
        const removed = res.body.foodPerformance.find((item) => item.name === "Removed Dish")
        const free = res.body.foodPerformance.find((item) => item.name === "Free Sample")

        assert.strictEqual(res.status, 200)
        assert.strictEqual(removed.itemId, String(deletedItemId))
        assert.strictEqual(removed.image, null)
        assert.strictEqual(removed.revenue, 150)
        assert.strictEqual(removed.contributionPercentage, 100)
        assert.strictEqual(free.revenue, 0)
        assert.strictEqual(free.quantitySold, 3)
        assert.strictEqual(free.contributionPercentage, 0)
        assert.ok(Number.isFinite(free.contributionPercentage))
    })

    test("pending and cancelled sales do not create food analytics", async () => {
        const world = await seedWorld()
        const food = await createFoodItem(world.shop1, { name: "Unsold Food" })

        await createOrderAt(world, {
            status: "pending",
            createdAt: foodAt,
            items: [{ item: food._id, name: food.name, price: 100, quantity: 5 }]
        })
        await createOrderAt(world, {
            status: "cancelled",
            createdAt: foodAt,
            items: [{ item: food._id, name: food.name, price: 100, quantity: 5 }]
        })

        const res = await getAnalytics(tokenFor(world.owner1._id), foodRange)

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body.bestSellers, [])
        assert.deepStrictEqual(res.body.foodPerformance, [])
    })

    test("food analytics stay scoped to the owner's restaurant and selected date range", async () => {
        const world = await seedWorld()
        const ownerOneFood = await createFoodItem(world.shop1, { name: "Owner One Food" })
        const ownerTwoFood = await createFoodItem(world.shop2, { name: "Owner Two Food" })

        await createOrderAt(world, {
            owner: world.owner1,
            shop: world.shop1,
            status: "delivered",
            createdAt: foodAt,
            items: [{ item: ownerOneFood._id, name: ownerOneFood.name, price: 100, quantity: 2 }]
        })
        await createOrderAt(world, {
            owner: world.owner2,
            shop: world.shop2,
            status: "delivered",
            createdAt: foodAt,
            items: [{ item: ownerTwoFood._id, name: ownerTwoFood.name, price: 100, quantity: 9 }]
        })
        await createOrderAt(world, {
            owner: world.owner1,
            shop: world.shop1,
            status: "delivered",
            createdAt: new Date(2025, 3, 9, 12),
            items: [{ item: ownerOneFood._id, name: ownerOneFood.name, price: 100, quantity: 7 }]
        })

        const res = await getAnalytics(tokenFor(world.owner1._id), foodRange)

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body.bestSellers.map((item) => item.name), ["Owner One Food"])
        assert.deepStrictEqual(res.body.foodPerformance.map((item) => item.name), ["Owner One Food"])
        assert.strictEqual(res.body.foodPerformance[0].quantitySold, 2)
        assert.strictEqual(res.body.foodPerformance[0].revenue, 200)
    })
})

describe("restaurant analytics date filters", () => {
    test("today uses local midnight boundaries and returns hourly chart buckets", async () => {
        const world = await seedWorld()
        const today = startOfToday()

        await createOrderAt(world, { createdAt: today })
        await createOrderAt(world, { createdAt: new Date(today.getTime() - 1) })

        const res = await getAnalytics(tokenFor(world.owner1._id), { period: "today" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.summary.totalOrders, 1)
        assert.strictEqual(res.body.period.startDate, res.body.period.endDate)
        assert.strictEqual(res.body.period.granularity, "hour")
        assert.strictEqual(res.body.series.length, 24)
    })

    test("last 7 and last 30 days include complete local calendar days", async () => {
        const world = await seedWorld()
        const today = startOfToday()

        await createOrderAt(world, { createdAt: addDays(today, -6) })
        await createOrderAt(world, { createdAt: addDays(today, -7) })
        await createOrderAt(world, { createdAt: addDays(today, -29) })
        await createOrderAt(world, { createdAt: addDays(today, -30) })

        const last7 = await getAnalytics(tokenFor(world.owner1._id), { period: "last7" })
        const last30 = await getAnalytics(tokenFor(world.owner1._id), { period: "last30" })

        assert.strictEqual(last7.status, 200)
        assert.strictEqual(last7.body.summary.totalOrders, 1)
        assert.strictEqual(last7.body.series.length, 7)
        assert.strictEqual(last30.status, 200)
        assert.strictEqual(last30.body.summary.totalOrders, 3)
        assert.strictEqual(last30.body.series.length, 30)
    })

    test("this month excludes the previous month and includes the first day", async () => {
        const world = await seedWorld()
        const monthStart = startOfMonth(new Date())
        const previousMonthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth(), 0, 23, 59, 59, 999)

        await createOrderAt(world, { createdAt: monthStart })
        await createOrderAt(world, { createdAt: previousMonthEnd })

        const res = await getAnalytics(tokenFor(world.owner1._id), { period: "thisMonth" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.summary.totalOrders, 1)
        assert.strictEqual(res.body.period.startDate, [
            monthStart.getFullYear(),
            String(monthStart.getMonth() + 1).padStart(2, "0"),
            "01"
        ].join("-"))
        assert.strictEqual(res.body.series.length, daysInMonth(monthStart))
    })

    test("custom date ranges use inclusive dates and excluded outer boundaries", async () => {
        const world = await seedWorld()

        await createOrderAt(world, { createdAt: new Date(2025, 0, 9, 23, 59, 59, 999) })
        await createOrderAt(world, { createdAt: new Date(2025, 0, 10, 0, 0, 0, 0) })
        await createOrderAt(world, { createdAt: new Date(2025, 0, 12, 23, 59, 59, 999) })
        await createOrderAt(world, { createdAt: new Date(2025, 0, 13, 0, 0, 0, 0) })

        const res = await getAnalytics(tokenFor(world.owner1._id), {
            period: "custom",
            startDate: "2025-01-10",
            endDate: "2025-01-12"
        })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.summary.totalOrders, 2)
        assert.deepStrictEqual(res.body.series.map((bucket) => bucket.orders), [1, 0, 1])
        assert.strictEqual(res.body.period.startDate, "2025-01-10")
        assert.strictEqual(res.body.period.endDate, "2025-01-12")
        assert.strictEqual(res.body.period.previousStartDate, "2025-01-07")
        assert.strictEqual(res.body.period.previousEndDate, "2025-01-09")
    })

    test("empty periods return zero-safe metrics and chart buckets", async () => {
        const world = await seedWorld()

        const res = await getAnalytics(tokenFor(world.owner1._id), {
            period: "custom",
            startDate: "2024-01-01",
            endDate: "2024-01-02"
        })

        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body.summary, {
            totalOrders: 0,
            revenue: 0,
            completedOrders: 0,
            pendingOrders: 0,
            cancelledOrders: 0,
            averageOrderValue: 0,
            completionPercentage: 0,
            cancellationPercentage: 0
        })
        assert.strictEqual(res.body.series.length, 2)
        assert.ok(res.body.series.every((bucket) => bucket.orders === 0 && bucket.revenue === 0))
        assert.ok(res.body.statusDistribution.every((item) => item.count === 0))
        assert.deepStrictEqual(res.body.bestSellers, [])
        assert.deepStrictEqual(res.body.foodPerformance, [])
    })

    test("invalid and oversized custom ranges are rejected", async () => {
        const world = await seedWorld()
        const token = tokenFor(world.owner1._id)

        const missing = await getAnalytics(token, { period: "custom" })
        const reversed = await getAnalytics(token, {
            period: "custom",
            startDate: "2025-02-10",
            endDate: "2025-02-01"
        })
        const malformed = await getAnalytics(token, {
            period: "custom",
            startDate: "2025-02-30",
            endDate: "2025-03-01"
        })
        const oversized = await getAnalytics(token, {
            period: "custom",
            startDate: "2024-01-01",
            endDate: "2025-12-31"
        })
        const unknown = await getAnalytics(token, { period: "allTime" })

        assert.strictEqual(missing.status, 400)
        assert.strictEqual(reversed.status, 400)
        assert.strictEqual(malformed.status, 400)
        assert.strictEqual(oversized.status, 400)
        assert.strictEqual(unknown.status, 400)
    })
})
