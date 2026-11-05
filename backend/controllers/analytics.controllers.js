import Order from "../models/order.model.js"
import Shop from "../models/shop.model.js"
import User from "../models/user.model.js"

export const ANALYTICS_PERIODS = Object.freeze(["today", "last7", "last30", "thisMonth", "custom"])

const PERIOD_LABELS = Object.freeze({
    today: "Today",
    last7: "Last 7 days",
    last30: "Last 30 days",
    thisMonth: "This month",
    custom: "Custom range"
})

const STATUS_LABELS = Object.freeze({
    pending: "Pending",
    preparing: "Preparing",
    "out of delivery": "Out for delivery",
    delivered: "Delivered",
    cancelled: "Cancelled"
})

const STATUS_ORDER = Object.freeze(["pending", "preparing", "out of delivery", "delivered", "cancelled"])
const ACTIVE_STATUSES = Object.freeze(["pending", "preparing", "out of delivery"])
const MAX_CUSTOM_RANGE_DAYS = 366
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const formatDateOnly = (date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
}

const parseDateOnly = (value) => {
    if (typeof value !== "string") {
        return null
    }
    const match = DATE_ONLY_PATTERN.exec(value)
    if (!match) {
        return null
    }
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return null
    }
    return date
}

const calendarDaysBetween = (startDate, endDateExclusive) => {
    const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
    const endUtc = Date.UTC(endDateExclusive.getFullYear(), endDateExclusive.getMonth(), endDateExclusive.getDate())
    return Math.round((endUtc - startUtc) / (24 * 60 * 60 * 1000))
}

