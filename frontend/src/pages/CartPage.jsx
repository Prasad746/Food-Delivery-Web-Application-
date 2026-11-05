import React from 'react'
import { IoIosArrowRoundBack } from "react-icons/io";
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import CartItemCard from '../components/CartItemCard';
import useRefreshCartPricing from '../hooks/useRefreshCartPricing';
import { calculateCartTotals, formatAmount } from '../utils/discountPricing';
function CartPage() {
    const navigate = useNavigate()
    const { cartItems } = useSelector(state => state.user)
    const { refreshing, error, refresh } = useRefreshCartPricing(cartItems)
    const totals = calculateCartTotals(cartItems)
    return (
        <div className='min-h-screen bg-[#fff9f6] flex justify-center p-6'>
            <div className='w-full max-w-[800px]'>
                <div className='flex items-center gap-[20px] mb-6 '>
                    <div className=' z-[10] ' onClick={() => navigate("/")}>
                        <IoIosArrowRoundBack size={35} className='text-[#ff4d2d]' />
                    </div>
                    <h1 className='"text-2xl font-bold  text-start'>Your Cart</h1>
                </div>
                {refreshing && <p className='mb-4 text-sm text-gray-500' role='status'>Refreshing item prices...</p>}
                {error && (
                    <div className='mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700' role='alert'>
                        <p>{error}</p>
                        <button className='mt-2 font-semibold underline' onClick={refresh}>Retry</button>
                    </div>
                )}
                {cartItems?.length == 0 ? (
                    <p className='text-gray-500 text-lg text-center'>Your Cart is Empty</p>
                ) : (<>
                    <div className='space-y-4'>
                        {cartItems?.map((item, index) => (
                            <CartItemCard data={item} key={index} />
                        ))}
                    </div>
                    <div className='mt-6 bg-white p-4 rounded-xl shadow flex justify-between items-center border'>
                        <div>
                            <h1 className='text-lg font-semibold'>Subtotal after discounts</h1>
                            {totals.savings > 0 && <p className='text-sm font-medium text-green-700'>You save ₹{formatAmount(totals.savings)}</p>}
                            <p className='text-xs text-gray-500'>Delivery fee is confirmed at checkout.</p>
                        </div>
                        <span className='text-xl font-bold text-[#ff4d2d]'>₹{formatAmount(totals.subtotal)}</span>
                    </div>
                    <div className='mt-4 flex justify-end' > 
                        <button className='bg-[#ff4d2d] text-white px-6 py-3 rounded-lg text-lg font-medium hover:bg-[#e64526] transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-60' onClick={()=>navigate("/checkout")} disabled={refreshing || Boolean(error)}>Proceed to CheckOut</button>
                    </div>
                </>
                )}
            </div>
        </div>
    )
}

export default CartPage
