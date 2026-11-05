import { useCallback, useEffect, useRef, useState } from "react"
import { useDispatch } from "react-redux"
import api from "../utils/axiosInstance"
import { syncCartItems } from "../redux/userSlice"
import { buildCartPricingFields } from "../utils/discountPricing"

function useRefreshCartPricing(cartItems) {
    const dispatch = useDispatch()
    const itemsRef = useRef(cartItems)
    const requestRef = useRef(0)
    const [status, setStatus] = useState("idle")
    const [error, setError] = useState("")
    const idsKey = (cartItems || []).map(item => String(item.id)).sort().join("|")

    useEffect(() => {
        itemsRef.current = cartItems
    }, [cartItems])

    const refresh = useCallback(async () => {
        const currentItems = itemsRef.current || []
        if (currentItems.length === 0) {
            setStatus("idle")
            setError("")
            return true
        }

        const requestId = requestRef.current + 1
        requestRef.current = requestId
        setStatus("loading")
        setError("")

        const settled = await Promise.all(currentItems.map(async (item) => {
            try {
                const result = await api.get(`/api/item/get-by-id/${item.id}`)
                return { ok: true, itemId: item.id, item: result.data }
            } catch (requestError) {
                return {
                    ok: false,
                    itemId: item.id,
                    status: requestError?.response?.status
                }
            }
        }))

        if (requestRef.current !== requestId) {
            return false
        }

        const updates = []
        let failed = false
        for (const entry of settled) {
            if (entry.ok) {
                const fields = buildCartPricingFields(entry.item)
                if (fields.id) {
                    updates.push(fields)
                }
            } else if (entry.status === 400 || entry.status === 404) {
                updates.push({ id: entry.itemId, isAvailable: false })
            } else {
                failed = true
            }
        }

        if (updates.length > 0) {
            dispatch(syncCartItems(updates))
        }
        if (failed) {
            setStatus("error")
            setError("Could not refresh item prices. Check your connection and try again.")
            return false
        }

        setStatus("ready")
        return true
    }, [dispatch])

    useEffect(() => {
        refresh()
    }, [idsKey, refresh])

    return {
        status,
        error,
        refreshing: status === "loading",
        refresh
    }
}

export default useRefreshCartPricing
