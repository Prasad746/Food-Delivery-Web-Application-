import React from 'react'
import { FaCircleCheck } from "react-icons/fa6";
import { useLocation, useNavigate } from 'react-router-dom';
import { formatAmount } from '../utils/discountPricing';
function OrderPlaced() {
    const navigate=useNavigate()
    const location=useLocation()
    const confirmation=location.state
    const serverTotal=Number(confirmation?.serverTotal)
    const previewTotal=Number(confirmation?.previewTotal)
    const hasServerTotal=Number.isFinite(serverTotal)
    const totalChanged=hasServerTotal
        && Number.isFinite(previewTotal)
        && Math.abs(serverTotal-previewTotal) > 0.009
  return (
    <div className='min-h-screen bg-[#fff9f6] flex flex-col justify-center items-center px-4 text-center relative overflow-hidden'>
      <FaCircleCheck className='text-green-500 text-6xl mb-4'/>
      <h1 className='text-3xl font-bold text-gray-800 mb-2'>Order Placed!
      </h1>
      <p className='text-gray-600 max-w-md mb-6'>Thank you for your purchase. Your order is being prepared.  
        You can track your order status in the "My Orders" section.
     </p>
     {hasServerTotal && (
       <div className='mb-6 max-w-md rounded-xl border border-orange-100 bg-white px-5 py-3 text-center shadow-sm'>
         <p className='text-sm text-gray-500'>Server-confirmed total</p>
         <p className='text-2xl font-bold text-[#ff4d2d]'>₹{formatAmount(serverTotal)}</p>
         {totalChanged && (
           <p className='mt-2 text-sm text-amber-700'>
             The final total was recalculated by the server. Your checkout preview was ₹{formatAmount(previewTotal)}.
           </p>
         )}
       </div>
     )}
     <button className='bg-[#ff4d2d] hover:bg-[#e64526] text-white px-6 py-3 rounded-lg text-lg font-medium transition' onClick={()=>navigate("/my-orders")}>Back to my orders</button>
    </div>
  )
}

export default OrderPlaced

