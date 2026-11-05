import crypto from "crypto"
import mongoose from "mongoose"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"
import Order from "../models/order.model.js"
import Item from "../models/item.model.js"
import Shop from "../models/shop.model.js"
import User from "../models/user.model.js"
import { roomForUser } from "../socket.js"
import { isMailConfigError, sendDeliveryOtpMail } from "../utils/mail.js"
import { validateCancellationBody, validateDeliveryAddressBody } from "../utils/validate.js"
import { calculateItemPricing, normalizeMoney } from "../utils/pricing.js"
import RazorPay from "razorpay"
import dotenv from "dotenv"
import { isProduction } from "../config/security.js"

dotenv.config()

const MAX_ITEM_QUANTITY = 99

const deliveryFeeFor = (subtotal) => (subtotal > 500 ? 0 : 40)

export const ONLINE_PAYMENT_REQUIRED_MESSAGE = "Online order payment has not been confirmed"

const isFulfillmentPaymentSatisfied = (order) =>
    order?.paymentMethod === "cod" || order?.payment === true

const fulfillmentPaymentFilter = () => ({
    $or: [{ paymentMethod: "cod" }, { payment: true }]
})

// Delivery-OTP material is only meant for the assigned delivery partner's
// OTP endpoints. Every order document leaving the API is scrubbed so the
// customer, shop owner, or rider responses can never carry a usable code.
const stripDeliveryOtpFields = (orderDoc) => {
    if (!orderDoc) return orderDoc
    const plainOrder = typeof orderDoc.toObject === "function" ? orderDoc.toObject() : orderDoc
    for (const shopOrder of plainOrder.shopOrders || []) {
        if (!shopOrder) continue
        delete shopOrder.deliveryOtp
        delete shopOrder.otpExpires
        delete shopOrder.otpAttempts
    }
    return plainOrder
}

const assignmentSummary = (assignmentId, shopName, shopOrder) => ({
    assignmentId,
    shopName: shopName || "",
    itemCount: (shopOrder?.shopOrderItems || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
    subtotal: shopOrder?.subtotal ?? 0
})

export const MAX_DELIVERY_OTP_ATTEMPTS = 5

export const ORDER_STATUSES = Object.freeze(["pending", "preparing", "out of delivery", "delivered"])

export const CANCELLABLE_ORDER_STATUSES = Object.freeze(["pending", "preparing"])

export const ORDER_CANCELLED_STATUS = "cancelled"

export const ORDER_CANCEL_NOT_ALLOWED_MESSAGE = "Order can no longer be cancelled once it is out for delivery or delivered"

export const ORDER_CANCEL_CONFLICT_MESSAGE = "Order status changed while processing. Please refresh and try again."

export const ORDER_CANCEL_REFUND_DETAILS_MESSAGE = "Online payment details are unavailable. Please contact support."

export const ORDER_CANCEL_REFUND_FAILED_MESSAGE = "Order cancelled, but the refund could not be initiated. Please contact support."

// The delivery OTP handshake only belongs to the delivery stage. "delivered"
// remains reserved for successful OTP verification.
export const DELIVERY_OTP_STATUS = "out of delivery"

// Explicit lifecycle allow-list: forward progress, same-status retries for the
// owner broadcast, and no backward movement. "delivered" has no owner-driven
// outgoing transitions at all.
export const ORDER_STATUS_TRANSITIONS = Object.freeze({
    pending: Object.freeze(["pending", "preparing", "out of delivery"]),
    preparing: Object.freeze(["preparing", "out of delivery"]),
    "out of delivery": Object.freeze(["out of delivery"]),
    delivered: Object.freeze([])
})

export const canTransitionOrderStatus = (fromStatus, toStatus) => {
    if (toStatus === "delivered") {
        return false
    }
    return Boolean(ORDER_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus))
}

const statusesThatCanTransitionTo = (toStatus) =>
    ORDER_STATUSES.filter((fromStatus) => canTransitionOrderStatus(fromStatus, toStatus))

export const ORDER_STATUS_TRANSITION_CONFLICT_MESSAGE = "Order status transition is not allowed from its current lifecycle stage"

let razorpayClientOverride = null

export const setRazorpayClientForTesting = (client) => {
    if (isProduction()) {
        return
    }
    razorpayClientOverride = client
}

export const getRazorpayInstance = () => {
    if (razorpayClientOverride) {
        return razorpayClientOverride
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error("Payment configuration error")
    }
    return new RazorPay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
};

