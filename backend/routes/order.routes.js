import express from "express"
import isAuth from "../middlewares/isAuth.js"
import { createOrderRateLimiter, ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import { acceptOrder, cancelOrder, getCurrentOrder, getDeliveryBoyAssignment, getMyOrders, getOrderById, getTodayDeliveries, placeOrder, sendDeliveryOtp, updateOrderStatus, verifyDeliveryOtp, verifyPayment } from "../controllers/order.controllers.js"
import { getRestaurantAnalytics } from "../controllers/analytics.controllers.js"




const orderRouter=express.Router()

orderRouter.post("/place-order",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.placeOrder,{ name: "place-order" }),placeOrder)
orderRouter.post("/verify-payment",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.verifyPayment,{ name: "verify-payment" }),verifyPayment)
orderRouter.post("/cancel/:orderId/:shopOrderId",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.cancelOrder,{ name: "cancel-order" }),cancelOrder)
orderRouter.get("/analytics",isAuth,getRestaurantAnalytics)
orderRouter.get("/my-orders",isAuth,getMyOrders)
orderRouter.get("/get-assignments",isAuth,getDeliveryBoyAssignment)
orderRouter.get("/get-current-order",isAuth,getCurrentOrder)
orderRouter.post("/send-delivery-otp",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.sendDeliveryOtp,{ name: "send-delivery-otp" }),sendDeliveryOtp)
orderRouter.post("/verify-delivery-otp",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.verifyDeliveryOtp,{ name: "verify-delivery-otp" }),verifyDeliveryOtp)
orderRouter.post("/update-status/:orderId/:shopId",isAuth,updateOrderStatus)
orderRouter.post('/accept-order/:assignmentId',isAuth,acceptOrder)
orderRouter.get('/get-order-by-id/:orderId',isAuth,getOrderById)
orderRouter.get('/get-today-deliveries',isAuth,getTodayDeliveries)

export default orderRouter