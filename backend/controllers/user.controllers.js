import User from "../models/user.model.js"
import { toValidCoordinates } from "../socket.js"

// The only profile fields any authenticated client may receive; everything
// sensitive (credentials, reset OTPs, socket identity) stays excluded.
export const sanitizeUserProfile = (user) => {
    if (!user) {
        return null
    }
    return {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        location: user.location
    }
}

export const getCurrentUser=async (req,res) => {
    try {
        const userId=req.userId
        if(!userId){
            return res.status(400).json({message:"userId is not found"})
        }
        const user=await User.findById(userId)
        if(!user){
               return res.status(400).json({message:"user is not found"})
        }
        return res.status(200).json(sanitizeUserProfile(user))
    } catch (error) {
        return res.status(500).json({ message: "Failed to retrieve current user. Please try again." })
    }
}

export const updateUserLocation=async (req,res) => {
    try {
        const body=req.body||{}
        const coordinates=toValidCoordinates(body.lat,body.lon)
        if(!coordinates){
            return res.status(400).json({message:"Valid latitude and longitude are required"})
        }
        const requester=await User.findById(req.userId,"role")
        if(!requester){
            return res.status(401).json({message:"Authentication required"})
        }
        if(requester.role!=="deliveryBoy"){
            return res.status(403).json({message:"Only delivery partners can update live location"})
        }
        const user=await User.findByIdAndUpdate(req.userId,{
            location:{
                type:'Point',
                coordinates:[coordinates.longitude,coordinates.latitude]
            }
        },{new:true})
         if(!user){
               return res.status(400).json({message:"user is not found"})
        }

        return res.status(200).json({message:'location updated'})
    } catch (error) {
           return res.status(500).json({ message: "Failed to update user location. Please try again." })
    }
}

