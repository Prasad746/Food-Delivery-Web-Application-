import { test, describe, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"
import express from "express"
import cookieParser from "cookie-parser"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import request from "supertest"

process.env.JWT_SECRET = "test_food_recommendation_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"
process.env.NODE_ENV = "test"

import User from "../models/user.model.js"
import Shop from "../models/shop.model.js"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"
import itemRouter from "../routes/item.routes.js"
import { csrfMiddleware } from "../middlewares/csrf.js"
import {
    RECOMMENDATION_DEFAULT_LIMIT,
    RECOMMENDATION_MAX_LIMIT,
    buildFoodRecommendations,
    calculateRecommendationScore,
    parseRecommendationLimit
} from "../services/recommendation.service.js"

let mongo
let app
let seq = 0

const tokenFor = (userId) =>
    jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: "1h" })

const getRecommendations = (token, params = {}) => {
    const query = new URLSearchParams(params).toString()
    const requestBuilder = request(app).get(`/api/item/recommendations${query ? `?${query}` : ""}`)
    return token ? requestBuilder.set("Cookie", `token=${token}`) : requestBuilder
}

const uniqueSuffix = () => {
    seq += 1
    return `${Date.now()}_${seq}`
}

const seedUsers = async () => {
    const suffix = uniqueSuffix()
    const owner = await User.create({ fullName: "Recommendation Owner", email: `rec_owner_${suffix}@test.com`, mobile: "9300000001", role: "owner" })
    const customerA = await User.create({ fullName: "Customer Alpha", email: `rec_alpha_${suffix}@test.com`, mobile: "9300000002", role: "user" })
    const customerB = await User.create({ fullName: "Customer Beta", email: `rec_beta_${suffix}@test.com`, mobile: "9300000003", role: "user" })
    const rider = await User.create({ fullName: "Recommendation Rider", email: `rec_rider_${suffix}@test.com`, mobile: "9300000004", role: "deliveryBoy" })
    const admin = await User.create({ fullName: "Recommendation Admin", email: `rec_admin_${suffix}@test.com`, mobile: "9300000005", role: "admin" })
    return { owner, customerA, customerB, rider, admin }
}

const createShop = async ({ owner, name, city = "Pune" }) =>
    Shop.create({
        name,
        image: `${name.replace(/\s+/g, "-").toLowerCase()}.png`,
        owner: owner._id,
        city,
        state: "MH",
        address: `${name} address`,
        items: []
    })

const createItem = async ({ shop, name, category, price = 150, foodType = "veg", rating = { average: 0, count: 0 }, isAvailable }) => {
    const item = await Item.create({
        name,
        image: `${name.replace(/\s+/g, "-").toLowerCase()}.png`,
        shop: shop._id,
        category,
        price,
        foodType,
        rating,
        ...(isAvailable === undefined ? {} : { isAvailable })
    })
    shop.items.push(item._id)
    await shop.save()
    return item
}

const createOrder = async ({ customer, owner, shop, lines, status = "delivered", payment = false }) => {
    const shopOrderItems = lines.map(({ item, quantity = 1 }) => ({
        item: item._id,
        name: item.name,
        price: item.price,
        quantity
    }))
    const subtotal = shopOrderItems.reduce((sum, line) => sum + line.price * line.quantity, 0)
    return Order.create({
        user: customer._id,
        paymentMethod: "cod",
        payment,
        deliveryAddress: { text: "12 recommendation lane", latitude: 18.5, longitude: 73.8 },
        totalAmount: subtotal + 30,
        shopOrders: [{
            shop: shop._id,
            owner: owner._id,
            subtotal,
            status,
            shopOrderItems
        }]
    })
}

