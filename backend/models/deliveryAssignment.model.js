import mongoose from "mongoose";

const deliveryAssignmentSchema = new mongoose.Schema({
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order"
    },
    shop: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Shop"
    },
    shopOrderId:{
         type: mongoose.Schema.Types.ObjectId,
         required:true
    },
    brodcastedTo:[
        {
         type: mongoose.Schema.Types.ObjectId,
         ref:"User"
    }
    ],
    assignedTo:{
        type: mongoose.Schema.Types.ObjectId,
         ref:"User",
         default:null
    },
    status:{
        type:String,
        enum:["brodcasted","assigned","completed"],
        default:"brodcasted"
    }
    ,
    acceptedAt:Date,
    active:{
        type: Boolean,
        default: true
    }
}, { timestamps: true })

deliveryAssignmentSchema.index({ assignedTo: 1 }, {
    unique: true,
    name: "unique_active_assignment_per_worker",
    partialFilterExpression: { assignedTo: { $type: "objectId" } }
})

// a shop order may hold at most one open broadcast/assignment record at a time;
// exiting flows either delete the record (OTP verification) or flip active:false
deliveryAssignmentSchema.index({ shopOrderId: 1, active: 1 }, {
    unique: true,
    name: "unique_open_assignment_per_shop_order",
    partialFilterExpression: { active: true }
})

const DeliveryAssignment=mongoose.model("DeliveryAssignment",deliveryAssignmentSchema)
export default DeliveryAssignment