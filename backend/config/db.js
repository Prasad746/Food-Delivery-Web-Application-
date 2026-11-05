import mongoose from "mongoose"

const connectDb=async () => {
    if (!process.env.MONGODB_URL) {
        throw new Error("MONGODB_URL is not configured")
    }
    await mongoose.connect(process.env.MONGODB_URL)
    console.log("db connected")
    return mongoose.connection
}

export default connectDb