const seedMenu = async () => {
    const users = await seedUsers()
    const shopA = await createShop({ owner: users.owner, name: "Alpha Kitchen" })
    const shopB = await createShop({ owner: users.owner, name: "Beta Kitchen" })
    const pizzaA = await createItem({ shop: shopA, name: "Alpha Pizza", category: "Pizza", price: 220, rating: { average: 4.5, count: 20 } })
    const burgerA = await createItem({ shop: shopA, name: "Alpha Burger", category: "Burgers", price: 180, rating: { average: 4.2, count: 14 } })
    const pizzaB = await createItem({ shop: shopB, name: "Beta Pizza", category: "Pizza", price: 240, rating: { average: 4.8, count: 8 } })
    const wrapB = await createItem({ shop: shopB, name: "Beta Wrap", category: "Fast Food", price: 130, rating: { average: 3.8, count: 30 } })
    const cancelledItem = await createItem({ shop: shopA, name: "Cancelled Noodles", category: "Chinese", price: 160, rating: { average: 4.9, count: 100 } })
    const unavailableItem = await createItem({ shop: shopA, name: "Unavailable Cake", category: "Desserts", price: 90, rating: { average: 4.9, count: 100 }, isAvailable: false })
    const orphanItem = await Item.create({
        name: "Orphan Momos",
        image: "orphan.png",
        shop: new mongoose.Types.ObjectId(),
        category: "Chinese",
        price: 100,
        foodType: "veg",
        rating: { average: 5, count: 50 }
    })
    return { ...users, shopA, shopB, pizzaA, burgerA, pizzaB, wrapB, cancelledItem, unavailableItem, orphanItem }
}

before(async () => {
    mongo = await MongoMemoryServer.create()
    await mongoose.connect(mongo.getUri())
    await Promise.all([User.init(), Shop.init(), Item.init(), Order.init()])

    app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/api/item", csrfMiddleware, itemRouter)
})

after(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})

beforeEach(async () => {
    await Promise.all([
        Order.deleteMany({}),
        Item.deleteMany({}),
        Shop.deleteMany({}),
        User.deleteMany({})
    ])
})

describe("food recommendation authorization and validation", () => {
    test("unauthenticated requests are rejected", async () => {
        const res = await getRecommendations(null)
        assert.strictEqual(res.status, 401)
    })

    test("owner, rider, and admin callers cannot use the customer recommendation endpoint", async () => {
        const { owner, rider, admin } = await seedUsers()
        for (const user of [owner, rider, admin]) {
            const res = await getRecommendations(tokenFor(user._id))
            assert.strictEqual(res.status, 403)
        }
    })

    test("invalid limits return a clear 400 without leaking internals", async () => {
        const { customerA } = await seedUsers()
        const token = tokenFor(customerA._id)
        for (const limit of ["0", "-1", "1.5", "abc", "21", "1000"]) {
            const res = await getRecommendations(token, { limit })
            assert.strictEqual(res.status, 400, `limit ${limit} should be rejected`)
            assert.match(res.body.message, /limit/i)
        }
    })

    test("limit parsing accepts the default, valid values, and caps at the maximum", () => {
        assert.deepStrictEqual(parseRecommendationLimit(undefined), { limit: RECOMMENDATION_DEFAULT_LIMIT })
        assert.deepStrictEqual(parseRecommendationLimit("3"), { limit: 3 })
        assert.deepStrictEqual(parseRecommendationLimit(String(RECOMMENDATION_MAX_LIMIT)), { limit: RECOMMENDATION_MAX_LIMIT })
        assert.ok(parseRecommendationLimit("0").error)
        assert.ok(parseRecommendationLimit("21").error)
        assert.ok(parseRecommendationLimit(["3"]).error)
    })

    test("default and explicit limits control the number of recommendations", async () => {
        const { customerA, owner } = await seedUsers()
        const shop = await createShop({ owner, name: "Limit Kitchen" })
        for (let index = 0; index < 12; index += 1) {
            await createItem({
                shop,
                name: `Limit Item ${index}`,
                category: "Snacks",
                rating: { average: 4, count: index }
            })
        }

        const defaultRes = await getRecommendations(tokenFor(customerA._id))
        assert.strictEqual(defaultRes.status, 200)
        assert.strictEqual(defaultRes.body.recommendations.length, RECOMMENDATION_DEFAULT_LIMIT)
        assert.strictEqual(defaultRes.body.meta.limit, RECOMMENDATION_DEFAULT_LIMIT)

        const limitedRes = await getRecommendations(tokenFor(customerA._id), { limit: "3" })
        assert.strictEqual(limitedRes.status, 200)
        assert.strictEqual(limitedRes.body.recommendations.length, 3)

        const maxRes = await getRecommendations(tokenFor(customerA._id), { limit: String(RECOMMENDATION_MAX_LIMIT) })
        assert.strictEqual(maxRes.status, 200)
        assert.strictEqual(maxRes.body.recommendations.length, 12)
    })
})

