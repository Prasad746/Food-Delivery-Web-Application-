import mongoose from "mongoose"

const revokedSessionSchema = new mongoose.Schema({
    tokenHash: {
        type: String,
        required: true,
        unique: true
    },
    expiresAt: {
        type: Date,
        required: true
    }
}, { timestamps: true })

revokedSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

const RevokedSession = mongoose.model("RevokedSession", revokedSessionSchema)

export default RevokedSession
