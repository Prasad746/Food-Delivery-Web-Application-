import mongoose from "mongoose"
import Order from "../models/order.model.js"
import { CANCELLABLE_ORDER_STATUSES } from "../controllers/order.controllers.js"
import {
    CANCELLATION_QUICK_REPLIES,
    DEFAULT_QUICK_REPLIES,
    ORDER_QUICK_REPLIES,
    PAYMENT_QUICK_REPLIES,
    SUPPORT_FAQS
} from "./supportKnowledge.js"

const ORDER_SELECT = [
    "-shopOrders.deliveryOtp",
    "-shopOrders.otpExpires",
    "-shopOrders.otpAttempts",
    "-shopOrders.refund.razorpayRefundId",
    "-shopOrders.refund.failureReason",
    "-shopOrders.refund.attempts",
    "-shopOrders.refund.lastAttemptAt",
    "-razorpayOrderId",
    "-razorpayPaymentId"
].join(" ")

const ORDER_LINKS = Object.freeze([
    { label: "My Orders", path: "/my-orders" },
    { label: "Home", path: "/" }
])

const STATUS_LABELS = Object.freeze({
    pending: "pending",
    preparing: "preparing",
    "out of delivery": "out of delivery",
    delivered: "delivered",
    cancelled: "cancelled"
})

const normalizeMessage = (message = "") =>
    String(message)
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ")
        .trim()

const normalizeMoney = (value) => Math.round((Number(value) || 0) * 100) / 100

const formatMoney = (value) => `₹${normalizeMoney(value).toLocaleString("en-IN")}`

const formatDate = (value) => {
    if (!value) return ""
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
    })
}

const isPaymentSatisfied = (order) =>
    order?.paymentMethod === "cod" || order?.payment === true

const buildResponse = ({
    intent,
    reply,
    quickReplies = DEFAULT_QUICK_REPLIES,
    links = [],
    order
}) => ({
    success: true,
    intent,
    reply,
    quickReplies: [...quickReplies],
    links: links.map((link) => ({ ...link })),
    ...(order !== undefined ? { data: { order } } : {})
})

const populateOrder = (query) =>
    query
        .select(ORDER_SELECT)
        .populate("shopOrders.shop", "name")
        .populate("shopOrders.assignedDeliveryBoy", "fullName")
        .populate("shopOrders.shopOrderItems.item", "name")
        .lean()

const findLatestOwnedOrder = (userId) =>
    populateOrder(Order.findOne({ user: userId }).sort({ createdAt: -1, _id: -1 }))

const findOwnedOrderById = (orderId, userId) => {
    if (!mongoose.isValidObjectId(orderId)) return null
    return populateOrder(Order.findOne({ _id: orderId, user: userId }))
}

const findOwnedOrderByReference = async (reference, userId) => {
    const candidates = await Order.find({ user: userId })
        .select("_id")
        .sort({ createdAt: -1, _id: -1 })
        .lean()
    const match = candidates.find((order) =>
        String(order._id).toLowerCase().endsWith(reference.toLowerCase())
    )
    if (!match) return null
    return findOwnedOrderById(match._id, userId)
}

const getShopName = (shopOrder) => {
    if (shopOrder?.shop && typeof shopOrder.shop === "object" && shopOrder.shop.name) {
        return shopOrder.shop.name
    }
    return "Restaurant"
}

const getDeliveryPartnerName = (shopOrder) => {
    const partner = shopOrder?.assignedDeliveryBoy
    if (partner && typeof partner === "object" && partner.fullName) {
        return partner.fullName
    }
    return null
}

