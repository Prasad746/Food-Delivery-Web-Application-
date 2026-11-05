import Shop from "../models/shop.model.js";
import User from "../models/user.model.js";
import Item from "../models/item.model.js";
import uploadOnCloudinary, { deleteCloudinaryAsset } from "../utils/cloudinary.js";
import { cleanupUnprocessedUpload } from "../middlewares/multer.js";
import { sanitizeSearchText, exactTextPattern } from "../utils/validate.js";

const deleteShopImageIfUnreferenced=async (image,shopId)=>{
    if(!image) return
    try{
        const [otherShop,itemReference]=await Promise.all([
            Shop.exists({_id:{$ne:shopId},image}),
            Item.exists({image})
        ])
        if(otherShop || itemReference) return
        await deleteCloudinaryAsset(image)
    }catch{
        console.error("shop image replacement cleanup failed")
    }
}

export const createEditShop=async (req,res) => {
    let uploadedImage=null
    let imageCommitted=false
    try {
       const requester=await User.findById(req.userId,"role")
       if(!requester){
        await cleanupUnprocessedUpload(req)
        return res.status(401).json({message:"Authentication required"})
       }
       if(requester.role!=="owner"){
        await cleanupUnprocessedUpload(req)
        return res.status(403).json({message:"Only shop owners can create or edit a shop"})
       }
       const {name,city,state,address}=req.body
       if(req.file){
        uploadedImage=await uploadOnCloudinary(req.file.path)
       } 
       let shop=await Shop.findOne({owner:req.userId})
       if(!shop){
        shop=await Shop.create({
        name,city,state,address,image:uploadedImage,owner:req.userId
       })
        imageCommitted=true
       }else{
         const previousImage=shop.image
         const updateFields={name,city,state,address,owner:req.userId}
         if(uploadedImage) updateFields.image=uploadedImage
         const updatedShop=await Shop.findByIdAndUpdate(shop._id,updateFields,{new:true})
         if(!updatedShop) throw new Error("shop update failed")
         shop=updatedShop
         imageCommitted=true
         if(uploadedImage && previousImage!==uploadedImage){
            await deleteShopImageIfUnreferenced(previousImage,shop._id)
         }
       }
      
       await shop.populate("owner items")
       return res.status(201).json(shop)
    } catch (error) {
    console.error("Shop creation failed:", {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        http_code: error?.http_code
    });

    await cleanupUnprocessedUpload(req)

    if(uploadedImage && !imageCommitted){
        await deleteCloudinaryAsset(uploadedImage)
    }

    return res.status(500).json({
        message: "Failed to create shop. Please try again."
    })
}
}

export const getMyShop=async (req,res) => {
    try {
        const shop=await Shop.findOne({owner:req.userId}).populate("owner").populate({
            path:"items",
            options:{sort:{updatedAt:-1}}
        })
        if(!shop){
            // An owner without a shop is a normal state; the frontend treats
            // a null body the same as the historical no-response case.
            return res.status(200).json(null)
        }
        return res.status(200).json(shop)
    } catch (error) {
        return res.status(500).json({message: "Failed to retrieve your shop. Please try again."})
    }
}

export const getShopByCity=async (req,res) => {
    try {
        const cityCheck=sanitizeSearchText(req.params.city)
        if (!cityCheck.ok) {
            return res.status(400).json({
                message: cityCheck.tooLong ? "city must be 100 characters or less" : "city is required"
            })
        }

        const shops=await Shop.find({
            city:{$regex:exactTextPattern(cityCheck.text)}
        }).populate({
            path: "items",
            match: { isAvailable: { $ne: false } }
        })
        if(!shops){
            return res.status(400).json({message:"shops not found"})
        }
        return res.status(200).json(shops)
    } catch (error) {
        return res.status(500).json({message: "Failed to retrieve shop by city. Please try again."})
    }
}