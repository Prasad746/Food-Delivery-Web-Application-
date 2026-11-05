import mongoose from "mongoose";
import { isValidDiscountConfig } from "../utils/pricing.js";

const discountSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["percentage", "fixed"],
        required: true
    },
    value: {
        type: Number,
        required: true,
        min: 0
    },
    startDate: {
        type: Date,
        default: null
    },
    endDate: {
        type: Date,
        default: null
    },
    enabled: {
        type: Boolean,
        default: true
    }
}, { _id: false })

const validationPriceFor = (context) => {
    if (context && typeof context.price === "number") {
        return context.price
    }
    if (context && typeof context.getUpdate === "function") {
        const update = context.getUpdate() || {}
        const source = update.$set && update.$set.price !== undefined ? update.$set : update
        if (source.price !== undefined) {
            return Number(source.price)
        }
    }
    return undefined
}

const itemSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    image: {
        type: String,
        required: true
    },
    shop: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Shop"
    },
    category: {
        type: String,
        enum: ["Snacks",
            "Main Course",
            "Desserts",
            "Pizza",
            "Burgers",
            "Sandwiches",
            "South Indian",
            "North Indian",
            "Chinese",
            "Fast Food",
            "Others"
        ],
        required:true
    },
    price:{
        type:Number,
        min:0,
        required:true
    },
    foodType:{
        type:String,
        enum:["veg","non veg"],
        required:true
    },
    isAvailable:{
        type:Boolean,
        default:true
    },
   rating:{
    average:{type:Number,default:0},
    count:{type:Number,default:0}
   },
   discount: {
    type: discountSchema,
    default: undefined,
    validate: {
        validator: function (discount) {
            if (!discount) {
                return true
            }
            return isValidDiscountConfig(discount, validationPriceFor(this))
        },
        message: "Invalid discount configuration"
    }
   }
}, { timestamps: true })

const Item=mongoose.model("Item",itemSchema)
export default Item