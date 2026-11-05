import mongoose from "mongoose";

const shopOrderItemSchema = new mongoose.Schema({
    item:{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Item",
        required:true
    },
    name:String,
    price:Number,
    originalPrice:{
        type:Number,
        min:0
    },
    discountType:{
        type:String,
        enum:["", "percentage", "fixed"],
        default:""
    },
    discountValue:{
        type:Number,
        min:0,
        default:0
    },
    discountAmount:{
        type:Number,
        min:0,
        default:0
    },
    finalPrice:{
        type:Number,
        min:0
    },
    quantity:Number
}, { timestamps: true })

const refundSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: ["not_required", "pending", "processing", "processed", "failed"],
        default: "not_required"
    },
    amount: {
        type: Number,
        min: 0,
        default: 0
    },
    razorpayRefundId: {
        type: String,
        default: ""
    },
    processedAt: {
        type: Date,
        default: null
    },
    failureReason: {
        type: String,
        default: ""
    },
    attempts: {
        type: Number,
        default: 0
    },
    lastAttemptAt: {
        type: Date,
        default: null
    }
}, { _id: false })

const shopOrderSchema = new mongoose.Schema({
    shop: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Shop"
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    subtotal: Number,
    shopOrderItems: [shopOrderItemSchema],
    status:{
        type:String,
        enum:["pending","preparing","out of delivery","delivered","cancelled"],
        default:"pending"
    },
  assignment:{
     type: mongoose.Schema.Types.ObjectId,
    ref: "DeliveryAssignment",
    default:null
  },
  assignedDeliveryBoy:{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
deliveryOtp:{
        type:String,
        default:null
    },
otpExpires:{
        type:Date,
        default:null
    },
otpAttempts:{
        type:Number,
        default:0
    },
    deliveredAt:{
        type:Date,
        default:null
    },
    cancelledAt:{
        type:Date,
        default:null
    },
    cancelledBy:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
        default:null
    },
    cancellationReason:{
        type:String,
        trim:true,
        maxlength:300,
        default:""
    },
    refund:{
        type:refundSchema,
        default:() => ({})
    }

}, { timestamps: true })

const orderSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    paymentMethod: {
        type: String,
        enum: ['cod', "online"],
        required: true
    },
    deliveryAddress: {
        text: String,
        latitude: Number,
        longitude: Number
    },
    totalAmount: {
        type: Number
    }
    ,
    shopOrders: [shopOrderSchema],
    payment:{
        type:Boolean,
        default:false
    },
    razorpayOrderId:{
        type:String,
        default:""
    },
   razorpayPaymentId:{
    type:String,
       default:""
   }
}, { timestamps: true })

orderSchema.index({ "shopOrders.owner": 1, createdAt: -1 }, { name: "restaurant_analytics_by_owner" })

const Order=mongoose.model("Order",orderSchema)
export default Order