export const verifyRazorpaySignature = (orderId, paymentId, signature, secret) => {
    if (!orderId || !paymentId || !signature || !secret) {
        return false;
    }
    const body = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

    if (expectedSignature.length !== signature.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
};

const claimShopOrderRefund = async (order, shopOrder) => {
    const now = new Date()
    const claimedOrder = await Order.findOneAndUpdate(
        {
            _id: order._id,
            payment: true,
            shopOrders: {
                $elemMatch: {
                    _id: shopOrder._id,
                    status: ORDER_CANCELLED_STATUS,
                    "refund.status": "pending"
                }
            }
        },
        {
            $set: {
                "shopOrders.$[so].refund.status": "processing",
                "shopOrders.$[so].refund.failureReason": "",
                "shopOrders.$[so].refund.lastAttemptAt": now
            },
            $inc: { "shopOrders.$[so].refund.attempts": 1 }
        },
        {
            new: true,
            arrayFilters: [{
                "so._id": shopOrder._id,
                "so.status": ORDER_CANCELLED_STATUS,
                "so.refund.status": "pending"
            }]
        }
    )

    return claimedOrder?.shopOrders.id(shopOrder._id)?.refund || null
}

const processShopOrderRefund = async (order, shopOrder, amount) => {
    const claimedRefund = await claimShopOrderRefund(order, shopOrder)
    if (!claimedRefund) {
        const currentOrder = await Order.findById(order._id)
        return currentOrder?.shopOrders.id(shopOrder._id)?.refund || null
    }

    let gatewayRefund
    try {
        if (!order.razorpayPaymentId) {
            throw new Error("Missing Razorpay payment id")
        }
        const razorpay = getRazorpayInstance()
        gatewayRefund = await razorpay.payments.refund(order.razorpayPaymentId, {
            amount: Math.round(amount * 100),
            notes: {
                orderId: String(order._id),
                shopOrderId: String(shopOrder._id),
                reason: "Customer cancelled shop order"
            }
        })
    } catch (error) {
        console.error("cancel order: refund request failed", {
            orderId: String(order._id),
            shopOrderId: String(shopOrder._id),
            message: error?.message || "unknown error"
        })
        const failureReason = ORDER_CANCEL_REFUND_FAILED_MESSAGE
        await Order.updateOne(
            {
                _id: order._id,
                shopOrders: {
                    $elemMatch: {
                        _id: shopOrder._id,
                        status: ORDER_CANCELLED_STATUS,
                        "refund.status": "processing"
                    }
                }
            },
            {
                $set: {
                    "shopOrders.$.refund.status": "failed",
                    "shopOrders.$.refund.failureReason": failureReason
                }
            }
        )
        return {
            status: "failed",
            amount,
            razorpayRefundId: "",
            processedAt: null,
            failureReason,
            attempts: claimedRefund.attempts,
            lastAttemptAt: claimedRefund.lastAttemptAt
        }
    }

    const processedAt = new Date()
    try {
        await Order.updateOne(
            {
                _id: order._id,
                shopOrders: {
                    $elemMatch: {
                        _id: shopOrder._id,
                        status: ORDER_CANCELLED_STATUS,
                        "refund.status": "processing"
                    }
                }
            },
            {
                $set: {
                    "shopOrders.$.refund.status": "processed",
                    "shopOrders.$.refund.razorpayRefundId": gatewayRefund?.id || "",
                    "shopOrders.$.refund.processedAt": processedAt,
                    "shopOrders.$.refund.failureReason": ""
                }
            }
        )
    } catch (error) {
        console.error("cancel order: refund succeeded but status update failed", {
            orderId: String(order._id),
            shopOrderId: String(shopOrder._id),
            refundId: gatewayRefund?.id || "",
            message: error?.message || "unknown error"
        })
        return {
            status: "processing",
            amount,
            razorpayRefundId: gatewayRefund?.id || "",
            processedAt: null,
            failureReason: "",
            attempts: claimedRefund.attempts,
            lastAttemptAt: claimedRefund.lastAttemptAt
        }
    }

    return {
        status: "processed",
        amount,
        razorpayRefundId: gatewayRefund?.id || "",
        processedAt,
        failureReason: "",
        attempts: claimedRefund.attempts,
        lastAttemptAt: claimedRefund.lastAttemptAt
    }
}

const emitToUserRoom = (io, userId, event, payload) => {
    if (!io || !userId) {
        return
    }
    const room = roomForUser(userId)
    io.to(room).emit(event, payload)
}

const emitShopOrderCancellation = (io, order, shopOrder, refund) => {
    if (!io) {
        return
    }
    const payload = {
        orderId: String(order._id),
        shopId: String(shopOrder.shop),
        shopOrderId: String(shopOrder._id),
        status: ORDER_CANCELLED_STATUS,
        userId: String(order.user),
        ownerId: shopOrder.owner ? String(shopOrder.owner) : "",
    cancelledAt: shopOrder.cancelledAt,
    cancellationReason: shopOrder.cancellationReason,
    refund
    }
    emitToUserRoom(io, order.user, "update-status", payload)
    emitToUserRoom(io, shopOrder.owner, "update-status", payload)
}

const cancellationResponseShopOrder = (shopOrder) => {
    const safeShopOrder = typeof shopOrder.toObject === "function" ? shopOrder.toObject() : { ...shopOrder }
    delete safeShopOrder.deliveryOtp
    delete safeShopOrder.otpExpires
    delete safeShopOrder.otpAttempts
    return safeShopOrder
}

const finalizeCancelledShopOrder = async (order, shopOrder) => {
    if (order.paymentMethod === "online" && shopOrder.refund?.status === "pending") {
        const amount = normalizeMoney(Number(shopOrder.subtotal) || 0)
        let refund = null
        if (amount > 0) {
            refund = await processShopOrderRefund(order, shopOrder, amount)
        } else {
            const existingRefund = typeof shopOrder.refund.toObject === "function"
                ? shopOrder.refund.toObject()
                : { ...shopOrder.refund }
            refund = { ...existingRefund, status: "not_required", amount: 0 }
        }
        if (refund) {
            shopOrder.refund = refund
        }
    }
    return cancellationResponseShopOrder(shopOrder)
}

const cancellationMessageFor = (refund) => {
    if (refund?.status === "failed") {
        return ORDER_CANCEL_REFUND_FAILED_MESSAGE
    }
    if (refund?.status === "processing") {
        return "Order cancelled. Refund is being processed."
    }
    if (refund?.status === "processed") {
        return "Order cancelled successfully. Refund has been initiated."
    }
    return "Order cancelled successfully"
}

export const placeOrder = async (req, res) => {
    try {
        const { cartItems, paymentMethod, deliveryAddress } = req.body
        if (!Array.isArray(cartItems) || cartItems.length === 0) {
            return res.status(400).json({ message: "cart is empty" })
        }
        const addressCheck = validateDeliveryAddressBody(deliveryAddress)
        if (addressCheck.error || !addressCheck.address) {
            return res.status(400).json({ message: "send complete deliveryAddress" })
        }
        const address = addressCheck.address

        const groupedLines = new Map()

        for (const line of cartItems) {
            if (typeof line?.shop !== "string" || !mongoose.isValidObjectId(line.shop)) {
                return res.status(400).json({ message: "invalid shop id in cart" })
            }
            if (typeof line?.id !== "string" || !mongoose.isValidObjectId(line.id)) {
                return res.status(400).json({ message: "invalid item id in cart" })
            }
            if (!Number.isInteger(line?.quantity) || line.quantity <= 0 || line.quantity > MAX_ITEM_QUANTITY) {
                return res.status(400).json({ message: "invalid item quantity in cart" })
            }
            const existingLines = groupedLines.get(line.shop) || []
            existingLines.push(line)
            groupedLines.set(line.shop, existingLines)
        }

        const shopOrders = []
        for (const [shopId, lines] of groupedLines) {
            const shop = await Shop.findById(shopId).populate("owner")
            if (!shop) {
                return res.status(400).json({ message: "shop not found" })
            }
            if (!shop.owner) {
                return res.status(400).json({ message: "shop owner not found" })
            }
            const shopOrderItems = []
            for (const line of lines) {
                const item = await Item.findById(line.id)
                if (!item) {
                    return res.status(400).json({ message: "item not found" })
                }
                if (item.isAvailable === false) {
                    return res.status(400).json({ message: "item is not available" })
                }
                if (!item.shop || String(item.shop) !== String(shop._id)) {
                    return res.status(400).json({ message: "item does not belong to the selected shop" })
                }
                const dbPrice = Number(item.price)
                if (!Number.isFinite(dbPrice) || dbPrice < 0) {
                    return res.status(400).json({ message: "item price is invalid" })
                }
                const pricing = calculateItemPricing(item)
                shopOrderItems.push({
                    item: item._id,
                    name: item.name,
                    price: pricing.finalPrice,
                    originalPrice: pricing.originalPrice,
                    discountType: pricing.discountType,
                    discountValue: pricing.discountValue,
                    discountAmount: pricing.discountAmount,
                    finalPrice: pricing.finalPrice,
                    quantity: line.quantity
                })
            }
            const subtotal = normalizeMoney(shopOrderItems.reduce((sum, i) => sum + i.finalPrice * i.quantity, 0))
            shopOrders.push({
                shop: shop._id,
                owner: shop.owner._id,
                subtotal,
                shopOrderItems
            })
        }

        const cartSubtotal = normalizeMoney(shopOrders.reduce((sum, shopOrder) => sum + shopOrder.subtotal, 0))
        const payableTotal = normalizeMoney(cartSubtotal + deliveryFeeFor(cartSubtotal))
        if (!Number.isFinite(payableTotal) || payableTotal <= 0) {
            return res.status(400).json({ message: "order total must be a positive amount" })
        }

        if (paymentMethod !== "cod" && paymentMethod !== "online") {
            return res.status(400).json({ message: "invalid payment method" })
        }

        if (paymentMethod === "online") {
            if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
                console.error("Razorpay credentials are missing for online order placement")
                return res.status(500).json({ message: "Payment configuration error" })
            }

            const razorpay = getRazorpayInstance()

            const newOrder = await Order.create({
                user: req.userId,
                paymentMethod,
                deliveryAddress: address,
                totalAmount: payableTotal,
                shopOrders,
                razorpayOrderId: "",
                payment: false
            })

            try {
                const razorOrder = await razorpay.orders.create({
                    amount: Math.round(payableTotal * 100),
                    currency: 'INR',
                    receipt: `receipt_${Date.now()}`,
                    notes: { internalOrderId: String(newOrder._id) }
                })

                newOrder.razorpayOrderId = razorOrder.id
                await newOrder.save()

                return res.status(200).json({
                    razorOrder,
                    orderId: newOrder._id,
                })
            } catch (gatewayError) {
                await Order.deleteOne({ _id: newOrder._id, payment: false, razorpayOrderId: "" })
                throw gatewayError
            }
        }

        const newOrder = await Order.create({
            user: req.userId,
            paymentMethod,
            deliveryAddress: address,
            totalAmount: payableTotal,
            shopOrders
        })

        await newOrder.populate("shopOrders.shopOrderItems.item", "name image price")
        await newOrder.populate("shopOrders.shop", "name")
        await newOrder.populate("shopOrders.owner", "fullName")
        await newOrder.populate("user", "fullName mobile")
        const orderResponse = stripDeliveryOtpFields(newOrder)

        const io = req.app.get('io')

        if (io) {
            orderResponse.shopOrders.forEach(shopOrder => {
                const ownerId = shopOrder.owner._id
                if (ownerId) {
                    io.to(roomForUser(ownerId)).emit('newOrder', {
                        _id: orderResponse._id,
                        paymentMethod: orderResponse.paymentMethod,
                        user: orderResponse.user,
                        shopOrders: shopOrder,
                        createdAt: orderResponse.createdAt,
                        deliveryAddress: orderResponse.deliveryAddress,
                        payment: orderResponse.payment
                    })
                }
            });
        }



        return res.status(201).json(orderResponse)
    } catch (error) {
        return res.status(500).json({ message: "Failed to place order. Please try again." })
    }
}

