import mongoose from "mongoose";
import Item from "../models/item.model.js";
import Shop from "../models/shop.model.js";
import User from "../models/user.model.js";
import Order from "../models/order.model.js";
import uploadOnCloudinary, { deleteCloudinaryAsset } from "../utils/cloudinary.js";
import { validateItemCreateBody, validateItemUpdateBody, sanitizeSearchText, exactTextPattern, substringTextPattern } from "../utils/validate.js";
import { mergeDiscountConfig, normalizeDiscountConfig, validateDiscountConfig } from "../utils/pricing.js";
import { cleanupUnprocessedUpload } from "../middlewares/multer.js";
import { isProduction } from "../config/security.js";

const isClientInputError = (error) =>
    error?.name === "ValidationError" || error?.name === "CastError"

// Mongoose validation and cast messages embed schema details. Keep them for
// local diagnostics but never return them to production clients.
const clientInputMessage = (error, fallback) =>
    isProduction() ? fallback : error.message

const imageIsReferencedElsewhere = async (image, { exceptItemId, exceptShopId } = {}) => {
    if (!image) {
        return false
    }
    const itemQuery = { image }
    if (exceptItemId) {
        itemQuery._id = { $ne: exceptItemId }
    }
    const shopQuery = { image }
    if (exceptShopId) {
        shopQuery._id = { $ne: exceptShopId }
    }
    const [itemReference, shopReference] = await Promise.all([
        Item.exists(itemQuery),
        Shop.exists(shopQuery)
    ])
    return Boolean(itemReference || shopReference)
}

const deleteReplacedImageIfUnreferenced = async (previousImage, nextImage, references) => {
    if (!previousImage || previousImage === nextImage) {
        return
    }
    try {
        if (await imageIsReferencedElsewhere(previousImage, references)) {
            return
        }
        await deleteCloudinaryAsset(previousImage)
    } catch {
        console.error("image replacement cleanup failed")
    }
}

export const addItem = async (req, res) => {
    let uploadedImage = null
    let imageCommitted = false
    try {
        const { fields, error } = validateItemCreateBody(req.body)
        if (error) {
            await cleanupUnprocessedUpload(req)
            return res.status(400).json({ message: error })
        }
        // Authorize before touching Cloudinary: rejected requests must never
        // send an image to external storage. Multer has already written the
        // temporary local file, so every rejection path still cleans it up.
        const shop = await Shop.findOne({ owner: req.userId })
        if (!shop) {
            await cleanupUnprocessedUpload(req)
            return res.status(400).json({ message: "shop not found" })
        }
        const requester = await User.findById(req.userId, "role")
        if (requester?.role !== "owner") {
            await cleanupUnprocessedUpload(req)
            return res.status(403).json({ message: "Only shop owners can manage items" })
        }

        if (req.file) {
            uploadedImage = await uploadOnCloudinary(req.file.path)
        }
        let item = null
        try {
            item = await Item.create({
                name: fields.name,
                category: fields.category,
                foodType: fields.foodType,
                price: fields.price,
                image: uploadedImage,
                shop: shop._id,
                ...(fields.discount ? { discount: fields.discount } : {})
            })

            shop.items.push(item._id)
            await shop.save()
            imageCommitted = true
        } catch (error) {
            if (item) {
                await Item.deleteOne({ _id: item._id })
            }
            throw error
        }
        await shop.populate("owner")
        await shop.populate({
            path: "items",
            options: { sort: { updatedAt: -1 } }
        })
        return res.status(201).json(shop)

    } catch (error) {
        await cleanupUnprocessedUpload(req)
        if (uploadedImage && !imageCommitted) {
            await deleteCloudinaryAsset(uploadedImage)
        }
        if (isClientInputError(error)) {
            return res.status(400).json({ message: clientInputMessage(error, "Invalid item data") })
        }
        return res.status(500).json({ message: "Failed to add item. Please try again." })
    }
}

