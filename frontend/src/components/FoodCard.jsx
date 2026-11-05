import React, { useState } from 'react'
import { FaLeaf } from "react-icons/fa";
import { FaDrumstickBite } from "react-icons/fa";
import { FaStar } from "react-icons/fa";
import { FaRegStar } from "react-icons/fa6";
import { FaMinus } from "react-icons/fa";
import { FaPlus } from "react-icons/fa";
import { FaShoppingCart } from "react-icons/fa";
import { useDispatch, useSelector } from 'react-redux';
import { addToCart } from '../redux/userSlice';
import { discountBadgeLabel, formatAmount, getItemPricing } from '../utils/discountPricing';

const MAX_ITEM_QUANTITY = 99

function FoodCard({data}) {
const [quantity,setQuantity]=useState(0)
const dispatch=useDispatch()
const {cartItems}=useSelector(state=>state.user)
const pricing = getItemPricing(data)
const badge = pricing.discountApplied ? discountBadgeLabel(data.discount) : ""
    const renderStars=(rating)=>{   //r=3
        const stars=[];
        for (let i = 1; i <= 5; i++) {
            stars.push(
            (i<=rating)?(
                <FaStar className='text-yellow-500 text-lg' key={i}/>
            ):(
                <FaRegStar className='text-yellow-500 text-lg' key={i}/>
            )
            )
            
        }
return stars
    }

const handleIncrease=()=>{
    if(quantity<MAX_ITEM_QUANTITY){
setQuantity(quantity+1)
    }
}
const handleDecrease=()=>{
    if(quantity>0){
    setQuantity(quantity-1)
    }
    
}

const shopId = data.shop && typeof data.shop === "object" ? data.shop._id : data.shop

  return (
    <div className='w-[250px] rounded-2xl border-2 border-[#ff4d2d] bg-white shadow-md overflow-hidden hover:shadow-xl transition-all duration-300 flex flex-col'>
      <div className='relative w-full h-[170px] flex justify-center items-center bg-white'>
        <div className='absolute top-3 right-3 bg-white rounded-full p-1 shadow'>{data.foodType=="veg"?<FaLeaf className='text-green-600 text-lg'/>:<FaDrumstickBite className='text-red-600 text-lg'/>}</div>
        {badge && (
          <span className='absolute left-3 top-3 rounded-full bg-[#ff4d2d] px-2 py-1 text-xs font-semibold text-white shadow'>
            {badge}
          </span>
        )}

<img src={data.image} alt={data.name} className='w-full h-full object-cover transition-transform duration-300 hover:scale-105'/>
      </div>

      <div className="flex-1 flex flex-col p-4">
<h1 className='font-semibold text-gray-900 text-base truncate'>{data.name}</h1>

<div className='flex items-center gap-1 mt-1'>
{renderStars(data.rating?.average || 0)}
<span className='text-xs text-gray-500'>
    {data.rating?.count || 0}
</span>
</div>
      </div>

<div className='flex items-center justify-between mt-auto p-3'>
<div className='leading-tight'>
    <div className='flex items-baseline gap-2'>
        <span className='font-bold text-gray-900 text-lg'>
            ₹{formatAmount(pricing.finalPrice)}
        </span>
        {pricing.discountApplied && (
            <span className='text-sm text-gray-400 line-through'>
                ₹{formatAmount(pricing.originalPrice)}
            </span>
        )}
    </div>
    {pricing.discountApplied && <p className='text-xs font-medium text-green-700'>You save ₹{formatAmount(pricing.discountAmount)}</p>}
</div>

<div className='flex items-center border rounded-full overflow-hidden shadow-sm'>
<button type='button' aria-label='Decrease quantity' className='px-2 py-1 hover:bg-gray-100 transition' onClick={handleDecrease}>
<FaMinus size={12}/>
</button>
<span>{quantity}</span>
<button type='button' aria-label='Increase quantity' className='px-2 py-1 hover:bg-gray-100 transition' onClick={handleIncrease}>
<FaPlus size={12}/>
</button>
<button type='button' aria-label='Add item to cart' className={`${cartItems.some(i=>i.id==data._id)?"bg-gray-800":"bg-[#ff4d2d]"} text-white px-3 py-2 transition-colors`}  onClick={()=>{
    quantity>0 && data.isAvailable!==false ?dispatch(addToCart({
          id:data._id,
          name:data.name,
          price:pricing.finalPrice,
          originalPrice:pricing.originalPrice,
          discountType:pricing.discountType,
          discountValue:pricing.discountValue,
          discountAmount:pricing.discountAmount,
          finalPrice:pricing.finalPrice,
          discountApplied:pricing.discountApplied,
          image:data.image,
          shop:shopId,
          quantity,
          foodType:data.foodType,
          isAvailable:data.isAvailable!==false
})):null}}>
<FaShoppingCart size={16}/>
</button>
</div>
</div>


    </div>
  )
}

export default FoodCard