export const verifyPayment = async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId } = req.body

        if (!razorpay_payment_id || !orderId) {
            return res.status(400).json({ message: "Payment ID and order ID are required" })
        }

        const order = await Order.findById(orderId)
        if (!order) {
            return res.status(404).json({ message: "Order not found" })
        }

        if (order.user.toString() !== req.userId.toString()) {
            return res.status(403).json({ message: "Unauthorized for this order" })
        }

        // Idempotency: prevent duplicate processing or duplicate event emissions
        if (order.payment === true) {
            await order.populate("shopOrders.shopOrderItems.item", "name image price")
            await order.populate("shopOrders.shop", "name")
            await order.populate("shopOrders.owner", "fullName")
            await order.populate("user", "fullName mobile")
            const orderResponse = stripDeliveryOtpFields(order)
            return res.status(200).json(orderResponse)
        }

        const expectedRazorpayOrderId = order.razorpayOrderId
        if (!expectedRazorpayOrderId) {
            return res.status(400).json({ message: "Order was not created for online payment" })
        }

        if (razorpay_order_id && razorpay_order_id !== expectedRazorpayOrderId) {
            return res.status(400).json({ message: "Razorpay order ID mismatch" })
        }

        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            console.error("Razorpay configuration is incomplete for payment verification")
            return res.status(500).json({ message: "Payment verification configuration error" })
        }

        const secret = process.env.RAZORPAY_KEY_SECRET

        if (!razorpay_signature) {
            return res.status(400).json({ message: "Payment signature is required" })
        }

        const isSignatureValid = verifyRazorpaySignature(
            expectedRazorpayOrderId,
            razorpay_payment_id,
            razorpay_signature,
            secret
        )

        if (!isSignatureValid) {
            return res.status(400).json({ message: "Invalid payment signature" })
        }

        const razorpay = getRazorpayInstance()
        const payment = await razorpay.payments.fetch(razorpay_payment_id)
        if (!payment) {
            return res.status(400).json({ message: "Payment record not found on gateway" })
        }

        if (payment.status !== "captured") {
            return res.status(400).json({ message: `Payment not captured. Status: ${payment.status}` })
        }

        if (payment.order_id && payment.order_id !== expectedRazorpayOrderId) {
            return res.status(400).json({ message: "Payment order mismatch on gateway" })
        }

        const expectedAmountInPaise = Math.round(order.totalAmount * 100)
        if (payment.amount !== expectedAmountInPaise) {
            return res.status(400).json({ message: "Payment amount does not match order amount" })
        }

        if (payment.currency !== "INR") {
            return res.status(400).json({ message: "Payment currency mismatch" })
        }

        const updatedOrder = await Order.findOneAndUpdate(
            { _id: orderId, payment: false },
            { $set: { payment: true, razorpayPaymentId: razorpay_payment_id } },
            { new: true }
        )

        // If updatedOrder is null, a concurrent request already completed this payment
        if (!updatedOrder) {
            const alreadyPaidOrder = await Order.findById(orderId)
            if (alreadyPaidOrder && alreadyPaidOrder.payment === true) {
                await alreadyPaidOrder.populate("shopOrders.shopOrderItems.item", "name image price")
                await alreadyPaidOrder.populate("shopOrders.shop", "name")
                await alreadyPaidOrder.populate("shopOrders.owner", "fullName")
                await alreadyPaidOrder.populate("user", "fullName mobile")
                const orderResponse = stripDeliveryOtpFields(alreadyPaidOrder)
                return res.status(200).json(orderResponse)
            }
            return res.status(400).json({ message: "Unable to complete payment update" })
        }

        await updatedOrder.populate("shopOrders.shopOrderItems.item", "name image price")
        await updatedOrder.populate("shopOrders.shop", "name")
        await updatedOrder.populate("shopOrders.owner", "fullName")
        await updatedOrder.populate("user", "fullName mobile")
        const orderResponse = stripDeliveryOtpFields(updatedOrder)

        const io = req.app.get('io')

        if (io) {
            orderResponse.shopOrders.forEach(shopOrder => {
                const ownerId = shopOrder.owner?._id
                if (ownerId) {
                    io.to(roomForUser(ownerId)).emit('newOrder', {
                        _id: orderResponse._id,
                        paymentMethod: orderResponse.paymentMethod,
                        user: orderResponse.user,
                        shopOrders: shopOrder,
                        createdAt: orderResponse.createdAt,
                        deliveryAddress: orderResponse.deliveryAddress,
                        payment: orderResponse.payment
                    })
                }
            });
        }

        return res.status(200).json(orderResponse)

    } catch (error) {
        console.error("verify payment error:", error)
        return res.status(500).json({ message: "Payment verification failed" })
    }
}