describe("food recommendation personalization", () => {
    test("responses expose safe food and restaurant fields only", async () => {
        const world = await seedMenu()
        const res = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })

        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.success, true)
        assert.ok(Array.isArray(res.body.recommendations))
        assert.ok(res.body.recommendations.length > 0)

        const recommendation = res.body.recommendations[0]
        for (const field of ["_id", "name", "image", "price", "category", "foodType", "rating", "isAvailable", "shopId", "shop", "recommendation"]) {
            assert.ok(Object.hasOwn(recommendation, field), `missing field ${field}`)
        }
        assert.ok(recommendation.recommendation.reason)
        assert.ok(typeof recommendation.shopId === "string")
        assert.ok(recommendation.shop.name)
        assert.strictEqual(Object.hasOwn(recommendation.shop, "owner"), false)
        assert.strictEqual(JSON.stringify(res.body).includes(world.customerA.email), false)
        assert.strictEqual(JSON.stringify(res.body).includes(world.customerB.email), false)
    })

    test("previously delivered items are recommended first and duplicate lines are combined", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.pizzaA, quantity: 2 }]
        })
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.pizzaA, quantity: 3 }]
        })

        const res = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.meta.personalized, true)
        assert.strictEqual(res.body.meta.source, "history")

        const matches = res.body.recommendations.filter((item) => String(item._id) === String(world.pizzaA._id))
        assert.strictEqual(matches.length, 1)
        assert.strictEqual(matches[0].recommendation.reason, "Previously ordered")
        assert.strictEqual(matches[0].recommendation.signals.previousOrders, 5)
        assert.strictEqual(res.body.recommendations[0]._id, String(world.pizzaA._id))
    })

    test("preferred categories and restaurants surface other available dishes", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.pizzaA, quantity: 3 }]
        })

        const res = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })
        const pizzaCandidate = res.body.recommendations.find((item) => String(item._id) === String(world.pizzaB._id))
        const restaurantCandidate = res.body.recommendations.find((item) => String(item._id) === String(world.burgerA._id))

        assert.ok(pizzaCandidate)
        assert.strictEqual(pizzaCandidate.recommendation.reason, "Because you enjoy Pizza")
        assert.strictEqual(pizzaCandidate.recommendation.signals.preferredCategoryOrders, 3)

        assert.ok(restaurantCandidate)
        assert.strictEqual(restaurantCandidate.recommendation.reason, "From Alpha Kitchen, a restaurant you order from")
        assert.strictEqual(restaurantCandidate.recommendation.signals.preferredRestaurantOrders, 3)
    })

    test("cancelled orders do not create purchase history", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.cancelledItem, quantity: 5 }],
            status: "cancelled"
        })
        await createOrder({
            customer: world.customerB,
            owner: world.owner,
            shop: world.shopB,
            lines: [{ item: world.wrapB, quantity: 4 }]
        })

        const res = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.meta.personalized, false)
        for (const recommendation of res.body.recommendations) {
            assert.strictEqual(recommendation.recommendation.signals.previousOrders, 0)
        }
        const cancelledMatch = res.body.recommendations.find((item) => String(item._id) === String(world.cancelledItem._id))
        if (cancelledMatch) {
            assert.notStrictEqual(cancelledMatch.recommendation.reason, "Previously ordered")
        }
    })

    test("one customer's delivered history never personalizes another customer's response", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerB,
            owner: world.owner,
            shop: world.shopB,
            lines: [{ item: world.wrapB, quantity: 10 }]
        })

        const alphaRes = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })
        const betaRes = await getRecommendations(tokenFor(world.customerB._id), { limit: "20" })

        assert.strictEqual(alphaRes.status, 200)
        assert.strictEqual(alphaRes.body.meta.personalized, false)
        const alphaWrap = alphaRes.body.recommendations.find((item) => String(item._id) === String(world.wrapB._id))
        assert.ok(alphaWrap)
        assert.strictEqual(alphaWrap.recommendation.signals.previousOrders, 0)
        assert.strictEqual(alphaWrap.recommendation.reason, "Popular with customers")

        assert.strictEqual(betaRes.body.meta.personalized, true)
        const betaWrap = betaRes.body.recommendations.find((item) => String(item._id) === String(world.wrapB._id))
        assert.ok(betaWrap)
        assert.strictEqual(betaWrap.recommendation.signals.previousOrders, 10)
        assert.strictEqual(betaWrap.recommendation.reason, "Previously ordered")
    })

    test("unavailable items and items without a valid shop are excluded", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.unavailableItem, quantity: 3 }]
        })

        const res = await getRecommendations(tokenFor(world.customerA._id), { limit: "20" })
        assert.strictEqual(res.status, 200)
        const ids = res.body.recommendations.map((item) => String(item._id))
        assert.strictEqual(ids.includes(String(world.unavailableItem._id)), false)
        assert.strictEqual(ids.includes(String(world.orphanItem._id)), false)
        for (const recommendation of res.body.recommendations) {
            assert.notStrictEqual(recommendation.isAvailable, false)
            assert.ok(recommendation.shop?.name)
        }
    })

    test("cold-start customers receive available fallback items", async () => {
        const { customerA, owner } = await seedUsers()
        const shop = await createShop({ owner, name: "Fallback Kitchen" })
        await createItem({ shop, name: "Fallback One", category: "Snacks", rating: { average: 0, count: 0 } })
        await createItem({ shop, name: "Fallback Two", category: "Main Course", rating: { average: 0, count: 0 } })

        const res = await getRecommendations(tokenFor(customerA._id))
        assert.strictEqual(res.status, 200)
        assert.strictEqual(res.body.meta.personalized, false)
        assert.strictEqual(res.body.meta.source, "fallback")
        assert.strictEqual(res.body.recommendations.length, 2)
        for (const recommendation of res.body.recommendations) {
            assert.strictEqual(recommendation.recommendation.reason, "Available now")
        }
    })

    test("an empty menu returns an empty list instead of failing", async () => {
        const { customerA } = await seedUsers()
        const res = await getRecommendations(tokenFor(customerA._id))
        assert.strictEqual(res.status, 200)
        assert.deepStrictEqual(res.body.recommendations, [])
        assert.strictEqual(res.body.meta.source, "fallback")
    })
})