export const editItem = async (req, res) => {
    let uploadedImage = null
    let imageCommitted = false
    try {
        const itemId = req.params.itemId
        if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
            await cleanupUnprocessedUpload(req)
            return res.status(400).json({ message: "Valid item ID is required" })
        }

        const { fields, error } = validateItemUpdateBody(req.body)
        if (error) {
            await cleanupUnprocessedUpload(req)
            return res.status(400).json({ message: error })
        }

        const item = await Item.findById(itemId)
        if (!item) {
            await cleanupUnprocessedUpload(req)
            return res.status(400).json({ message: "item not found" })
        }

        const shop = await Shop.findOne({ owner: req.userId })
        if (!shop) {
            await cleanupUnprocessedUpload(req)
            return res.status(403).json({ message: "Shop not found or unauthorized" })
        }

        const requester = await User.findById(req.userId, "role")
        if (requester?.role !== "owner") {
            await cleanupUnprocessedUpload(req)
            return res.status(403).json({ message: "Only shop owners can manage items" })
        }

        if (item.shop.toString() !== shop._id.toString()) {
            await cleanupUnprocessedUpload(req)
            return res.status(403).json({ message: "You do not have permission to edit this item" })
        }

        const effectivePrice = fields.price !== undefined ? fields.price : item.price
        const hasDiscountUpdate = Object.prototype.hasOwnProperty.call(fields, "discount")
        let normalizedDiscount
        if (hasDiscountUpdate) {
            const mergedDiscount = fields.discount === null
                ? null
                : mergeDiscountConfig(item.discount, fields.discount)
            if (mergedDiscount) {
                const discountCheck = validateDiscountConfig(mergedDiscount, effectivePrice)
                if (!discountCheck.valid) {
                    await cleanupUnprocessedUpload(req)
                    return res.status(400).json({ message: discountCheck.error })
                }
                normalizedDiscount = normalizeDiscountConfig(mergedDiscount)
            } else {
                normalizedDiscount = null
            }
        } else if (fields.price !== undefined && item.discount) {
            const discountCheck = validateDiscountConfig(item.discount, effectivePrice)
            if (!discountCheck.valid) {
                await cleanupUnprocessedUpload(req)
                return res.status(400).json({ message: discountCheck.error })
            }
        }

        // Upload only after all authorization checks pass, so rejected
        // requests never reach external storage. The local temporary file was
        // written by Multer and is removed by the cleanup calls above.
        if (req.file) {
            uploadedImage = await uploadOnCloudinary(req.file.path)
        }

        const updateFields = { ...fields }
        if (hasDiscountUpdate) {
            updateFields.discount = normalizedDiscount
        }
        if (uploadedImage) {
            updateFields.image = uploadedImage
        }
        if (Object.keys(updateFields).length === 0) {
            if (uploadedImage) {
                await deleteCloudinaryAsset(uploadedImage)
            }
            return res.status(400).json({ message: "no valid item fields to update" })
        }

        const previousImage = item.image
        const updatedItem = await Item.findByIdAndUpdate(itemId, {
            $set: updateFields
        }, { new: true, runValidators: true })
        if (!updatedItem) {
            if (uploadedImage) {
                await deleteCloudinaryAsset(uploadedImage)
            }
            return res.status(400).json({ message: "item not found" })
        }
        imageCommitted = true
        await deleteReplacedImageIfUnreferenced(previousImage, updatedItem.image, { exceptItemId: item._id })

        return res.status(200).json(updatedItem)

    } catch (error) {
        await cleanupUnprocessedUpload(req)
        if (uploadedImage && !imageCommitted) {
            await deleteCloudinaryAsset(uploadedImage)
        }
        if (isClientInputError(error)) {
            return res.status(400).json({ message: clientInputMessage(error, "Invalid item data") })
        }
        return res.status(500).json({ message: "Failed to edit item. Please try again." })
    }
}

export const getItemById = async (req, res) => {
    try {
        const itemId = req.params.itemId
        if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
            return res.status(400).json({ message: "Valid item ID is required" })
        }
        const item = await Item.findById(itemId)
        if (!item) {
            return res.status(400).json({ message: "item not found" })
        }
        return res.status(200).json(item)
    } catch (error) {
        return res.status(500).json({ message: "Failed to retrieve item. Please try again." })
    }
}

export const deleteItem = async (req, res) => {
    try {
        const itemId = req.params.itemId
        if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
            return res.status(400).json({ message: "Valid item ID is required" })
        }

        const shop = await Shop.findOne({ owner: req.userId })
        if (!shop) {
            return res.status(403).json({ message: "Shop not found or unauthorized" })
        }

        const requester = await User.findById(req.userId, "role")
        if (requester?.role !== "owner") {
            return res.status(403).json({ message: "Only shop owners can manage items" })
        }

        const item = await Item.findById(itemId)
        if (!item) {
            return res.status(404).json({ message: "item not found" })
        }

        if (item.shop.toString() !== shop._id.toString()) {
            return res.status(403).json({ message: "You do not have permission to delete this item" })
        }

        await Item.findByIdAndDelete(itemId)

        shop.items = shop.items.filter(i => i && i.toString() !== itemId.toString())
        await shop.save()
        await shop.populate({
            path: "items",
            options: { sort: { updatedAt: -1 } }
        })
        return res.status(200).json(shop)

    } catch (error) {
        console.error("delete item error:", error);
        return res.status(500).json({ message: "Failed to delete item" })
    }
}

