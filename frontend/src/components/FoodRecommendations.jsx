import React, { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { FaArrowRight, FaRedo } from 'react-icons/fa'
import api from '../utils/axiosInstance'
import FoodCard from './FoodCard'

const SOURCE_MESSAGES = {
    history: "Based on your delivered orders, favorite cuisines, and restaurants.",
    popular: "Popular dishes from restaurants that are currently available.",
    fallback: "Available dishes to help you find your next meal."
}

function FoodRecommendations() {
    const [payload, setPayload] = useState(null)
    const [status, setStatus] = useState("loading")
    const [reloadKey, setReloadKey] = useState(0)
    const { cartItems } = useSelector((state) => state.user)
    const navigate = useNavigate()

    useEffect(() => {
        const controller = new AbortController()
        let active = true

        const loadRecommendations = async () => {
            setStatus("loading")
            try {
                const result = await api.get("/api/item/recommendations", {
                    params: { limit: 8 },
                    signal: controller.signal
                })
                if (!active) {
                    return
                }
                setPayload(result.data)
                setStatus("success")
            } catch (error) {
                if (!active || error.code === "ERR_CANCELED") {
                    return
                }
                setPayload(null)
                setStatus("error")
            }
        }

        loadRecommendations()
        return () => {
            active = false
            controller.abort()
        }
    }, [reloadKey])

    const recommendations = useMemo(() => payload?.recommendations || [], [payload])
    const cartIds = useMemo(
        () => new Set((cartItems || []).map((item) => String(item.id))),
        [cartItems]
    )
    const visibleRecommendations = useMemo(
        () => recommendations.filter((item) => !cartIds.has(String(item._id))),
        [recommendations, cartIds]
    )

    const subtitle = SOURCE_MESSAGES[payload?.meta?.source] || SOURCE_MESSAGES.fallback

    return (
        <section className="w-full max-w-6xl flex flex-col gap-5 items-start p-[10px]" aria-labelledby="food-recommendations-title">
            <div>
                <h2 id="food-recommendations-title" className="text-gray-800 text-2xl sm:text-3xl">
                    Recommended For You
                </h2>
                <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
            </div>

            {status === "loading" && (
                <div className="w-full flex flex-wrap gap-5 justify-center" aria-busy="true">
                    {[0, 1, 2, 3].map((item) => (
                        <div key={item} className="w-[250px] h-[290px] rounded-2xl border border-orange-100 bg-white p-4 animate-pulse">
                            <div className="w-full h-[140px] rounded-xl bg-gray-200" />
                            <div className="h-4 w-3/4 rounded bg-gray-200 mt-4" />
                            <div className="h-3 w-1/2 rounded bg-gray-200 mt-3" />
                            <div className="h-8 w-full rounded-full bg-gray-200 mt-8" />
                        </div>
                    ))}
                </div>
            )}

            {status === "error" && (
                <div className="w-full rounded-2xl border border-orange-100 bg-white p-6 text-center shadow-sm">
                    <p className="text-gray-700">Recommendations are unavailable right now.</p>
                    <button
                        type="button"
                        onClick={() => setReloadKey((value) => value + 1)}
                        className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#ff4d2d] px-4 py-2 text-sm font-medium text-white hover:bg-[#e64528] transition-colors"
                    >
                        <FaRedo size={12} />
                        Try again
                    </button>
                </div>
            )}

            {status === "success" && visibleRecommendations.length === 0 && (
                <div className="w-full rounded-2xl border border-orange-100 bg-white p-6 text-center shadow-sm">
                    <p className="text-gray-600">
                        {recommendations.length > 0
                            ? "Your recommendations are already in your cart."
                            : "No recommendations yet. Place and receive an order to unlock personalized picks."}
                    </p>
                </div>
            )}

            {status === "success" && visibleRecommendations.length > 0 && (
                <div className="w-full flex flex-wrap gap-5 justify-center">
                    {visibleRecommendations.map((item) => (
                        <div key={item._id} className="flex w-[250px] flex-col">
                            <FoodCard data={{ ...item, shop: item.shopId }} />
                            <div className="flex flex-1 flex-col gap-2 px-1 pt-3">
                                <span className="self-start rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-[#c43a22]">
                                    {item.recommendation?.reason || "Recommended"}
                                </span>
                                <p className="text-sm font-medium text-gray-700 truncate">
                                    {item.shop?.name || "Restaurant"}
                                    {item.shop?.city ? ` • ${item.shop.city}` : ""}
                                </p>
                                <button
                                    type="button"
                                    onClick={() => navigate(`/shop/${item.shopId}`)}
                                    className="mt-auto inline-flex items-center gap-2 self-start text-sm font-semibold text-[#ff4d2d] hover:text-[#c43a22] transition-colors"
                                >
                                    View restaurant
                                    <FaArrowRight size={12} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    )
}

export default FoodRecommendations
