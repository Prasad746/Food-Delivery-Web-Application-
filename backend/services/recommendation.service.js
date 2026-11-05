import mongoose from "mongoose"
import Item from "../models/item.model.js"
import Order from "../models/order.model.js"

export const RECOMMENDATION_DEFAULT_LIMIT = 8
export const RECOMMENDATION_MAX_LIMIT = 20

export const RECOMMENDATION_WEIGHTS = Object.freeze({
    previouslyOrderedBase: 100,
    previouslyOrderedPerUnit: 15,
    previouslyOrderedUnitCap: 5,
    categoryPerUnit: 10,
    categoryUnitCap: 10,
    restaurantPerUnit: 6,
    restaurantUnitCap: 10,
    popularityPerUnit: 2,
    popularityUnitCap: 15,
    ratingMultiplier: 2
})

const LIMIT_ERROR = `limit must be a whole number between 1 and ${RECOMMENDATION_MAX_LIMIT}`

const normalizeQuantity = (value) => {
    const quantity = Number(value)
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 1
}

const ratingAverageOf = (item) => {
    const average = Number(item?.rating?.average)
    if (!Number.isFinite(average)) {
        return 0
    }
    return Math.min(5, Math.max(0, average))
}

const toObjectId = (value) => {
    const text = String(value)
    return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null
}

export const parseRecommendationLimit = (rawLimit) => {
    if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
        return { limit: RECOMMENDATION_DEFAULT_LIMIT }
    }
    if (typeof rawLimit !== "string" && typeof rawLimit !== "number") {
        return { error: LIMIT_ERROR }
    }
    const text = String(rawLimit).trim()
    if (!/^\d+$/.test(text)) {
        return { error: LIMIT_ERROR }
    }
    const limit = Number(text)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECOMMENDATION_MAX_LIMIT) {
        return { error: LIMIT_ERROR }
    }
    return { limit }
}

export const calculateRecommendationScore = ({
    previouslyOrderedQuantity = 0,
    categoryQuantity = 0,
    restaurantQuantity = 0,
    popularityQuantity = 0,
    ratingAverage = 0
} = {}) => {
    const previousOrderScore = previouslyOrderedQuantity > 0
        ? RECOMMENDATION_WEIGHTS.previouslyOrderedBase
            + Math.min(previouslyOrderedQuantity, RECOMMENDATION_WEIGHTS.previouslyOrderedUnitCap)
            * RECOMMENDATION_WEIGHTS.previouslyOrderedPerUnit
        : 0
    const categoryScore = Math.min(categoryQuantity, RECOMMENDATION_WEIGHTS.categoryUnitCap)
        * RECOMMENDATION_WEIGHTS.categoryPerUnit
    const restaurantScore = Math.min(restaurantQuantity, RECOMMENDATION_WEIGHTS.restaurantUnitCap)
        * RECOMMENDATION_WEIGHTS.restaurantPerUnit
    const popularityScore = Math.min(popularityQuantity, RECOMMENDATION_WEIGHTS.popularityUnitCap)
        * RECOMMENDATION_WEIGHTS.popularityPerUnit
    const ratingScore = Math.min(5, Math.max(0, Number(ratingAverage) || 0))
        * RECOMMENDATION_WEIGHTS.ratingMultiplier

    return Math.round((previousOrderScore + categoryScore + restaurantScore + popularityScore + ratingScore) * 100) / 100
}