const buildOrderView = (order) => {
    if (!order) return null

    const shopOrders = Array.isArray(order.shopOrders) ? order.shopOrders : []
    const mappedShopOrders = shopOrders.map((shopOrder) => {
        const items = Array.isArray(shopOrder.shopOrderItems)
            ? shopOrder.shopOrderItems.map((line) => ({
                  name: line?.name || line?.item?.name || "Item",
                  quantity: Number(line?.quantity) || 0,
                  price: normalizeMoney(line?.price)
              }))
            : []
        const refund = shopOrder?.refund

        return {
            shopName: getShopName(shopOrder),
            status: shopOrder?.status || "pending",
            itemCount: items.length,
            totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
            subtotal: normalizeMoney(shopOrder?.subtotal),
            items,
            deliveryPartner: getDeliveryPartnerName(shopOrder)
                ? { name: getDeliveryPartnerName(shopOrder) }
                : null,
            canCancel:
                CANCELLABLE_ORDER_STATUSES.includes(shopOrder?.status) &&
                !shopOrder?.assignment &&
                !shopOrder?.assignedDeliveryBoy &&
                isPaymentSatisfied(order),
            cancellationReason: shopOrder?.cancellationReason || "",
            refund:
                refund && refund.status && refund.status !== "not_required"
                    ? {
                          status: refund.status,
                          amount: normalizeMoney(refund.amount)
                      }
                    : null
        }
    })

    const paymentStatus =
        order.paymentMethod === "cod"
            ? "cash_on_delivery"
            : order.payment === true
              ? "confirmed"
              : "not_confirmed"

    return {
        reference: String(order._id || "").slice(-6).toLowerCase(),
        createdAt: order.createdAt || null,
        totalAmount: normalizeMoney(order.totalAmount),
        paymentMethod: order.paymentMethod === "online" ? "online" : "cod",
        paymentStatus,
        canCancel: mappedShopOrders.some((shopOrder) => shopOrder.canCancel),
        trackingPath: `/track-order/${order._id}`,
        liveTrackingAvailable: mappedShopOrders.some(
            (shopOrder) =>
                shopOrder.deliveryPartner &&
                !["delivered", "cancelled"].includes(shopOrder.status)
        ),
        shopOrders: mappedShopOrders
    }
}