export const cancelOrder = async (req, res) => {
    try {
        const { orderId, shopOrderId } = req.params
        if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(shopOrderId)) {
            return res.status(400).json({ message: "enter valid order/shopOrderid" })
        }

        const cancellation = validateCancellationBody(req.body)
        if (cancellation.error) {
            return res.status(400).json({ message: cancellation.error })
        }

        const order = await Order.findById(orderId)
        if (!order) {
            return res.status(404).json({ message: "order not found" })
        }
        if (!order.user || String(order.user) !== String(req.userId)) {
            return res.status(403).json({ message: "Unauthorized for this order" })
        }

        const shopOrder = order.shopOrders.id(shopOrderId)
        if (!shopOrder) {
            return res.status(404).json({ message: "shop order not found" })
        }

        const io = req.app.get('io')

        if (shopOrder.status === ORDER_CANCELLED_STATUS) {
            const safeShopOrder = await finalizeCancelledShopOrder(order, shopOrder)
            return res.status(200).json({
                message: cancellationMessageFor(safeShopOrder.refund),
                alreadyCancelled: true,
                orderId: String(order._id),
                shopOrder: safeShopOrder,
                refund: safeShopOrder.refund
            })
        }

        if (!CANCELLABLE_ORDER_STATUSES.includes(shopOrder.status)) {
            return res.status(409).json({ message: ORDER_CANCEL_NOT_ALLOWED_MESSAGE })
        }

        if (order.paymentMethod === "online" && order.payment !== true) {
            return res.status(409).json({ message: ONLINE_PAYMENT_REQUIRED_MESSAGE })
        }

        const refundAmount = normalizeMoney(Number(shopOrder.subtotal) || 0)
        if (!Number.isFinite(refundAmount) || refundAmount < 0) {
            return res.status(409).json({ message: "Unable to calculate the refund amount. Please contact support." })
        }
        const requiresRefund = order.paymentMethod === "online" && refundAmount > 0
        if (requiresRefund && !order.razorpayPaymentId) {
            return res.status(409).json({ message: ORDER_CANCEL_REFUND_DETAILS_MESSAGE })
        }

        if (shopOrder.assignment || shopOrder.assignedDeliveryBoy) {
            return res.status(409).json({ message: "Order is already assigned to a delivery partner and cannot be cancelled" })
        }

        const activeAssignment = await DeliveryAssignment.exists({
            order: order._id,
            shopOrderId: shopOrder._id,
            active: true,
            status: { $in: ["brodcasted", "assigned"] }
        })
        if (activeAssignment) {
            return res.status(409).json({ message: "Order is already assigned to a delivery partner and cannot be cancelled" })
        }

        const now = new Date()
        const refund = requiresRefund
            ? {
                status: "pending",
                amount: refundAmount,
                razorpayRefundId: "",
                processedAt: null,
                failureReason: "",
                attempts: 0,
                lastAttemptAt: null
            }
            : {
                status: "not_required",
                amount: 0,
                razorpayRefundId: "",
                processedAt: null,
                failureReason: "",
                attempts: 0,
                lastAttemptAt: null
            }

        const updateFilter = {
            _id: order._id,
            user: req.userId,
            shopOrders: {
                $elemMatch: {
                    _id: shopOrder._id,
                    status: { $in: CANCELLABLE_ORDER_STATUSES },
                    assignment: null,
                    assignedDeliveryBoy: null
                }
            }
        }
        if (order.paymentMethod === "online") {
            updateFilter.payment = true
            if (requiresRefund) {
                updateFilter.razorpayPaymentId = order.razorpayPaymentId
            }
        }

        const updatedOrder = await Order.findOneAndUpdate(
            updateFilter,
            {
                $set: {
                    "shopOrders.$[so].status": ORDER_CANCELLED_STATUS,
                    "shopOrders.$[so].cancelledAt": now,
                    "shopOrders.$[so].cancelledBy": req.userId,
                    "shopOrders.$[so].cancellationReason": cancellation.reason,
                    "shopOrders.$[so].refund": refund,
                    "shopOrders.$[so].deliveryOtp": null,
                    "shopOrders.$[so].otpExpires": null,
                    "shopOrders.$[so].otpAttempts": 0
                }
            },
            {
                new: true,
                runValidators: true,
                arrayFilters: [{
                    "so._id": shopOrder._id,
                    "so.status": { $in: CANCELLABLE_ORDER_STATUSES },
                    "so.assignment": null,
                    "so.assignedDeliveryBoy": null
                }]
            }
        )

        if (!updatedOrder) {
            const freshOrder = await Order.findById(orderId)
            if (!freshOrder) {
                return res.status(404).json({ message: "order not found" })
            }
            if (!freshOrder.user || String(freshOrder.user) !== String(req.userId)) {
                return res.status(403).json({ message: "Unauthorized for this order" })
            }
            const freshShopOrder = freshOrder.shopOrders.id(shopOrderId)
            if (!freshShopOrder) {
                return res.status(404).json({ message: "shop order not found" })
            }
            if (freshShopOrder.status === ORDER_CANCELLED_STATUS) {
                const safeShopOrder = await finalizeCancelledShopOrder(freshOrder, freshShopOrder)
                return res.status(200).json({
                    message: cancellationMessageFor(safeShopOrder.refund),
                    alreadyCancelled: true,
                    orderId: String(freshOrder._id),
                    shopOrder: safeShopOrder,
                    refund: safeShopOrder.refund
                })
            }
            return res.status(409).json({ message: ORDER_CANCEL_CONFLICT_MESSAGE })
        }

        const updatedShopOrder = updatedOrder.shopOrders.id(shopOrderId)
        const safeShopOrder = await finalizeCancelledShopOrder(updatedOrder, updatedShopOrder)
        emitShopOrderCancellation(io, updatedOrder, updatedShopOrder, safeShopOrder.refund)

        return res.status(200).json({
            message: cancellationMessageFor(safeShopOrder.refund),
            alreadyCancelled: false,
            orderId: String(updatedOrder._id),
            shopOrder: safeShopOrder,
            refund: safeShopOrder.refund
        })
    } catch (error) {
        console.error("cancel order error:", error)
        return res.status(500).json({ message: "Failed to cancel order. Please try again." })
    }
}

export const getMyOrders = async (req, res) => {
    try {
        const user = await User.findById(req.userId)
        if (user.role == "user") {
            const orders = await Order.find({ user: req.userId })
                .select("-shopOrders.deliveryOtp -shopOrders.otpExpires -shopOrders.otpAttempts")
                .sort({ createdAt: -1 })
                .populate("shopOrders.shop", "name")
                .populate("shopOrders.owner", "fullName")
                .populate("shopOrders.shopOrderItems.item", "name image price")

            return res.status(200).json(orders)
        } else if (user.role == "owner") {
            const orders = await Order.find({ "shopOrders.owner": req.userId })
                .select("-shopOrders.deliveryOtp -shopOrders.otpExpires -shopOrders.otpAttempts")
                .sort({ createdAt: -1 })
                .populate("shopOrders.shop", "name")
                .populate("user", "fullName mobile")
                .populate("shopOrders.shopOrderItems.item", "name image price")
                .populate("shopOrders.assignedDeliveryBoy", "fullName mobile")



            const filteredOrders = orders.map((order => ({
                _id: order._id,
                paymentMethod: order.paymentMethod,
                user: order.user,
                shopOrders: order.shopOrders.find(o => o.owner._id == req.userId),
                createdAt: order.createdAt,
                deliveryAddress: order.deliveryAddress,
                payment: order.payment
            })))


            return res.status(200).json(filteredOrders)
        }

        // Delivery partners (and any other role) have no customer-order list:
        // their view is /get-assignments and /get-current-order. Returning an
        // empty list also prevents requests from hanging without a response.
        return res.status(200).json([])

    } catch (error) {
        return res.status(500).json({ message: "Failed to retrieve user orders. Please try again." })
    }
}


