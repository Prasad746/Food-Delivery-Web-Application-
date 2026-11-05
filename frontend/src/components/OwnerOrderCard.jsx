import axios from '../utils/axiosInstance';
import React from 'react';
import { MdPhone } from "react-icons/md";
import { serverUrl } from '../utils/csrfClient';
import { useDispatch } from 'react-redux';
import { updateOrderStatus } from '../redux/userSlice';
import { discountBadgeLabel, formatAmount, getHistoricalItemPricing } from '../utils/discountPricing';

const refundMessage = (refund) => {
    if (!refund) return "";

    if (refund.status === "processed") {
        return "Refund to customer initiated";
    }

    if (refund.status === "processing" || refund.status === "pending") {
        return "Refund is being processed";
    }

    if (refund.status === "failed") {
        return "Refund could not be initiated. Please contact support.";
    }

    return "";
};

function OwnerOrderCard({ data }) {
    const dispatch = useDispatch();

    const shopOrder = data?.shopOrders;

    const onlinePaymentPending =
        data?.paymentMethod === "online" && data?.payment !== true;

    const isCancelled = shopOrder?.status === "cancelled";

    const handleUpdateStatus = async (orderId, shopId, status) => {
        if (onlinePaymentPending) return;

        try {
            await axios.post(
                `${serverUrl}/api/order/update-status/${orderId}/${shopId}`,
                { status },
                { withCredentials: true }
            );

            dispatch(
                updateOrderStatus({
                    orderId,
                    shopId,
                    status
                })
            );
        } catch (error) {
            console.error("Failed to update the order status", error);
        }
    };

    const shopOrderItems = shopOrder?.shopOrderItems || [];

    return (
        <div className='bg-white rounded-lg shadow p-4 space-y-4'>

            {/* Customer Information */}

            <div>
                <h2 className='text-lg font-semibold text-gray-800'>
                    {data?.user?.fullName || "Customer"}
                </h2>

                <p className='text-sm text-gray-500'>
                    {data?.user?.email || "Email unavailable"}
                </p>

                <p className='flex items-center gap-2 text-sm text-gray-600 mt-1'>
                    <MdPhone />

                    <span>
                        {data?.user?.mobile || "Mobile unavailable"}
                    </span>
                </p>

                {data?.paymentMethod === "online" ? (
                    <p className='gap-2 text-sm text-gray-600'>
                        Payment: {data?.payment ? "Confirmed" : "Awaiting confirmation"}
                    </p>
                ) : (
                    <p className='gap-2 text-sm text-gray-600'>
                        Payment Method: {data?.paymentMethod || "Unavailable"}
                    </p>
                )}
            </div>


            {/* Delivery Address */}

            <div className='flex items-start flex-col gap-2 text-gray-600 text-sm'>

                <p>
                    {data?.deliveryAddress?.text || "Delivery address unavailable"}
                </p>

                <p className='text-xs text-gray-500'>
                    Lat: {data?.deliveryAddress?.latitude ?? "N/A"},
                    {" "}Lon: {data?.deliveryAddress?.longitude ?? "N/A"}
                </p>

            </div>


            {/* Order Items */}

            <div className='flex space-x-4 overflow-x-auto pb-2'>

                {shopOrderItems.map((item, index) => {

                    const foodItem = item?.item;

                    const itemName =
                        item?.name ||
                        foodItem?.name ||
                        "Food item unavailable";

                    const itemImage =
                        foodItem?.image ||
                        "/placeholder.png";

                    const pricing = getHistoricalItemPricing(item);
                    const badge = pricing.discountApplied
                        ? discountBadgeLabel({ type: pricing.discountType, value: pricing.discountValue })
                        : "";

                    return (
                        <div
                            key={item?._id || index}
                            className='flex-shrink-0 w-40 border rounded-lg p-2 bg-white'
                        >

                            <img
                                src={itemImage}
                                alt={itemName}
                                className='w-full h-24 object-cover rounded'
                                onError={(e) => {
                                    e.currentTarget.onerror = null;
                                    e.currentTarget.src = "/placeholder.png";
                                }}
                            />

                            <p className='text-sm font-semibold mt-1'>
                                {itemName}
                            </p>

                            <p className='text-xs text-gray-500'>
                                Qty: {item?.quantity ?? 0} x ₹{formatAmount(pricing.finalPrice)}
                            </p>

                            {pricing.discountApplied && (
                                <div className='mt-1 text-xs'>
                                    <p className='text-gray-400 line-through'>Original: ₹{formatAmount(pricing.originalPrice)}</p>
                                    <p className='font-medium text-green-700'>{badge} · Saved ₹{formatAmount(pricing.discountAmount)}</p>
                                </div>
                            )}

                        </div>
                    );
                })}

                {shopOrderItems.length === 0 && (
                    <p className='text-sm text-gray-500'>
                        No order items available
                    </p>
                )}

            </div>


            {/* Order Status */}

            <div className='flex justify-between items-center mt-auto pt-3 border-t border-gray-100'>

                <span className='text-sm'>

                    status:

                    <span
                        className={`font-semibold capitalize ${
                            isCancelled
                                ? "text-red-600"
                                : "text-[#ff4d2d]"
                        }`}
                    >
                        {" "}{shopOrder?.status || "Unavailable"}
                    </span>

                </span>


                {/* Cancelled Order */}

                {isCancelled ? (

                    <p className='text-sm font-medium text-red-600'>
                        Cancelled by customer
                    </p>

                ) : onlinePaymentPending ? (

                    <p className='text-sm font-medium text-amber-600'>
                        Awaiting online payment confirmation
                    </p>

                ) : (

                    <select
                        className='rounded-md border px-3 py-1 text-sm focus:outline-none focus:ring-2 border-[#ff4d2d] text-[#ff4d2d]'
                        value=""
                        onChange={(e) => {
                            const status = e.target.value;

                            if (!status) return;

                            handleUpdateStatus(
                                data._id,
                                shopOrder?.shop?._id,
                                status
                            );
                        }}
                    >

                        <option value="">
                            Change
                        </option>

                        <option value="pending">
                            Pending
                        </option>

                        <option value="preparing">
                            Preparing
                        </option>

                        <option value="out of delivery">
                            Out Of Delivery
                        </option>

                    </select>

                )}

            </div>


            {/* Cancellation and Refund Information */}

            {isCancelled && (

                <div className="mt-3 p-2 border border-red-200 rounded-lg text-sm bg-red-50 text-red-700 space-y-1">

                    {shopOrder?.cancellationReason && (
                        <p>
                            Reason: {shopOrder.cancellationReason}
                        </p>
                    )}

                    {refundMessage(shopOrder?.refund) && (
                        <p>
                            {refundMessage(shopOrder?.refund)}
                        </p>
                    )}

                </div>

            )}


            {/* Delivery Partner Information */}

            {!isCancelled &&
                !onlinePaymentPending &&
                shopOrder?.status === "out of delivery" && (

                    <div className="mt-3 p-2 border rounded-lg text-sm bg-orange-50 gap-4">

                        {shopOrder?.assignedDeliveryBoy ? (

                            <div>

                                {shopOrder.assignedDeliveryBoy.fullName || "Delivery partner"}

                                {" - "}

                                {shopOrder.assignedDeliveryBoy.mobile || "Mobile unavailable"}

                            </div>

                        ) : (

                            <div>
                                Waiting for a delivery partner to accept
                            </div>

                        )}

                    </div>

                )}


            {/* Order Total */}

            <div className='text-right font-bold text-gray-800 text-sm'>

                Total: ₹{shopOrder?.subtotal ?? 0}

            </div>

        </div>
    );
}

export default OwnerOrderCard;