describe("food recommendation scoring and service contract", () => {
    test("score weights reinforce previously ordered food, categories, restaurants, popularity, and ratings", () => {
        const popularOnly = calculateRecommendationScore({ popularityQuantity: 10, ratingAverage: 4 })
        const categoryMatch = calculateRecommendationScore({ categoryQuantity: 3, ratingAverage: 4 })
        const previousMatch = calculateRecommendationScore({ previouslyOrderedQuantity: 1 })
        const restaurantMatch = calculateRecommendationScore({ restaurantQuantity: 2 })

        assert.ok(popularOnly > 0)
        assert.ok(categoryMatch > popularOnly)
        assert.ok(previousMatch > categoryMatch)
        assert.ok(restaurantMatch > 0)
        assert.ok(calculateRecommendationScore({}) === 0)
    })

    test("the service returns the same contract when called directly", async () => {
        const world = await seedMenu()
        await createOrder({
            customer: world.customerA,
            owner: world.owner,
            shop: world.shopA,
            lines: [{ item: world.pizzaA, quantity: 1 }]
        })

        const result = await buildFoodRecommendations({ userId: world.customerA._id, limit: 5 })
        assert.strictEqual(result.recommendations.length, 5)
        assert.strictEqual(result.meta.limit, 5)
        assert.strictEqual(result.meta.personalized, true)
        assert.strictEqual(result.recommendations[0]._id.toString(), String(world.pizzaA._id))
    })
})