export const updateOrderStatus = async (req, res) => {
    try {
        const { orderId, shopId } = req.params
        const { status } = req.body
        const order = await Order.findById(orderId)
        if (!order) {
            return res.status(400).json({ message: "order not found" })
        }

        const shopOrder = order.shopOrders.find(o => o.shop == shopId)
        if (!shopOrder) {
            return res.status(400).json({ message: "shop order not found" })
        }

        // Authorization: only the owner of THIS shop order's shop may update
        // its status (per-target lookup also supports owners with more shops)
        const shop = await Shop.findById(shopOrder.shop)
        if (!shop) {
            return res.status(403).json({ message: "Shop not found or unauthorized" })
        }
        if (shop.owner.toString() !== req.userId) {
            return res.status(403).json({ message: "You are not the owner of this shop" })
        }

        if (!ORDER_STATUSES.includes(status)) {
            return res.status(400).json({ message: "Invalid status value" })
        }
        if (status === "delivered") {
            return res.status(400).json({ message: "Delivered status can only be set through delivery verification" })
        }

        if (!isFulfillmentPaymentSatisfied(order)) {
            return res.status(400).json({ message: ONLINE_PAYMENT_REQUIRED_MESSAGE })
        }

        if (!canTransitionOrderStatus(shopOrder.status, status)) {
            return res.status(409).json({ message: ORDER_STATUS_TRANSITION_CONFLICT_MESSAGE })
        }

        const allowedSourceStatuses = statusesThatCanTransitionTo(status)
        if (allowedSourceStatuses.length === 0) {
            return res.status(409).json({ message: ORDER_STATUS_TRANSITION_CONFLICT_MESSAGE })
        }

        // The transition commits atomically only while the shop order sits in a
        // legitimate source status and the order is paid (or COD); stale or
        // concurrent requests cannot regress a delivered order or advance an
        // unpaid online order.
        const transitionResult = await Order.updateOne(
            {
                _id: order._id,
                ...fulfillmentPaymentFilter(),
                shopOrders: {
                    $elemMatch: { _id: shopOrder._id, status: { $in: allowedSourceStatuses } }
                }
            },
            { $set: { "shopOrders.$.status": status } }
        )
        if (transitionResult.matchedCount === 0) {
            return res.status(409).json({ message: "Order status changed while processing. Please refresh and try again." })
        }
        shopOrder.status = status

        if (status == "out of delivery" && !shopOrder.assignment) {
            const { longitude, latitude } = order.deliveryAddress
            const nearByDeliveryBoys = await User.find({
                role: "deliveryBoy",
                location: {
                    $near: {
                        $geometry: { type: "Point", coordinates: [Number(longitude), Number(latitude)] },
                        $maxDistance: 5000
                    }
                }
            })

            const nearByIds = nearByDeliveryBoys.map(b => b._id)
            const busyIds = await DeliveryAssignment.find({
                assignedTo: { $in: nearByIds },
                status: { $nin: ["brodcasted", "completed"] }

            }).distinct("assignedTo")

            const busyIdSet = new Set(busyIds.map(id => String(id)))

            const availableBoys = nearByDeliveryBoys.filter(b => !busyIdSet.has(String(b._id)))
            const candidates = availableBoys.map(b => b._id)

            if (candidates.length == 0) {
                return res.json({
                    message: "order status updated but there is no available delivery boys"
                })
            }

            let deliveryAssignment = null
            let createdAssignment = false
            try {
                deliveryAssignment = await DeliveryAssignment.create({
                    order: order?._id,
                    shop: shopOrder.shop,
                    shopOrderId: shopOrder?._id,
                    brodcastedTo: candidates,
                    status: "brodcasted"
                })
                createdAssignment = true
            } catch (assignmentError) {
                if (assignmentError && assignmentError.code === 11000) {
                    // a concurrent request owns the open broadcast for this shop
                    // order; reuse it instead of creating a duplicate
                    deliveryAssignment = await DeliveryAssignment.findOne({
                        order: order._id,
                        shop: shopOrder.shop,
                        shopOrderId: shopOrder._id,
                        active: true
                    })
                }
                if (!deliveryAssignment) {
                    throw assignmentError
                }
            }

            if (createdAssignment) {
                await Order.updateOne(
                    { _id: order._id, shopOrders: { $elemMatch: { _id: shopOrder._id } } },
                    {
                        $set: {
                            "shopOrders.$.assignment": deliveryAssignment._id,
                            "shopOrders.$.assignedDeliveryBoy": deliveryAssignment.assignedTo
                        }
                    }
                )
                await deliveryAssignment.populate('order')
                await deliveryAssignment.populate('shop')
                const assignmentShopOrder = deliveryAssignment.order.shopOrders.find(so => so._id.equals(deliveryAssignment.shopOrderId))
                const safeAssignment = assignmentSummary(
                    deliveryAssignment._id,
                    deliveryAssignment.shop.name,
                    assignmentShopOrder
                )
                const io = req.app.get('io')
                if (io) {
                    availableBoys.forEach(boy => {
                        const boyId = boy._id
                        if (boyId) {
                            io.to(roomForUser(boyId)).emit('newAssignment', safeAssignment)
                        }
                    });
                }
            }

            shopOrder.assignedDeliveryBoy = deliveryAssignment.assignedTo
            shopOrder.assignment = deliveryAssignment._id





        }


        const updatedShopOrder = order.shopOrders.find(o => o.shop == shopId)
        await order.populate("shopOrders.shop", "name")
        await order.populate("shopOrders.assignedDeliveryBoy", "fullName mobile")
        await order.populate("user", "_id")

        // The status response is owner-facing: delivery-OTP internals must never
        // leave the assigned delivery partner's OTP endpoints.
        const safeShopOrder = updatedShopOrder.toObject()
        delete safeShopOrder.deliveryOtp
        delete safeShopOrder.otpExpires
        delete safeShopOrder.otpAttempts

        const io = req.app.get('io')
        if (io) {
            const customerId = order.user._id
            if (customerId) {
                io.to(roomForUser(customerId)).emit('update-status', {
                    orderId: order._id,
                    shopId: updatedShopOrder.shop._id,
                    status: updatedShopOrder.status,
                    userId: order.user._id
                })
            }
        }



        return res.status(200).json({
            shopOrder: safeShopOrder,
            assignedDeliveryBoy: safeShopOrder?.assignedDeliveryBoy,
            assignment: safeShopOrder?.assignment?._id

        })



    } catch (error) {
        return res.status(500).json({ message: "Failed to update order status. Please try again." })
    }
}


export const getDeliveryBoyAssignment = async (req, res) => {
    try {
        const deliveryBoyId = req.userId
        const requester = await User.findById(deliveryBoyId, "role")
        if (!requester || requester.role !== "deliveryBoy") {
            return res.status(403).json({ message: "Only delivery partners can view assignments" })
        }

        const assignments = await DeliveryAssignment.find({
            brodcastedTo: deliveryBoyId,
            status: "brodcasted"
        })
            .populate("order")
            .populate("shop")

        const formated = assignments
            .filter(a => a.order && a.shop && isFulfillmentPaymentSatisfied(a.order))
            .map(a => {
                const shopOrder = a.order.shopOrders.find(so => so._id.equals(a.shopOrderId))
                return assignmentSummary(a._id, a.shop.name, shopOrder)
            })

        return res.status(200).json(formated)
    } catch (error) {
        return res.status(500).json({ message: "Failed to get assignment. Please try again." })
    }
}


