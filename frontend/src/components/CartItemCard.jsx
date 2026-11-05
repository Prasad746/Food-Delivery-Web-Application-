import React from 'react'
import { FaMinus } from "react-icons/fa";
import { FaPlus } from "react-icons/fa";
import { CiTrash } from "react-icons/ci";
import { useDispatch } from 'react-redux';
import { removeCartItem, updateQuantity } from '../redux/userSlice';
import { discountBadgeLabel, formatAmount, getCartItemPricing } from '../utils/discountPricing';
function CartItemCard({data}) {
    const dispatch=useDispatch()
    const pricing = getCartItemPricing(data)
    const badge = pricing.discountApplied
        ? discountBadgeLabel({ type: pricing.discountType, value: pricing.discountValue })
        : ""
    const handleIncrease=(id,currentQty)=>{
       dispatch(updateQuantity({id,quantity:currentQty+1}))
    }
      const handleDecrease=(id,currentQty)=>{
        if(currentQty>1){
  dispatch(updateQuantity({id,quantity:currentQty-1}))
        }
        
    }
  return (
    <div className='flex items-center justify-between bg-white p-4 rounded-xl shadow border'>
      <div className='flex items-center gap-4'>
        <img src={data.image} alt="" className='w-20 h-20 object-cover rounded-lg border'/>
        <div>
            <h1 className='font-medium text-gray-800'>{data.name}</h1>
            {badge && <span className='inline-block rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-[#c43a22]'>{badge}</span>}
            <p className='text-sm text-gray-500'>
                {pricing.discountApplied && <span className='mr-1 line-through'>₹{formatAmount(pricing.originalPrice)}</span>}
                <span>₹{formatAmount(pricing.finalPrice)} x {data.quantity}</span>
            </p>
            <p className="font-bold text-gray-900">₹{formatAmount(pricing.lineTotal)}</p>
            {pricing.discountApplied && <p className='text-xs font-medium text-green-700'>You save ₹{formatAmount(pricing.savings)}</p>}
            {data.isAvailable === false && <p className='text-xs font-medium text-red-600'>Item is no longer available</p>}
        </div>
      </div>
      <div className='flex items-center gap-3'>
        <button className='p-2 cursor-pointer bg-gray-100 rounded-full hover:bg-gray-200' onClick={()=>handleDecrease(data.id,data.quantity)}>
        <FaMinus size={12}/>
        </button>
        <span>{data.quantity}</span>
        <button className='p-2 cursor-pointer bg-gray-100 rounded-full hover:bg-gray-200'  onClick={()=>handleIncrease(data.id,data.quantity)}>
        <FaPlus size={12}/>
        </button>
        <button className="p-2 bg-red-100 text-red-600 rounded-full hover:bg-red-200"
 onClick={()=>dispatch(removeCartItem(data.id))}>
<CiTrash size={18}/>
        </button>
      </div>
    </div>
  )
}

export default CartItemCard
