import express from "express"
import { createEditShop, getMyShop, getShopByCity } from "../controllers/shop.controllers.js"
import isAuth from "../middlewares/isAuth.js"
import { createOrderRateLimiter, ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import { secureImageUpload, validateUploadedImages } from "../middlewares/multer.js"



const shopRouter=express.Router()

shopRouter.post("/create-edit",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.upload,{ name: "upload-shop-create-edit" }),secureImageUpload("image"),validateUploadedImages,createEditShop)
shopRouter.get("/get-my",isAuth,getMyShop)
shopRouter.get("/get-by-city/:city",isAuth,getShopByCity)

export default shopRouter