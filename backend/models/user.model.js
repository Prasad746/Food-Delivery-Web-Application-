import mongoose from "mongoose";
import { USER_ROLES } from "../utils/roles.js";

const userSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique:true
    },
    firebaseUid:{
        type: String,
        unique: true,
        sparse: true,
        select: false
    },
    password:{
        type: String,
        select: false
    },
    mobile:{
        type: String,
        required: true, 
    },
    role:{
        type:String,
        enum:USER_ROLES,
        required:true
    },
    authVersion:{
        type: Number,
        default: 0,
        min: 0
    },
    resetOtp:{
        type:String,
        select: false
    },
    // Legacy cleanup field. It is never used to authorize a password reset.
    isOtpVerified:{
        type:Boolean,
        default:false,
        select: false
    },
    resetPasswordTokenHash:{
        type:String,
        select: false
    },
    resetPasswordExpires:{
        type:Date,
        select: false
    },
    otpExpires:{
        type:Date,
        select: false
    },
    otpAttempts:{
        type: Number,
        default: 0,
        select: false
    },
    socketId:{
     type:String,
     select: false
     
    },
    isOnline:{
        type:Boolean,
        default:false
    },
   location:{
type:{type:String,enum:['Point'],default:'Point'},
coordinates:{type:[Number],default:[0,0]}
   }
  
}, { timestamps: true })

userSchema.index({location:'2dsphere'})


const User=mongoose.model("User",userSchema)
export default User