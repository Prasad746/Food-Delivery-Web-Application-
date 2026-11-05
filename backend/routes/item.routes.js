import express from "express"

import isAuth from "../middlewares/isAuth.js"
import { createOrderRateLimiter, ORDER_RATE_LIMITS } from "../middlewares/orderRateLimit.js"
import { addItem, deleteItem, editItem, getItemByCity, getItemById, getItemsByShop, rating, searchItems } from "../controllers/item.controllers.js"
import { getFoodRecommendations } from "../controllers/recommendation.controllers.js"
import { secureImageUpload, validateUploadedImages } from "../middlewares/multer.js"



const itemRouter=express.Router()

itemRouter.post("/add-item",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.upload,{ name: "upload-add-item" }),secureImageUpload("image"),validateUploadedImages,addItem)
itemRouter.post("/edit-item/:itemId",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.upload,{ name: "upload-edit-item" }),secureImageUpload("image"),validateUploadedImages,editItem)
itemRouter.get("/get-by-id/:itemId",isAuth,getItemById)
itemRouter.delete("/delete/:itemId",isAuth,deleteItem)
itemRouter.get("/get-by-city/:city",isAuth,getItemByCity)
itemRouter.get("/get-by-shop/:shopId",isAuth,getItemsByShop)
itemRouter.get("/search-items",isAuth,searchItems)
itemRouter.get("/recommendations",isAuth,getFoodRecommendations)
itemRouter.post("/rating",isAuth,createOrderRateLimiter(ORDER_RATE_LIMITS.rating,{ name: "rating" }),rating)
export default itemRouter