const resolveOrderContext = async ({ message, userId, contextOrderId }) => {
    const objectIdMatch = message.match(/\b[a-f0-9]{24}\b/i)
    if (objectIdMatch) {
        const order = await findOwnedOrderById(objectIdMatch[0], userId)
        return {
            order,
            kind: order ? "specific" : "not_found",
            requestedReference: `#${objectIdMatch[0].slice(-6).toLowerCase()}`
        }
    }

    const referenceMatch =
        message.match(/#\s*([a-f0-9]{6})\b/i) ||
        message.match(/\border\s*#?\s*([a-f0-9]{6})\b/i)
    if (referenceMatch) {
        const reference = referenceMatch[1].toLowerCase()
        const order = await findOwnedOrderByReference(reference, userId)
        return {
            order,
            kind: order ? "specific" : "not_found",
            requestedReference: `#${reference}`
        }
    }

    const asksForLatest = /\b(latest|last|recent|newest|current)\b/.test(message)
    if (!asksForLatest && contextOrderId && mongoose.isValidObjectId(contextOrderId)) {
        const order = await findOwnedOrderById(contextOrderId, userId)
        if (order) {
            return { order, kind: "context" }
        }
    }

    const order = await findLatestOwnedOrder(userId)
    return { order, kind: order ? "latest" : "none" }
}

const matchesKeyword = (message, keyword) => {
    const escaped = keyword
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+")
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(message)
}

const findFaq = (message) => {
    let bestMatch = null

    for (const faq of SUPPORT_FAQS) {
        let score = 0
        for (const keyword of faq.keywords) {
            if (matchesKeyword(message, keyword)) {
                score += keyword.split(" ").length
            }
        }
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { faq, score }
        }
    }

    return bestMatch?.faq || null
}

const isCancellationRequest = (message) => {
    if (/\bcart\b/.test(message)) return false

    const asksAboutCancelledOrderStatus =
        /\b(?:is|was|has|did)\b.*\border\b.*\bcancelled\b/.test(message) ||
        (/\bcancelled\s+order\b/.test(message) && /\bstatus\b/.test(message))
    if (asksAboutCancelledOrderStatus) return false

    const mentionsCancellation = /\bcancel/.test(message) || /\bcancellation\b/.test(message)
    if (mentionsCancellation) return true

    if (/\brefunds?\b/.test(message) || /\bmoney back\b/.test(message)) {
        return !/\b(status|when|processed|pending|failed|received|where|track|tracking|how long)\b/.test(
            message
        )
    }

    return false
}

const isPaymentStatusQuestion = (message) => {
    const mentionsPayment = /\b(payments?|paid|refunds?|razorpay|charged?)\b/.test(message)
    const asksForStatus =
        /\b(status|failed|fail|successful|success|confirmed|confirm|deducted|charged|went through|completed|complete|done|processed|pending|received|when will|when do|when can|where|how long)\b/.test(
            message
        )
    return mentionsPayment && asksForStatus
}

const isOrderStatusQuestion = (message) => {
    const patterns = [
        /\bwhere(?:'s| is)\b.*\b(?:order|food|delivery)\b/,
        /\b(?:order|food|delivery)\b.*\b(status|update)\b/,
        /\b(status|update)\b.*\b(?:order|food|delivery)\b/,
        /\b(?:my|the)\s+orders?\b/,
        /\b(?:my|the)\s+food\b/,
        /\bmy\s+delivery\s+(?:status|update|arrive|arriving|coming|late|here|today)\b/,
        /\b(?:is|has|was|did|when will|when did|how long)\b.*\bmy\s+(?:order|food|delivery)\b/,
        /\b(?:track|tracking)\b.*\border\b/,
        /\border\b.*\b(?:track|tracking)\b/,
        /\b(?:latest|last|recent|newest|current)\s+(?:order|food|delivery)\b/
    ]
    return patterns.some((pattern) => pattern.test(message))
}

const orderReferencePrefix = (view, selection) => {
    if (selection.kind === "latest") {
        return `Your latest order #${view.reference}`
    }
    if (selection.kind === "context") {
        return `Your selected order #${view.reference}`
    }
    return `Order #${view.reference}`
}

const buildNoOrderMessage = (selection) => {
    if (selection.kind === "not_found") {
        return `I couldn't find ${selection.requestedReference || "that order"} in your account. I can only show orders linked to the account you are signed in with.`
    }
    return "You don't have any orders in this account yet. Browse food from the Home dashboard to place your first order."
}

const buildOrderStatusResponse = (view, selection) => {
    const prefix = orderReferencePrefix(view, selection)
    const placedOn = formatDate(view.createdAt)
    const statuses = view.shopOrders.length
        ? view.shopOrders
              .map(
                  (shopOrder) =>
                      `${shopOrder.shopName}: ${
                          STATUS_LABELS[shopOrder.status] || shopOrder.status
                      }`
              )
              .join("; ")
        : "pending"

    const parts = [
        `${prefix}${placedOn ? ` was placed on ${placedOn}` : ""} for ${formatMoney(view.totalAmount)}.`,
        `Status: ${statuses}.`
    ]

    if (view.paymentMethod === "cod") {
        parts.push("Payment: Cash on Delivery, pay when the order arrives.")
    } else if (view.paymentStatus === "confirmed") {
        parts.push("Payment: online payment confirmed.")
    } else {
        parts.push("Payment: online payment not confirmed.")
    }

    const deliveryPartners = view.shopOrders
        .filter((shopOrder) => shopOrder.deliveryPartner)
        .map((shopOrder) => `${shopOrder.deliveryPartner.name} (${shopOrder.shopName})`)
    if (deliveryPartners.length) {
        parts.push(`Delivery partner: ${deliveryPartners.join(", ")}.`)
    } else if (
        view.shopOrders.some(
            (shopOrder) => !["delivered", "cancelled"].includes(shopOrder.status)
        )
    ) {
        parts.push("No delivery partner is assigned yet.")
    }

    if (view.liveTrackingAvailable) {
        parts.push("Open Track Order for live delivery updates.")
    }
    if (
        view.shopOrders.length &&
        view.shopOrders.every((shopOrder) => shopOrder.status === "delivered")
    ) {
        parts.push("Every restaurant part of this order is delivered.")
    }
    if (view.shopOrders.some((shopOrder) => shopOrder.status === "cancelled")) {
        parts.push("Cancelled restaurant parts and refund details are shown in My Orders.")
    }

    return buildResponse({
        intent: "order_status",
        reply: parts.join(" "),
        quickReplies: ORDER_QUICK_REPLIES,
        links: [
            { label: "Track Order", path: view.trackingPath },
            { label: "My Orders", path: "/my-orders" }
        ],
        order: view
    })
}

const buildPaymentStatusResponse = (view, selection) => {
    const prefix = orderReferencePrefix(view, selection)
    const parts = []

    if (view.paymentMethod === "cod") {
        parts.push(
            `${prefix} uses Cash on Delivery. Pay the rider when the order is delivered, and no online payment needs verification.`
        )
    } else if (view.paymentStatus === "confirmed") {
        parts.push(`${prefix} has a confirmed online payment.`)
    } else {
        parts.push(
            `${prefix} does not have a confirmed online payment. If money was deducted, check My Orders for the latest status before trying another payment.`
        )
    }

    const refunds = view.shopOrders
        .filter((shopOrder) => shopOrder.refund)
        .map(
            (shopOrder) =>
                `${shopOrder.shopName}: refund status ${shopOrder.refund.status}${
                    shopOrder.refund.amount > 0
                        ? ` for ${formatMoney(shopOrder.refund.amount)}`
                        : ""
                }`
        )
    if (refunds.length) {
        parts.push(`Refund: ${refunds.join("; ")}.`)
    }

    parts.push("The chatbot cannot initiate a payment or refund.")

    return buildResponse({
        intent: "payment_status",
        reply: parts.join(" "),
        quickReplies: PAYMENT_QUICK_REPLIES,
        links: [
            { label: "My Orders", path: "/my-orders" },
            { label: "Track Order", path: view.trackingPath }
        ],
        order: view
    })
}

const buildCancellationResponse = (view, selection) => {
    const policy =
        "You can cancel only an eligible restaurant part while it is pending or preparing. Cancellation is blocked once a delivery partner is assigned, and it is not available once out of delivery or delivered. Online orders need confirmed payment before cancellation. An eligible online refund covers the restaurant subtotal for the cancelled part, not the checkout delivery fee. Use My Orders to cancel; the chatbot cannot change or refund an order."

    if (!view) {
        return buildResponse({
            intent: "cancellation_info",
            reply: `${policy} ${buildNoOrderMessage(selection)}`,
            quickReplies: CANCELLATION_QUICK_REPLIES,
            links: ORDER_LINKS,
            order: null
        })
    }

    const prefix = orderReferencePrefix(view, selection)
    const cancellable = view.shopOrders.filter((shopOrder) => shopOrder.canCancel)
    let orderStatus

    if (cancellable.length) {
        orderStatus = `For ${prefix}, you can currently cancel: ${cancellable
            .map((shopOrder) => shopOrder.shopName)
            .join(", ")}.`
    } else {
        const statuses = view.shopOrders
            .map((shopOrder) => `${shopOrder.shopName}: ${shopOrder.status}`)
            .join("; ")
        orderStatus = `For ${prefix}, no restaurant part is currently eligible for self-service cancellation.${
            statuses ? ` Current statuses: ${statuses}.` : ""
        }`
    }

    const refunds = view.shopOrders
        .filter((shopOrder) => shopOrder.refund)
        .map(
            (shopOrder) =>
                `${shopOrder.shopName}: refund status ${shopOrder.refund.status}${
                    shopOrder.refund.amount > 0
                        ? ` for ${formatMoney(shopOrder.refund.amount)}`
                        : ""
                }`
        )
    if (refunds.length) {
        orderStatus += ` Refund: ${refunds.join("; ")}.`
    }

    return buildResponse({
        intent: "cancellation_info",
        reply: `${policy} ${orderStatus}`,
        quickReplies: CANCELLATION_QUICK_REPLIES,
        links: [
            { label: "Manage in My Orders", path: "/my-orders" },
            { label: "Track Order", path: view.trackingPath }
        ],
        order: view
    })
}

const buildPaymentNoOrderResponse = (selection) => {
    const noOrder = buildNoOrderMessage(selection)
    return buildResponse({
        intent: "payment_status",
        reply: `${noOrder} There is no payment record for this account to check.`,
        quickReplies: PAYMENT_QUICK_REPLIES,
        links: ORDER_LINKS,
        order: null
    })
}

export const handleSupportMessage = async ({ message, userId, contextOrderId }) => {
    const normalizedMessage = normalizeMessage(message)

    if (isCancellationRequest(normalizedMessage)) {
        const selection = await resolveOrderContext({
            message: normalizedMessage,
            userId,
            contextOrderId
        })
        return buildCancellationResponse(buildOrderView(selection.order), selection)
    }

    if (isPaymentStatusQuestion(normalizedMessage)) {
        const selection = await resolveOrderContext({
            message: normalizedMessage,
            userId,
            contextOrderId
        })
        const view = buildOrderView(selection.order)
        return view
            ? buildPaymentStatusResponse(view, selection)
            : buildPaymentNoOrderResponse(selection)
    }

    if (isOrderStatusQuestion(normalizedMessage)) {
        const selection = await resolveOrderContext({
            message: normalizedMessage,
            userId,
            contextOrderId
        })
        const view = buildOrderView(selection.order)
        if (!view) {
            return buildResponse({
                intent: "order_status",
                reply: `${buildNoOrderMessage(selection)} You can view orders from My Orders.`,
                quickReplies: ORDER_QUICK_REPLIES,
                links: ORDER_LINKS,
                order: null
            })
        }
        return buildOrderStatusResponse(view, selection)
    }

    const faq = findFaq(normalizedMessage)
    if (faq) {
        return buildResponse({
            intent: faq.intent,
            reply: faq.reply,
            quickReplies: faq.quickReplies,
            links: faq.links
        })
    }

    if (
        /^(hi|hello|hey|namaste|good morning|good afternoon|good evening)\b[\s!.,]*$/.test(
            normalizedMessage
        )
    ) {
        return buildResponse({
            intent: "greeting",
            reply:
                "Hi! I can help with order status and tracking, cancellations, payments, delivery fees, your account, and finding your way around Vingo. What would you like help with?",
            quickReplies: DEFAULT_QUICK_REPLIES,
            links: []
        })
    }

    if (/^(thanks|thank you|thx|ok thanks|okay thanks)\b/.test(normalizedMessage)) {
        return buildResponse({
            intent: "thanks",
            reply:
                "You're welcome! I'm here if you need help with orders, payments, cancellations, or using Vingo.",
            quickReplies: DEFAULT_QUICK_REPLIES,
            links: []
        })
    }

    if (
        /^(help|support|what can you do|how can you help|can you help)\b/.test(
            normalizedMessage
        )
    ) {
        return buildResponse({
            intent: "help",
            reply:
                "I can help with order status and tracking, cancellations, payments, delivery fees, your account, restaurant and menu information, and website navigation. Ask about your latest order, or choose one of the suggestions below.",
            quickReplies: DEFAULT_QUICK_REPLIES,
            links: [ORDER_LINKS[0], { label: "Home", path: "/" }]
        })
    }

    return buildResponse({
        intent: "unknown",
        reply:
            "I can help with order status and tracking, cancellations, payments, delivery fees, your account, and using Vingo. I don't have information about that request. For a specific order issue, open My Orders.",
        quickReplies: DEFAULT_QUICK_REPLIES,
        links: [
            { label: "My Orders", path: "/my-orders" },
            { label: "Home", path: "/" }
        ]
    })
}