export const getItemByCity = async (req, res) => {
    try {
        const cityCheck = sanitizeSearchText(req.params.city)
        if (!cityCheck.ok) {
            return res.status(400).json({
                message: cityCheck.tooLong ? "city must be 100 characters or less" : "city is required"
            })
        }
        const shops = await Shop.find({
            city: { $regex: exactTextPattern(cityCheck.text) }
        }).select("_id").lean()
        if (!shops) {
            return res.status(400).json({ message: "shops not found" })
        }
        const shopIds=shops.map((shop)=>shop._id)

        const items=await Item.find({shop:{$in:shopIds}, isAvailable:{$ne:false}})
        return res.status(200).json(items)

    } catch (error) {
 return res.status(500).json({ message: "Failed to retrieve items by city. Please try again." })
    }
}

export const getItemsByShop=async (req,res) => {
    try {
        const {shopId}=req.params
        if (!shopId || !mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ message: "Valid shop ID is required" })
        }
        const shop=await Shop.findById(shopId).populate({
            path: "items",
            match: { isAvailable: { $ne: false } }
        })
        if(!shop){
            return res.status(400).json({message:"shop not found"})
        }
        return res.status(200).json({
            shop,items:shop.items
        })
    } catch (error) {
         return res.status(500).json({ message: "Failed to retrieve items by shop. Please try again." })
    }
}

export const searchItems=async (req,res) => {
    try {
        const emptySearch=() => res.status(200).json([])
        const queryCheck=sanitizeSearchText(req.query.query)
        if (!queryCheck.ok) {
            if (queryCheck.tooLong) {
                return res.status(400).json({ message: "Search terms must be 100 characters or less" })
            }
            return emptySearch()
        }
        const cityCheck=sanitizeSearchText(req.query.city)
        if (!cityCheck.ok) {
            if (cityCheck.tooLong) {
                return res.status(400).json({ message: "Search terms must be 100 characters or less" })
            }
            return emptySearch()
        }

        const shops=await Shop.find({
            city:{$regex:exactTextPattern(cityCheck.text)}
        }).select("_id").lean()
        if (shops.length === 0) {
            return res.status(200).json([])
        }
        const shopIds=shops.map(s=>s._id)
        const items=await Item.find({
            shop:{$in:shopIds},
            isAvailable:{$ne:false},
            $or:[
              {name:{$regex:substringTextPattern(queryCheck.text)}},
              {category:{$regex:substringTextPattern(queryCheck.text)}}
            ]

        }).populate("shop","name image")

        return res.status(200).json(items)

    } catch (error) {
         return res.status(500).json({ message: "Failed to search items. Please try again." })
    }
}


export const rating=async (req,res) => {
    try {
        const {itemId,rating}=req.body

        if(typeof rating!=="number" || !Number.isFinite(rating) || rating<1 || rating>5){
            return res.status(400).json({message:"rating must be a number between 1 and 5"})
        }

        if(typeof itemId!=="string" || !mongoose.Types.ObjectId.isValid(itemId)){
            return res.status(400).json({message:"Valid item ID is required"})
        }

        const requester=await User.findById(req.userId,"role")
        if(!requester || requester.role!=="user"){
            return res.status(403).json({message:"Only customers can rate items"})
        }

        const item=await Item.findById(itemId)
        if(!item){
              return res.status(400).json({message:"item not found"})
        }

        const shop=await Shop.findById(item.shop,"owner")
        if(!shop || String(shop.owner)===String(req.userId)){
            return res.status(403).json({message:"You cannot rate an item from your own shop"})
        }

        const deliveredPurchase=await Order.exists({
            user:req.userId,
            $or:[{paymentMethod:"cod"},{payment:true}],
            shopOrders:{
                $elemMatch:{
                    shop:item.shop,
                    status:"delivered",
                    "shopOrderItems.item":item._id
                }
            }
        })
        if(!deliveredPurchase){
            return res.status(403).json({message:"You can only rate items from a delivered purchase"})
        }

        // Count and average are recomputed inside one atomic database update
        // from the document's current values, so concurrent ratings can never
        // lose an increment or corrupt the average the way a read-modify-write
        // cycle could.
        const updatedItem=await Item.findOneAndUpdate(
            { _id: item._id },
            [
                {
                    $set: {
                        "rating.count": { $add: [{ $ifNull: ["$rating.count", 0] }, 1] },
                        "rating.average": {
                            $divide: [
                                {
                                    $add: [
                                        { $multiply: [{ $ifNull: ["$rating.average", 0] }, { $ifNull: ["$rating.count", 0] }] },
                                        rating
                                    ]
                                },
                                { $add: [{ $ifNull: ["$rating.count", 0] }, 1] }
                            ]
                        }
                    }
                }
            ],
            { new: true }
        )

return res.status(200).json({rating:updatedItem.rating})

    } catch (error) {
         if (isClientInputError(error)) {
             return res.status(400).json({ message: clientInputMessage(error, "Invalid rating data") })
         }
         return res.status(500).json({ message: "Failed to process rating. Please try again." })
    }
}