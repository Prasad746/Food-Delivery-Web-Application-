import express from "express"
import mongoose from "mongoose"

export const createHealthRouter = ({
    getConnectionState = () => mongoose.connection.readyState
} = {}) => {
    const router = express.Router()

    router.get("/healthz", (req, res) => {
        return res.status(200).json({ status: "ok" })
    })

    router.get("/readyz", (req, res) => {
        const isReady = getConnectionState() === 1
        return res.status(isReady ? 200 : 503).json({
            status: isReady ? "ready" : "unavailable"
        })
    })

    return router
}