const getDeliveredSignals = async (userId, popularLimit) => {
    const [facets = {}] = await Order.aggregate([
        { $unwind: "$shopOrders" },
        { $match: { "shopOrders.status": "delivered" } },
        { $unwind: "$shopOrders.shopOrderItems" },
        { $match: { "shopOrders.shopOrderItems.item": { $type: "objectId" } } },
        {
            $facet: {
                personal: [
                    { $match: { user: userId } },
                    {
                        $group: {
                            _id: {
                                item: "$shopOrders.shopOrderItems.item",
                                shop: "$shopOrders.shop"
                            },
                            quantity: { $sum: { $ifNull: ["$shopOrders.shopOrderItems.quantity", 1] } }
                        }
                    }
                ],
                popular: [
                    {
                        $group: {
                            _id: {
                                item: "$shopOrders.shopOrderItems.item",
                                shop: "$shopOrders.shop"
                            },
                            quantity: { $sum: { $ifNull: ["$shopOrders.shopOrderItems.quantity", 1] } }
                        }
                    },
                    { $sort: { quantity: -1, _id: 1 } },
                    { $limit: popularLimit }
                ]
            }
        }
    ]).exec()

    const personalByItem = new Map()
    const personalByShop = new Map()
    for (const row of facets.personal || []) {
        const itemId = row?._id?.item
        if (!itemId) {
            continue
        }
        const itemKey = String(itemId)
        const quantity = normalizeQuantity(row.quantity)
        personalByItem.set(itemKey, (personalByItem.get(itemKey) || 0) + quantity)

        const shopId = row?._id?.shop
        if (shopId) {
            const shopKey = String(shopId)
            personalByShop.set(shopKey, (personalByShop.get(shopKey) || 0) + quantity)
        }
    }

    const popularByItem = new Map()
    for (const row of facets.popular || []) {
        const itemId = row?._id?.item
        if (!itemId) {
            continue
        }
        const itemKey = String(itemId)
        popularByItem.set(itemKey, (popularByItem.get(itemKey) || 0) + normalizeQuantity(row.quantity))
    }

    return { personalByItem, personalByShop, popularByItem }
}

const availableItemPipeline = (match, limit = 0) => {
    const pipeline = [
        {
            $match: {
                isAvailable: { $ne: false },
                ...match
            }
        },
        {
            $lookup: {
                from: "shops",
                localField: "shop",
                foreignField: "_id",
                as: "shopDetails"
            }
        },
        { $unwind: "$shopDetails" },
        { $sort: { "rating.average": -1, createdAt: -1, _id: 1 } },
        {
            $project: {
                name: 1,
                image: 1,
                price: 1,
                category: 1,
                foodType: 1,
                rating: 1,
                isAvailable: { $ifNull: ["$isAvailable", true] },
                discount: 1,
                shop: {
                    _id: "$shopDetails._id",
                    name: "$shopDetails.name",
                    image: "$shopDetails.image",
                    city: "$shopDetails.city",
                    state: "$shopDetails.state",
                    address: "$shopDetails.address"
                }
            }
        }
    ]

    if (limit > 0) {
        pipeline.push({ $limit: limit })
    }
    return pipeline
}

const reasonFor = ({
    item,
    previouslyOrderedQuantity,
    categoryQuantity,
    restaurantQuantity,
    popularityQuantity,
    ratingAverage
}) => {
    if (previouslyOrderedQuantity > 0) {
        return "Previously ordered"
    }
    if (categoryQuantity > 0) {
        return `Because you enjoy ${item.category}`
    }
    if (restaurantQuantity > 0) {
        return `From ${item.shop.name}, a restaurant you order from`
    }
    if (popularityQuantity > 0) {
        return "Popular with customers"
    }
    if (ratingAverage > 0) {
        return "Highly rated"
    }
    return "Available now"
}

const toRecommendationResponse = (entry) => ({
    _id: entry.item._id,
    name: entry.item.name,
    image: entry.item.image,
    price: entry.item.price,
    category: entry.item.category,
    foodType: entry.item.foodType,
    rating: entry.item.rating || { average: 0, count: 0 },
    isAvailable: entry.item.isAvailable !== false,
    discount: entry.item.discount || null,
    shopId: String(entry.item.shop._id),
    shop: entry.item.shop,
    recommendation: {
        score: entry.score,
        reason: entry.reason,
        signals: {
            previousOrders: entry.previouslyOrderedQuantity,
            preferredCategoryOrders: entry.categoryQuantity,
            preferredRestaurantOrders: entry.restaurantQuantity,
            popularOrders: entry.popularityQuantity
        }
    }
})