export const resolveAnalyticsRange = (period, startDateValue, endDateValue, now = new Date()) => {
    if (!ANALYTICS_PERIODS.includes(period)) {
        return { error: "Unsupported analytics period" }
    }

    const today = startOfDay(now)
    let start
    let end
    let previousStart
    let previousEnd

    if (period === "today") {
        start = today
        end = addDays(today, 1)
        previousStart = addDays(today, -1)
        previousEnd = today
    } else if (period === "last7") {
        start = addDays(today, -6)
        end = addDays(today, 1)
        previousStart = addDays(start, -7)
        previousEnd = start
    } else if (period === "last30") {
        start = addDays(today, -29)
        end = addDays(today, 1)
        previousStart = addDays(start, -30)
        previousEnd = start
    } else if (period === "thisMonth") {
        start = new Date(today.getFullYear(), today.getMonth(), 1)
        end = new Date(today.getFullYear(), today.getMonth() + 1, 1)
        previousStart = new Date(today.getFullYear(), today.getMonth() - 1, 1)
        previousEnd = start
    } else {
        const customStart = parseDateOnly(startDateValue)
        const customEnd = parseDateOnly(endDateValue)
        if (!customStart || !customEnd) {
            return { error: "A valid custom startDate and endDate are required" }
        }
        if (customEnd < customStart) {
            return { error: "endDate must be on or after startDate" }
        }
        const customEndExclusive = addDays(customEnd, 1)
        const rangeDays = calendarDaysBetween(customStart, customEndExclusive)
        if (rangeDays > MAX_CUSTOM_RANGE_DAYS) {
            return { error: `Custom date range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days` }
        }
        start = customStart
        end = customEndExclusive
        previousEnd = start
        previousStart = addDays(start, -rangeDays)
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const granularity = period === "today" ? "hour" : "day"

    return {
        range: {
            key: period,
            label: PERIOD_LABELS[period],
            timezone,
            granularity,
            start,
            end,
            previousStart,
            previousEnd
        }
    }
}

const paymentSatisfiedExpression = {
    $or: [
        { $eq: ["$paymentMethod", "cod"] },
        { $eq: ["$payment", true] }
    ]
}

const revenueExpression = {
    $cond: [
        {
            $and: [
                { $eq: ["$shopOrders.status", "delivered"] },
                paymentSatisfiedExpression
            ]
        },
        { $ifNull: ["$shopOrders.subtotal", 0] },
        0
    ]
}

const summaryGroupStage = {
    _id: null,
    totalOrders: { $sum: 1 },
    completedOrders: {
        $sum: { $cond: [{ $eq: ["$shopOrders.status", "delivered"] }, 1, 0] }
    },
    cancelledOrders: {
        $sum: { $cond: [{ $eq: ["$shopOrders.status", "cancelled"] }, 1, 0] }
    },
    pendingOrders: {
        $sum: { $cond: [{ $in: ["$shopOrders.status", ACTIVE_STATUSES] }, 1, 0] }
    },
    revenue: { $sum: revenueExpression },
    revenueOrderCount: {
        $sum: {
            $cond: [
                {
                    $and: [
                        { $eq: ["$shopOrders.status", "delivered"] },
                        paymentSatisfiedExpression
                    ]
                },
                1,
                0
            ]
        }
    }
}

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100
const roundPercentage = (value) => Math.round((Number(value) || 0) * 10) / 10

const buildFoodPerformance = (rows) => {
    const itemRows = Array.isArray(rows) ? rows : []
    const totalRevenue = itemRows.reduce((sum, row) => sum + (Number(row?.revenue) || 0), 0)

    const foodPerformance = itemRows
        .map((row) => {
            const revenue = Number(row?.revenue) || 0
            return {
                itemId: row?.itemId || null,
                name: row?.name || "Deleted item",
                image: row?.image || null,
                quantitySold: Number(row?.quantitySold) || 0,
                orderCount: Number(row?.orderCount) || 0,
                revenue: roundMoney(revenue),
                contributionPercentage: totalRevenue > 0
                    ? roundPercentage((revenue / totalRevenue) * 100)
                    : 0
            }
        })
        .sort((left, right) =>
            right.revenue - left.revenue ||
            right.quantitySold - left.quantitySold ||
            left.name.localeCompare(right.name)
        )

    const bestSellers = [...foodPerformance]
        .sort((left, right) =>
            right.quantitySold - left.quantitySold ||
            right.orderCount - left.orderCount ||
            right.revenue - left.revenue ||
            left.name.localeCompare(right.name)
        )
        .slice(0, 5)
        .map((item, index) => ({
            rank: index + 1,
            itemId: item.itemId,
            name: item.name,
            image: item.image,
            quantitySold: item.quantitySold,
            orderCount: item.orderCount
        }))

    return { bestSellers, foodPerformance }
}

const emptySummary = () => ({
    totalOrders: 0,
    revenue: 0,
    completedOrders: 0,
    pendingOrders: 0,
    cancelledOrders: 0,
    averageOrderValue: 0,
    completionPercentage: 0,
    cancellationPercentage: 0
})

const toSummary = (row) => {
    const totalOrders = row?.totalOrders || 0
    const revenue = roundMoney(row?.revenue)
    const completedOrders = row?.completedOrders || 0
    const pendingOrders = row?.pendingOrders || 0
    const cancelledOrders = row?.cancelledOrders || 0
    const revenueOrderCount = row?.revenueOrderCount || 0

    return {
        totalOrders,
        revenue,
        completedOrders,
        pendingOrders,
        cancelledOrders,
        averageOrderValue: revenueOrderCount > 0 ? roundMoney(revenue / revenueOrderCount) : 0,
        completionPercentage: totalOrders > 0 ? roundPercentage((completedOrders / totalOrders) * 100) : 0,
        cancellationPercentage: totalOrders > 0 ? roundPercentage((cancelledOrders / totalOrders) * 100) : 0
    }
}

const buildSeriesBuckets = ({ start, end, granularity }) => {
    const buckets = []
    if (granularity === "hour") {
        for (let hour = 0; hour < 24; hour += 1) {
            const bucketStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour)
            buckets.push({
                bucketStart,
                label: bucketStart.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
            })
        }
        return buckets
    }

    let cursor = startOfDay(start)
    while (cursor < end) {
        buckets.push({
            bucketStart: cursor,
            label: cursor.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
        })
        cursor = addDays(cursor, 1)
    }
    return buckets
}

