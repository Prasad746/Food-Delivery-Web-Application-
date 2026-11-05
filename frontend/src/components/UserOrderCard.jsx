import axios from '../utils/axiosInstance'
import React, { useState } from 'react'
import { useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { updateRealtimeOrderStatus } from '../redux/userSlice'
import { serverUrl } from '../utils/csrfClient'
import { discountBadgeLabel, formatAmount, getHistoricalItemPricing } from '../utils/discountPricing'

const CANCELLABLE_STATUSES = ["pending", "preparing"]

const refundLabel = (refund) => {
    if (!refund) return ""
    if (refund.status === "processed") return "Refund initiated"
    if (refund.status === "processing" || refund.status === "pending") return "Refund is being processed"
    if (refund.status === "failed") return "Refund could not be initiated. Please contact support."
    return ""
}

function UserOrderCard({ data }) {
    const navigate = useNavigate()
    const dispatch = useDispatch()
    const [selectedRating, setSelectedRating] = useState({})
    const [cancelTarget, setCancelTarget] = useState(null)
    const [cancelReason, setCancelReason] = useState("")
    const [cancelError, setCancelError] = useState("")
    const [cancellingId, setCancellingId] = useState("")
    const [cancelFeedback, setCancelFeedback] = useState({})

    const formatDate = (dateString) => {
        const date = new Date(dateString)
        return date.toLocaleString('en-GB', {
            day: "2-digit",
            month: "short",
            year: "numeric"
        })
    }

    const handleRating = async (itemId, rating) => {
        try {
            await axios.post(`${serverUrl}/api/item/rating`, { itemId, rating }, { withCredentials: true })
            setSelectedRating(prev => ({
                ...prev, [itemId]: rating
            }))
        } catch (error) {
            console.log(error)
        }
    }

    const canCancel = (shopOrder) => CANCELLABLE_STATUSES.includes(shopOrder?.status)

    const openCancelDialog = (shopOrder) => {
        setCancelTarget(shopOrder)
        setCancelReason("")
        setCancelError("")
    }

    const closeCancelDialog = () => {
        if (cancellingId) return
        setCancelTarget(null)
        setCancelReason("")
        setCancelError("")
    }

    const handleCancelOrder = async () => {
        if (!cancelTarget || cancellingId) return
        const shopOrderId = cancelTarget._id
        const shopId = cancelTarget.shop?._id ?? cancelTarget.shop
        setCancellingId(shopOrderId)
        setCancelError("")
        try {
            const result = await axios.post(
                `${serverUrl}/api/order/cancel/${data._id}/${shopOrderId}`,
                { reason: cancelReason.trim() },
                { withCredentials: true }
            )
            const updatedShopOrder = result.data?.shopOrder
            dispatch(updateRealtimeOrderStatus({
                orderId: data._id,
                shopId,
                status: updatedShopOrder?.status || "cancelled",
                refund: updatedShopOrder?.refund ?? result.data?.refund,
                cancelledAt: updatedShopOrder?.cancelledAt,
                cancellationReason: updatedShopOrder?.cancellationReason ?? result.data?.shopOrder?.cancellationReason
            }))
            setCancelFeedback(prev => ({
                ...prev,
                [shopOrderId]: {
                    type: updatedShopOrder?.refund?.status === "failed" ? "error" : "success",
                    message: result.data?.message || "Order cancelled successfully"
                }
            }))
            setCancelTarget(null)
            setCancelReason("")
        } catch (error) {
            setCancelError(error?.response?.data?.message || "Failed to cancel this order. Please try again.")
        } finally {
            setCancellingId("")
        }
    }

    return (
        <div className='bg-white rounded-lg shadow p-4 space-y-4'>
            <div className='flex justify-between border-b pb-2'>
                <div>
                    <p className='font-semibold'>
                        order #{data._id.slice(-6)}
                    </p>
                    <p className='text-sm text-gray-500'>
                        Date: {formatDate(data.createdAt)}
                    </p>
                </div>
                <div className='text-right'>
                    {data.paymentMethod == "cod" ? <p className='text-sm text-gray-500'>{data.paymentMethod?.toUpperCase()}</p> : <p className='text-sm text-gray-500 font-semibold'>Payment: {data.payment ? "true" : "false"}</p>}

                    <p className='font-medium text-blue-600'>{data.shopOrders?.[0]?.status}</p>
                </div>
            </div>

            {data.shopOrders.map((shopOrder, index) => (
                <div className='border rounded-lg p-3 bg-[#fffaf7] space-y-3' key={shopOrder._id || index}>
                    <p>{shopOrder.shop?.name}</p>

                    <div className='flex space-x-4 overflow-x-auto pb-2'>
                        {shopOrder.shopOrderItems.map((item, itemIndex) => {
                            const pricing = getHistoricalItemPricing(item)
                            const badge = pricing.discountApplied
                                ? discountBadgeLabel({ type: pricing.discountType, value: pricing.discountValue })
                                : ""
                            return (
                            <div key={item.item?._id || itemIndex} className='flex-shrink-0 w-40 border rounded-lg p-2 bg-white'>
                                <img src={item.item?.image} alt="" className='w-full h-24 object-cover rounded' />
                                <p className='text-sm font-semibold mt-1'>{item.name}</p>
                                <p className='text-xs text-gray-500'>
                                    Qty: {item.quantity} x ₹{formatAmount(pricing.finalPrice)}
                                </p>
                                {pricing.discountApplied && (
                                    <div className='mt-1 text-xs'>
                                        <p className='text-gray-400 line-through'>Original: ₹{formatAmount(pricing.originalPrice)}</p>
                                        <p className='font-medium text-green-700'>{badge} · Saved ₹{formatAmount(pricing.discountAmount)}</p>
                                    </div>
                                )}

                                {shopOrder.status == "delivered" && <div className='flex space-x-1 mt-2'>
                                    {[1, 2, 3, 4, 5].map((star) => (
                                        <button className={`text-lg ${selectedRating[item.item?._id] >= star ? 'text-yellow-400' : 'text-gray-400'}`} onClick={() => handleRating(item.item?._id, star)} key={star}>★</button>
                                    ))}
                                </div>}
                            </div>
                            )
                        })}
                    </div>

                    {shopOrder.status === "cancelled" && (
                        <div className='rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700 space-y-1'>
                            <p className='font-semibold'>This restaurant order was cancelled</p>
                            {shopOrder.cancellationReason && <p>Reason: {shopOrder.cancellationReason}</p>}
                            {refundLabel(shopOrder.refund) && <p>{refundLabel(shopOrder.refund)}</p>}
                        </div>
                    )}

                    {cancelFeedback[shopOrder._id] && (
                        <p className={`text-sm ${cancelFeedback[shopOrder._id].type === "success" ? "text-green-700" : "text-red-600"}`}>
                            {cancelFeedback[shopOrder._id].message}
                        </p>
                    )}

                    <div className='flex justify-between items-center border-t pt-2 gap-3'>
                        <p className='font-semibold'>Subtotal: {shopOrder.subtotal}</p>
                        <div className='flex items-center gap-3'>
                            {canCancel(shopOrder) && (
                                <button
                                    type='button'
                                    className='border border-red-500 text-red-600 hover:bg-red-50 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60'
                                    onClick={() => openCancelDialog(shopOrder)}
                                    disabled={cancellingId === shopOrder._id}
                                >
                                    {cancellingId === shopOrder._id ? "Cancelling..." : "Cancel"}
                                </button>
                            )}
                            <span className={`text-sm font-medium ${shopOrder.status === "cancelled" ? "text-red-600" : "text-blue-600"}`}>{shopOrder.status}</span>
                        </div>
                    </div>
                </div>
            ))}

            <div className='flex justify-between items-center border-t pt-2'>
                <p className='font-semibold'>Total: ₹{data.totalAmount}</p>
                <button className='bg-[#ff4d2d] hover:bg-[#e64526] text-white px-4 py-2 rounded-lg text-sm' onClick={() => navigate(`/track-order/${data._id}`)}>Track Order</button>
            </div>

            {cancelTarget && (
                <div className='fixed inset-0 z-[10000] bg-black/40 flex items-center justify-center p-4'>
                    <div className='w-full max-w-md rounded-xl bg-white p-5 shadow-2xl space-y-4' role='dialog' aria-modal='true' aria-labelledby='cancel-order-title'>
                        <div>
                            <h2 id='cancel-order-title' className='text-lg font-bold text-gray-900'>Cancel this restaurant order?</h2>
                            <p className='text-sm text-gray-600 mt-1'>{cancelTarget.shop?.name}</p>
                        </div>
                        <p className='text-sm text-gray-600'>
                            Only this restaurant's items will be cancelled. Your other restaurant orders in this checkout will continue as normal.
                        </p>
                        {data.paymentMethod === "online" && Number(cancelTarget.subtotal) > 0 && (
                            <p className='text-sm text-gray-600'>
                                A refund of ₹{cancelTarget.subtotal} will be initiated to your original payment method. The checkout delivery fee is not refunded.
                            </p>
                        )}
                        <div className='space-y-1'>
                            <label htmlFor='cancel-reason' className='block text-sm font-medium text-gray-700'>Reason (optional)</label>
                            <textarea
                                id='cancel-reason'
                                className='w-full rounded-lg border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff4d2d]'
                                rows={3}
                                maxLength={300}
                                value={cancelReason}
                                onChange={(event) => setCancelReason(event.target.value)}
                                placeholder='Tell us why you are cancelling'
                                disabled={Boolean(cancellingId)}
                            />
                            <p className='text-right text-xs text-gray-400'>{cancelReason.length}/300</p>
                        </div>
                        {cancelError && <p className='text-sm text-red-600'>{cancelError}</p>}
                        <div className='flex justify-end gap-3'>
                            <button
                                type='button'
                                className='rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-60'
                                onClick={closeCancelDialog}
                                disabled={Boolean(cancellingId)}
                            >
                                Keep order
                            </button>
                            <button
                                type='button'
                                className='rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60'
                                onClick={handleCancelOrder}
                                disabled={Boolean(cancellingId)}
                            >
                                {cancellingId ? "Cancelling..." : "Confirm cancellation"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default UserOrderCard