export const acceptOrder = async (req, res) => {
    try {
        const { assignmentId } = req.params

        // Role gate: only delivery partners may claim delivery assignments.
        const requestUser = await User.findById(req.userId, "role")
        if (!requestUser || requestUser.role !== "deliveryBoy") {
            return res.status(403).json({ message: "Only delivery partners can accept assignments" })
        }

        const eligibilityCheck = await DeliveryAssignment.findOne({
            assignedTo: req.userId,
            status: { $nin: ["brodcasted", "completed"] },
            active: true
        })

        if (eligibilityCheck) {
            return res.status(400).json({ message: "You are already assigned to another order" })
        }

        // Only an assignment the caller can actually claim is inspected here,
        // so unrelated or already-claimed assignment ids do not reveal whether
        // their order has been paid.
        const assignmentForPayment = await DeliveryAssignment.findOne({
            _id: assignmentId,
            status: "brodcasted",
            assignedTo: null,
            brodcastedTo: req.userId
        }, "order")

        if (assignmentForPayment) {
            const orderForPayment = await Order.findById(assignmentForPayment.order, "paymentMethod payment")
            if (orderForPayment && !isFulfillmentPaymentSatisfied(orderForPayment)) {
                return res.status(400).json({ message: ONLINE_PAYMENT_REQUIRED_MESSAGE })
            }
        }

        let claimed = null
        try {
            claimed = await DeliveryAssignment.findOneAndUpdate(
                { _id: assignmentId, status: "brodcasted", assignedTo: null, brodcastedTo: req.userId, active: true },
                { $set: { status: "assigned", assignedTo: req.userId, acceptedAt: new Date() } },
                { new: true, runValidators: true }
            )
        } catch (claimError) {
            if (claimError && claimError.code === 11000) {
                return res.status(400).json({ message: "You are already assigned to another order" })
            }
            throw claimError
        }

        if (!claimed) {
            const existing = await DeliveryAssignment.findById(assignmentId)
            if (!existing) {
                return res.status(400).json({ message: "assignment not found" })
            }
            return res.status(409).json({ message: "Assignment is no longer available" })
        }

        let orderUpdateError = null
        let orderUpdateNotApplied = false
        try {
            const result = await Order.updateOne(
                {
                    _id: claimed.order,
                    ...fulfillmentPaymentFilter(),
                    shopOrders: {
                        $elemMatch: {
                            _id: claimed.shopOrderId,
                            shop: claimed.shop,
                            status: DELIVERY_OTP_STATUS,
                            assignedDeliveryBoy: null,
                            $or: [
                                { assignment: { $exists: false } },
                                { assignment: null },
                                { assignment: claimed._id }
                            ]
                        }
                    }
                },
                { $set: { "shopOrders.$[so].assignedDeliveryBoy": req.userId } },
                { arrayFilters: [{ "so._id": claimed.shopOrderId }] }
            )
            if (result.modifiedCount === 0) {
                orderUpdateNotApplied = true
            }
        } catch (orderUpdateThrown) {
            orderUpdateError = orderUpdateThrown
            orderUpdateNotApplied = true
        }

        if (!orderUpdateNotApplied) {
            return res.status(200).json({ message: 'order accepted' })
        }

        console.error("accept order: order update not applied after claiming", orderUpdateError ? { thrownByOrderUpdate: orderUpdateError.message } : { shopOrderId: claimed.shopOrderId.toString(), reason: "matched no shop order" })

        const rolledBack = await DeliveryAssignment.findOneAndUpdate(
            { _id: claimed._id, assignedTo: req.userId, status: "assigned" },
            { $set: { status: "brodcasted", acceptedAt: null }, $unset: { assignedTo: 1 } },
            { new: true }
        )

        if (rolledBack) {
            console.error("accept order: claim rolled back", { assignmentId: claimed._id.toString(), assignmentRollback: "succeeded" })
            if (orderUpdateError) {
                return res.status(500).json({ message: "Failed to accept order. Please try again." })
            }
            return res.status(409).json({ message: "Assignment is no longer available" })
        }

        console.error("accept order: rollback did not revert the claim; manual review required", { assignmentId: claimed._id.toString(), reason: "claim already changed or removed" })
        if (orderUpdateError) {
            return res.status(500).json({ message: "Failed to accept order. Please try again." })
        }
        return res.status(409).json({ message: "Assignment is no longer available" })
    } catch (error) {
        console.error("accept order error:", error)
        return res.status(500).json({ message: "Failed to accept order. Please try again." })
    }
}



export const getCurrentOrder = async (req, res) => {
    try {
        const requester = await User.findById(req.userId, "role")
        if (!requester || requester.role !== "deliveryBoy") {
            return res.status(403).json({ message: "Only delivery partners can view an active delivery" })
        }

        const assignment = await DeliveryAssignment.findOne({
            assignedTo: req.userId,
            status: "assigned",
            active: true
        })
            .populate("shop", "name")
            .populate("assignedTo", "fullName mobile location")
            .populate({
                path: "order",
                select: "-shopOrders.deliveryOtp -shopOrders.otpExpires -shopOrders.otpAttempts",
                populate: [{ path: "user", select: "fullName mobile" }]

            })

        if (!assignment) {
            return res.status(400).json({ message: "assignment not found" })
        }
        if (!assignment.order) {
            return res.status(400).json({ message: "order not found" })
        }

        const shopOrder = assignment.order.shopOrders.find(so => String(so._id) == String(assignment.shopOrderId))

        if (!shopOrder) {
            return res.status(400).json({ message: "shopOrder not found" })
        }

        const assignmentShopId = assignment.shop?._id ?? assignment.shop
        const shopOrderShopId = shopOrder.shop?._id ?? shopOrder.shop
        const assignedDeliveryBoyId = assignment.assignedTo?._id ?? assignment.assignedTo

        const relationshipIsValid = shopOrder
            && assignmentShopId
            && shopOrderShopId
            && String(assignmentShopId) === String(shopOrderShopId)
            && shopOrder.status === DELIVERY_OTP_STATUS
            && shopOrder.assignedDeliveryBoy
            && String(shopOrder.assignedDeliveryBoy) === String(assignedDeliveryBoyId)
            && (!shopOrder.assignment || String(shopOrder.assignment) === String(assignment._id))

        if (!relationshipIsValid) {
            return res.status(400).json({ message: "assignment not found" })
        }

        if (!isFulfillmentPaymentSatisfied(assignment.order)) {
            return res.status(400).json({ message: ONLINE_PAYMENT_REQUIRED_MESSAGE })
        }

        let deliveryBoyLocation = { lat: null, lon: null }
        if (assignment.assignedTo?.location?.coordinates?.length === 2) {
            deliveryBoyLocation.lat = assignment.assignedTo.location.coordinates[1]
            deliveryBoyLocation.lon = assignment.assignedTo.location.coordinates[0]
        }

        let customerLocation = { lat: null, lon: null }
        if (assignment.order.deliveryAddress) {
            customerLocation.lat = assignment.order.deliveryAddress.latitude
            customerLocation.lon = assignment.order.deliveryAddress.longitude
        }

        return res.status(200).json({
            _id: assignment.order._id,
            user: assignment.order.user,
            shopOrder,
            deliveryAddress: assignment.order.deliveryAddress,
            deliveryBoyLocation,
            customerLocation
        })

    } catch (error) {
        console.error("getCurrentOrder error:", error);
        return res.status(500).json({ message: "Failed to retrieve current order" });
    }
}