const buildSeries = (rows, range) => {
    const rowsByBucket = new Map(
        (rows || []).map((row) => [new Date(row._id).toISOString(), row])
    )

    return buildSeriesBuckets(range).map((bucket) => {
        const row = rowsByBucket.get(bucket.bucketStart.toISOString())
        return {
            bucketStart: bucket.bucketStart.toISOString(),
            label: bucket.label,
            orders: row?.orders || 0,
            revenue: roundMoney(row?.revenue),
            completedOrders: row?.completedOrders || 0,
            cancelledOrders: row?.cancelledOrders || 0
        }
    })
}

const buildStatusDistribution = (rows) => {
    const counts = new Map((rows || []).map((row) => [row._id, row.count]))
    return STATUS_ORDER.map((status) => ({
        status,
        label: STATUS_LABELS[status],
        count: counts.get(status) || 0
    }))
}

const buildPeriodPayload = (range) => ({
    key: range.key,
    label: range.label,
    timezone: range.timezone,
    granularity: range.granularity,
    startDate: formatDateOnly(range.start),
    endDate: formatDateOnly(addDays(range.end, -1)),
    previousStartDate: formatDateOnly(range.previousStart),
    previousEndDate: formatDateOnly(addDays(range.previousEnd, -1)),
    startAt: range.start.toISOString(),
    endAt: range.end.toISOString(),
    previousStartAt: range.previousStart.toISOString(),
    previousEndAt: range.previousEnd.toISOString()
})