export const buildFoodRecommendations = async ({ userId, limit = RECOMMENDATION_DEFAULT_LIMIT }) => {
    const popularLimit = Math.max(limit * 5, 50)
    const customerId = toObjectId(userId) || userId
    const { personalByItem, personalByShop, popularByItem } = await getDeliveredSignals(customerId, popularLimit)

    const personalItemIds = [...personalByItem.keys()]
    const candidateIds = [...new Set([
        ...personalItemIds,
        ...[...popularByItem.keys()].slice(0, popularLimit)
    ])]

    const categoryByItem = new Map()
    const categoryPreferences = new Map()
    if (personalItemIds.length > 0) {
        const personalItems = await Item.find({ _id: { $in: personalItemIds } }, "category").lean()
        for (const item of personalItems) {
            categoryByItem.set(String(item._id), item.category)
        }
        for (const [itemId, quantity] of personalByItem) {
            const category = categoryByItem.get(itemId)
            if (category) {
                categoryPreferences.set(category, (categoryPreferences.get(category) || 0) + quantity)
            }
        }
    }

    const candidateObjectIds = candidateIds.map(toObjectId).filter(Boolean)
    const candidateItems = candidateObjectIds.length > 0
        ? await Item.aggregate(availableItemPipeline({ _id: { $in: candidateObjectIds } })).exec()
        : []

    const preferredCategories = [...categoryPreferences.keys()]
    const preferredShopIds = [...personalByShop.keys()].map(toObjectId).filter(Boolean)
    const preferenceClauses = []
    if (preferredCategories.length > 0) {
        preferenceClauses.push({ category: { $in: preferredCategories } })
    }
    if (preferredShopIds.length > 0) {
        preferenceClauses.push({ shop: { $in: preferredShopIds } })
    }

    let preferenceItems = []
    if (preferenceClauses.length > 0) {
        const preferenceMatch = { $or: preferenceClauses }
        if (candidateObjectIds.length > 0) {
            preferenceMatch._id = { $nin: candidateObjectIds }
        }
        preferenceItems = await Item.aggregate(
            availableItemPipeline(preferenceMatch, Math.max(limit * 5, 40))
        ).exec()
    }

    const knownObjectIds = [
        ...candidateObjectIds,
        ...preferenceItems.map((item) => item._id)
    ]
    let fallbackItems = []
    if (candidateItems.length + preferenceItems.length < limit) {
        const fallbackMatch = knownObjectIds.length > 0
            ? { _id: { $nin: knownObjectIds } }
            : {}
        fallbackItems = await Item.aggregate(availableItemPipeline(fallbackMatch, limit)).exec()
    }

    const itemsById = new Map()
    for (const item of [...candidateItems, ...preferenceItems, ...fallbackItems]) {
        itemsById.set(String(item._id), item)
    }

    const scored = [...itemsById.values()].map((item) => {
        const itemId = String(item._id)
        const previouslyOrderedQuantity = personalByItem.get(itemId) || 0
        const categoryQuantity = categoryPreferences.get(item.category) || 0
        const restaurantQuantity = personalByShop.get(String(item.shop._id)) || 0
        const popularityQuantity = popularByItem.get(itemId) || 0
        const ratingAverage = ratingAverageOf(item)
        const score = calculateRecommendationScore({
            previouslyOrderedQuantity,
            categoryQuantity,
            restaurantQuantity,
            popularityQuantity,
            ratingAverage
        })
        return {
            item,
            score,
            previouslyOrderedQuantity,
            categoryQuantity,
            restaurantQuantity,
            popularityQuantity,
            ratingAverage,
            reason: reasonFor({
                item,
                previouslyOrderedQuantity,
                categoryQuantity,
                restaurantQuantity,
                popularityQuantity,
                ratingAverage
            })
        }
    })

    scored.sort((left, right) =>
        right.score - left.score
        || right.previouslyOrderedQuantity - left.previouslyOrderedQuantity
        || right.popularityQuantity - left.popularityQuantity
        || right.ratingAverage - left.ratingAverage
        || String(left.item._id).localeCompare(String(right.item._id))
    )

    const recommendedEntries = scored.slice(0, limit)
    const personalized = recommendedEntries.some((entry) =>
        entry.previouslyOrderedQuantity > 0
        || entry.categoryQuantity > 0
        || entry.restaurantQuantity > 0
    )
    const hasPopularitySignal = recommendedEntries.some((entry) => entry.popularityQuantity > 0)
    const source = personalized ? "history" : (hasPopularitySignal ? "popular" : "fallback")

    return {
        recommendations: recommendedEntries.map(toRecommendationResponse),
        meta: {
            limit,
            personalized,
            source,
            generatedAt: new Date().toISOString()
        }
    }
}