export const getOrderById = async (req, res) => {
    try {
        const { orderId } = req.params
        if (!mongoose.isValidObjectId(orderId)) {
            return res.status(400).json({ message: "order not found" })
        }

        const order = await Order.findById(orderId)
        if (!order) {
            return res.status(400).json({ message: "order not found" })
        }

        // Object-level authorization: only the ordering customer, an owner of
        // one of the order's shops, or the assigned delivery partner may read
        // the order. Every other caller gets the same generic response as an
        // unknown order, so unrelated private records are not distinguishable.
        const isCustomer = String(order.user) === req.userId
        const ownedShopOrderIds = new Set(
            order.shopOrders
                .filter(so => so.owner && String(so.owner) === req.userId)
                .map(so => String(so._id))
        )
        const isShopOwner = ownedShopOrderIds.size > 0

        let assignedShopOrderIds = new Set()
        if (!isCustomer && !isShopOwner) {
            const assignments = await DeliveryAssignment.find({
                order: orderId,
                assignedTo: req.userId,
                status: "assigned"
            }).select("shopOrderId shop").lean()

            assignedShopOrderIds = new Set(
                assignments
                    .filter((assignment) => {
                        const shopOrder = order.shopOrders.find(so => String(so._id) === String(assignment.shopOrderId))
                        return shopOrder && String(shopOrder.shop) === String(assignment.shop)
                    })
                    .map(assignment => String(assignment.shopOrderId))
            )
        }
        const isAssignedDeliveryPartner = assignedShopOrderIds.size > 0
        if (!isCustomer && !isShopOwner && !isAssignedDeliveryPartner) {
            return res.status(400).json({ message: "order not found" })
        }

        const populatedOrder = await Order.findById(orderId)
            .select("-shopOrders.deliveryOtp -shopOrders.otpExpires -shopOrders.otpAttempts")
            .populate("user", isCustomer ? "fullName email mobile" : "fullName mobile")
            .populate("shopOrders.shop", "name")
            .populate("shopOrders.assignedDeliveryBoy", "fullName mobile location")
            .populate("shopOrders.shopOrderItems.item", "name image price")
            .lean()

        if (!populatedOrder) {
            return res.status(400).json({ message: "order not found" })
        }

        const visibleShopOrderIds = isCustomer
            ? new Set(populatedOrder.shopOrders.map(so => String(so._id)))
            : isShopOwner
                ? ownedShopOrderIds
                : assignedShopOrderIds
        const visibleShopOrders = populatedOrder.shopOrders.filter(so => visibleShopOrderIds.has(String(so._id)))

        if (!isCustomer) {
            for (const shopOrder of visibleShopOrders) {
                if (shopOrder.assignedDeliveryBoy && typeof shopOrder.assignedDeliveryBoy === "object") {
                    delete shopOrder.assignedDeliveryBoy.location
                }
            }
        }

        if (isCustomer) {
            return res.status(200).json(populatedOrder)
        }

        if (isShopOwner) {
            return res.status(200).json({
                _id: populatedOrder._id,
                user: populatedOrder.user,
                paymentMethod: populatedOrder.paymentMethod,
                deliveryAddress: populatedOrder.deliveryAddress,
                payment: populatedOrder.payment,
                shopOrders: visibleShopOrders,
                createdAt: populatedOrder.createdAt,
                updatedAt: populatedOrder.updatedAt
            })
        }

        return res.status(200).json({
            _id: populatedOrder._id,
            user: populatedOrder.user,
            deliveryAddress: populatedOrder.deliveryAddress,
            shopOrders: visibleShopOrders,
            createdAt: populatedOrder.createdAt,
            updatedAt: populatedOrder.updatedAt
        })
    } catch (error) {
        return res.status(500).json({ message: "Failed to retrieve order details. Please try again." })
    }
}

// Delivery-OTP authorization: the requester must be a delivery partner who
// is assigned (status "assigned") to an assignment mapping exactly to the
// given order and shop order, and that assignment must still be the one
// referenced by the shop order. Customers, unrelated delivery partners,
// replaced riders, shop owners, and invalid combinations all receive the same
// generic rejection, so responses never reveal whether unrelated private
// records exist.
const getAuthorizedDeliveryContext = async (userId, orderId, shopOrderId) => {
    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(shopOrderId)) {
        return { ok: false, status: 400, payload: { message: "enter valid order/shopOrderid" } }
    }
    const requester = await User.findById(userId, "role")
    if (!requester || requester.role !== "deliveryBoy") {
        return { ok: false, status: 403, payload: { message: "Only the assigned delivery partner can use delivery OTP endpoints" } }
    }
    const assignment = await DeliveryAssignment.findOne({
        assignedTo: userId,
        status: "assigned",
        order: orderId,
        shopOrderId: shopOrderId
    })
    if (!assignment) {
        return { ok: false, status: 403, payload: { message: "Only the assigned delivery partner can use delivery OTP endpoints" } }
    }
    const order = await Order.findById(orderId)
    const shopOrder = order?.shopOrders.id(shopOrderId) || null
    if (!order || !shopOrder || !order.user) {
        return { ok: false, status: 400, payload: { message: "enter valid order/shopOrderid" } }
    }

    const linkedAssignmentId = shopOrder.assignment ? String(shopOrder.assignment) : null
    const assignmentStillBelongsToOrder =
        shopOrder.assignedDeliveryBoy &&
        String(shopOrder.assignedDeliveryBoy) === String(userId) &&
        (!linkedAssignmentId || linkedAssignmentId === String(assignment._id)) &&
        (!assignment.shop || !shopOrder.shop || String(assignment.shop) === String(shopOrder.shop))

    if (!assignmentStillBelongsToOrder) {
        return { ok: false, status: 403, payload: { message: "Only the assigned delivery partner can use delivery OTP endpoints" } }
    }

    const deliveryStageFilter = {
        _id: shopOrder._id,
        status: DELIVERY_OTP_STATUS,
        assignedDeliveryBoy: userId,
        ...(linkedAssignmentId ? { assignment: assignment._id } : {})
    }

    if (!isFulfillmentPaymentSatisfied(order)) {
        return { ok: false, status: 400, payload: { message: ONLINE_PAYMENT_REQUIRED_MESSAGE } }
    }
    return { ok: true, order, shopOrder, assignment, deliveryStageFilter }
}

export const sendDeliveryOtp = async (req, res) => {
    try {
        const { orderId, shopOrderId } = req.body
        const context = await getAuthorizedDeliveryContext(req.userId, orderId, shopOrderId)
        if (!context.ok) {
            return res.status(context.status).json(context.payload)
        }
        const { order, shopOrder, deliveryStageFilter } = context

        if (shopOrder.status === "delivered") {
            return res.status(400).json({ message: "Order is already delivered. This OTP flow is closed." })
        }
        if (shopOrder.status !== DELIVERY_OTP_STATUS) {
            return res.status(400).json({ message: "Order is not out for delivery. Delivery OTP is not available." })
        }

        await order.populate("user", "fullName email")

        const otp = crypto.randomInt(1000, 10000).toString()
        const otpExpires = new Date(Date.now() + 5 * 60 * 1000)

        // Issuing a code is conditional on the same delivery-stage and rider
        // checks used for verification, so a concurrent completion or
        // reassignment cannot leave a fresh OTP on an ineligible shop order.
        const otpSaved = await Order.findOneAndUpdate(
            {
                _id: order._id,
                ...fulfillmentPaymentFilter(),
                shopOrders: {
                    $elemMatch: deliveryStageFilter
                }
            },
            {
                $set: {
                    "shopOrders.$.deliveryOtp": otp,
                    "shopOrders.$.otpExpires": otpExpires,
                    "shopOrders.$.otpAttempts": 0
                }
            },
            { new: true }
        )

        if (!otpSaved) {
            return res.status(409).json({ message: "Order delivery assignment changed while processing. Please refresh and try again." })
        }

        await sendDeliveryOtpMail(order.user, otp)
        return res.status(200).json({ message: `Otp sent Successfuly to ${order?.user?.fullName}` })
    } catch (error) {
        if (isMailConfigError(error)) {
            return res.status(503).json({ message: "Email service is unavailable. Please contact support." })
        }
        return res.status(500).json({ message: "Failed to send delivery OTP. Please try again." })
    }
}