export const getRestaurantAnalytics = async (req, res) => {
    try {
        const requester = await User.findById(req.userId, "role").lean()
        if (!requester) {
            return res.status(401).json({ message: "Authentication required" })
        }
        if (requester.role !== "owner") {
            return res.status(403).json({ message: "Only restaurant owners can view analytics" })
        }

        const shop = await Shop.findOne({ owner: requester._id }).select("_id name").lean()
        if (!shop) {
            return res.status(404).json({ message: "Restaurant not found for this owner" })
        }

        const period = req.query.period || "last7"
        const rangeResult = resolveAnalyticsRange(period, req.query.startDate, req.query.endDate)
        if (rangeResult.error) {
            return res.status(400).json({ message: rangeResult.error })
        }
        const { range } = rangeResult

        const rows = await Order.aggregate([
            {
                $match: {
                    createdAt: { $gte: range.previousStart, $lt: range.end },
                    "shopOrders.owner": requester._id,
                    "shopOrders.shop": shop._id
                }
            },
            { $unwind: "$shopOrders" },
            {
                $match: {
                    "shopOrders.owner": requester._id,
                    "shopOrders.shop": shop._id
                }
            },
            {
                $facet: {
                    current: [
                        { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
                        { $group: summaryGroupStage }
                    ],
                    previous: [
                        { $match: { createdAt: { $gte: range.previousStart, $lt: range.previousEnd } } },
                        { $group: summaryGroupStage }
                    ],
                    statuses: [
                        { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
                        { $group: { _id: "$shopOrders.status", count: { $sum: 1 } } }
                    ],
                    series: [
                        { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
                        {
                            $group: {
                                _id: {
                                    $dateTrunc: {
                                        date: "$createdAt",
                                        unit: range.granularity,
                                        timezone: range.timezone
                                    }
                                },
                                orders: { $sum: 1 },
                                revenue: { $sum: revenueExpression },
                                completedOrders: {
                                    $sum: { $cond: [{ $eq: ["$shopOrders.status", "delivered"] }, 1, 0] }
                                },
                                cancelledOrders: {
                                    $sum: { $cond: [{ $eq: ["$shopOrders.status", "cancelled"] }, 1, 0] }
                                }
                            }
                        },
                        { $sort: { _id: 1 } }
                    ],
                    items: [
                        { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
                        { $match: { "shopOrders.status": "delivered" } },
                        { $match: { $expr: paymentSatisfiedExpression } },
                        { $unwind: "$shopOrders.shopOrderItems" },
                        {
                            $addFields: {
                                lineItem: "$shopOrders.shopOrderItems",
                                orderId: "$_id",
                                lineName: {
                                    $trim: {
                                        input: { $ifNull: ["$shopOrders.shopOrderItems.name", ""] }
                                    }
                                },
                                linePrice: { $ifNull: ["$shopOrders.shopOrderItems.price", 0] },
                                lineQuantity: { $ifNull: ["$shopOrders.shopOrderItems.quantity", 1] }
                            }
                        },
                        { $match: { lineQuantity: { $gt: 0 } } },
                        {
                            $addFields: {
                                itemGroupKey: {
                                    $cond: [
                                        { $eq: [{ $type: "$lineItem.item" }, "objectId"] },
                                        "$lineItem.item",
                                        {
                                            $concat: [
                                                "legacy:",
                                                {
                                                    $cond: [
                                                        { $gt: [{ $strLenCP: "$lineName" }, 0] },
                                                        "$lineName",
                                                        "unknown"
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                }
                            }
                        },
                        { $sort: { createdAt: 1 } },
                        {
                            $group: {
                                _id: "$itemGroupKey",
                                itemId: { $last: "$lineItem.item" },
                                historicalName: { $last: "$lineName" },
                                quantitySold: { $sum: "$lineQuantity" },
                                revenue: { $sum: { $multiply: ["$linePrice", "$lineQuantity"] } },
                                orderIds: { $addToSet: "$orderId" }
                            }
                        },
                        {
                            $lookup: {
                                from: "items",
                                let: { itemId: "$itemId", shopId: shop._id },
                                pipeline: [
                                    {
                                        $match: {
                                            $expr: {
                                                $and: [
                                                    { $eq: ["$_id", "$$itemId"] },
                                                    { $eq: ["$shop", "$$shopId"] }
                                                ]
                                            }
                                        }
                                    },
                                    { $project: { _id: 0, name: 1, image: 1 } }
                                ],
                                as: "food"
                            }
                        },
                        {
                            $project: {
                                _id: 0,
                                itemId: {
                                    $cond: [
                                        { $eq: [{ $type: "$itemId" }, "objectId"] },
                                        { $toString: "$itemId" },
                                        null
                                    ]
                                },
                                name: {
                                    $cond: [
                                        { $gt: [{ $strLenCP: { $ifNull: ["$historicalName", ""] } }, 0] },
                                        "$historicalName",
                                        { $ifNull: [{ $arrayElemAt: ["$food.name", 0] }, "Deleted item"] }
                                    ]
                                },
                                image: { $ifNull: [{ $arrayElemAt: ["$food.image", 0] }, null] },
                                quantitySold: 1,
                                revenue: 1,
                                orderCount: { $size: "$orderIds" }
                            }
                        },
                        { $sort: { quantitySold: -1, orderCount: -1, revenue: -1, name: 1 } }
                    ]
                }
            }
        ]).exec()

        const facet = rows[0] || {}
        const summary = facet.current?.[0] ? toSummary(facet.current[0]) : emptySummary()
        const previous = facet.previous?.[0] ? toSummary(facet.previous[0]) : emptySummary()
        const { bestSellers, foodPerformance } = buildFoodPerformance(facet.items)

        return res.status(200).json({
            shop: {
                _id: String(shop._id),
                name: shop.name
            },
            period: buildPeriodPayload(range),
            summary,
            previous,
            statusDistribution: buildStatusDistribution(facet.statuses),
            series: buildSeries(facet.series, range),
            bestSellers,
            foodPerformance
        })
    } catch (error) {
        console.error("restaurant analytics failed:", {
            name: error?.name,
            message: error?.message
        })
        return res.status(500).json({ message: "Failed to load restaurant analytics. Please try again." })
    }
}