export const verifyDeliveryOtp = async (req, res) => {
    try {
        const { orderId, shopOrderId, otp } = req.body
        if (!otp || typeof otp !== "string") {
            return res.status(400).json({ message: "Invalid/Expired Otp" })
        }

        const context = await getAuthorizedDeliveryContext(req.userId, orderId, shopOrderId)
        if (!context.ok) {
            return res.status(context.status).json(context.payload)
        }
        const { order, shopOrder, assignment, deliveryStageFilter } = context

        if (shopOrder.status === "delivered") {
            return res.status(400).json({ message: "Order is already delivered. This OTP can no longer be used." })
        }
        if (shopOrder.status !== DELIVERY_OTP_STATUS) {
            return res.status(400).json({ message: "Order is not out for delivery. Delivery OTP cannot be verified." })
        }

        if (!shopOrder.deliveryOtp || !shopOrder.otpExpires || shopOrder.otpExpires < Date.now()) {
            return res.status(400).json({ message: "Invalid/Expired Otp" })
        }

        if ((shopOrder.otpAttempts || 0) >= MAX_DELIVERY_OTP_ATTEMPTS) {
            return res.status(400).json({ message: "Too many incorrect OTP attempts. Request a new OTP." })
        }

        const liveDeliveryOtpFilter = { ...deliveryStageFilter }

        if (shopOrder.deliveryOtp !== otp) {
            // attempts only count against a live verification window, so a
            // completed or reused order never accumulates extra attempts
            await Order.updateOne(
                {
                    _id: order._id,
                    ...fulfillmentPaymentFilter(),
                    shopOrders: {
                        $elemMatch: {
                            ...liveDeliveryOtpFilter,
                            deliveryOtp: { $ne: null },
                            otpAttempts: { $not: { $gte: MAX_DELIVERY_OTP_ATTEMPTS } }
                        }
                    }
                },
                { $inc: { "shopOrders.$.otpAttempts": 1 } }
            )
            return res.status(400).json({ message: "Invalid/Expired Otp" })
        }

        // Every condition for successful verification is rechecked inside this
        // single atomic update (order and shop-order ids, delivery stage,
        // current rider assignment, OTP still matching, OTP not expired,
        // attempts below the limit); the earlier read only shapes response
        // messages, and the OTP is invalidated in the same write that marks
        // the order delivered.
        const now = new Date()
        const completedOrder = await Order.findOneAndUpdate(
            {
                _id: order._id,
                ...fulfillmentPaymentFilter(),
                shopOrders: {
                    $elemMatch: {
                        ...liveDeliveryOtpFilter,
                        deliveryOtp: otp,
                        otpExpires: { $gt: now },
                        otpAttempts: { $not: { $gte: MAX_DELIVERY_OTP_ATTEMPTS } }
                    }
                }
            },
            {
                $set: {
                    "shopOrders.$.status": "delivered",
                    "shopOrders.$.deliveredAt": now,
                    "shopOrders.$.deliveryOtp": null,
                    "shopOrders.$.otpExpires": null,
                    "shopOrders.$.otpAttempts": 0
                }
            },
            { new: true }
        )

        if (!completedOrder) {
            const fresh = await Order.findById(order._id, "paymentMethod payment shopOrders").lean()
            if (fresh && !isFulfillmentPaymentSatisfied(fresh)) {
                return res.status(400).json({ message: ONLINE_PAYMENT_REQUIRED_MESSAGE })
            }
            const freshShopOrder = Array.isArray(fresh?.shopOrders)
                ? fresh.shopOrders.find((so) => String(so._id) === String(shopOrder._id))
                : null
            if (!freshShopOrder || freshShopOrder.status === "delivered") {
                return res.status(400).json({ message: "Order is already delivered or cannot be completed." })
            }
            if (freshShopOrder.status !== DELIVERY_OTP_STATUS) {
                return res.status(400).json({ message: "Order is not out for delivery. Delivery OTP cannot be verified." })
            }
            if (
                !freshShopOrder.assignedDeliveryBoy ||
                String(freshShopOrder.assignedDeliveryBoy) !== String(req.userId) ||
                (freshShopOrder.assignment && String(freshShopOrder.assignment) !== String(assignment._id))
            ) {
                return res.status(403).json({ message: "Only the assigned delivery partner can use delivery OTP endpoints" })
            }
            if ((freshShopOrder.otpAttempts || 0) >= MAX_DELIVERY_OTP_ATTEMPTS) {
                return res.status(400).json({ message: "Too many incorrect OTP attempts. Request a new OTP." })
            }
            return res.status(400).json({ message: "Invalid/Expired Otp" })
        }

        await DeliveryAssignment.deleteOne({
            _id: assignment._id,
            shopOrderId: shopOrder._id,
            order: order._id,
            assignedTo: req.userId,
            status: "assigned"
        })

        return res.status(200).json({ message: "Order Delivered Successfully!" })

    } catch (error) {
        return res.status(500).json({ message: "Failed to verify delivery OTP. Please try again." })
    }
}

export const getTodayDeliveries=async (req,res) => {
    try {
        const deliveryBoyId=req.userId
        const startsOfDay=new Date()
        startsOfDay.setHours(0,0,0,0)

        const orders=await Order.find({
           "shopOrders.assignedDeliveryBoy":deliveryBoyId,
           "shopOrders.status":"delivered",
           "shopOrders.deliveredAt":{$gte:startsOfDay}
        }).lean()

     let todaysDeliveries=[] 
     
     orders.forEach(order=>{
        order.shopOrders.forEach(shopOrder=>{
            if(shopOrder.assignedDeliveryBoy==deliveryBoyId &&
                shopOrder.status=="delivered" &&
                shopOrder.deliveredAt &&
                shopOrder.deliveredAt>=startsOfDay
            ){
                todaysDeliveries.push(shopOrder)
            }
        })
     })

let stats={}

todaysDeliveries.forEach(shopOrder=>{
    const hour=new Date(shopOrder.deliveredAt).getHours()
    stats[hour]=(stats[hour] || 0) + 1
})

let formattedStats=Object.keys(stats).map(hour=>({
 hour:parseInt(hour),
 count:stats[hour]   
}))

formattedStats.sort((a,b)=>a.hour-b.hour)

return res.status(200).json(formattedStats)
  

    } catch (error) {
        return res.status(500).json({ message: "Failed to retrieve today's deliveries. Please try again." }) 
    }
}



