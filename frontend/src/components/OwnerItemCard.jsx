import axios from '../utils/axiosInstance';
import React from 'react'
import { FaPen } from "react-icons/fa";
import { FaTrashAlt } from "react-icons/fa";
import { useNavigate } from 'react-router-dom';
import { serverUrl } from '../utils/csrfClient';
import { useDispatch } from 'react-redux';
import { setMyShopData } from '../redux/ownerSlice';
import { discountBadgeLabel, formatAmount, formatDiscountDate, getItemPricing } from '../utils/discountPricing';

const STATUS_STYLES = {
    active: "bg-green-100 text-green-700",
    scheduled: "bg-blue-100 text-blue-700",
    expired: "bg-red-100 text-red-700",
    disabled: "bg-gray-100 text-gray-600",
    invalid: "bg-red-100 text-red-700",
    none: "bg-gray-100 text-gray-600"
}

function OwnerItemCard({data}) {
    const navigate=useNavigate()
    const dispatch=useDispatch()
    const pricing = getItemPricing(data)
    const status = pricing.status
    const badge = data.discount ? discountBadgeLabel(data.discount) : ""
    const handleDelete=async () => {
      try {
        const result=await axios.delete(`${serverUrl}/api/item/delete/${data._id}`,{withCredentials:true})
        dispatch(setMyShopData(result.data))
      } catch (error) {
        console.log(error)
      }
    }
  return (
    <div className='flex bg-white rounded-lg shadow-md overflow-hidden border border-[#ff4d2d] w-full max-w-2xl'>
      <div className='w-36  flex-shrink-0 bg-gray-50'>
        <img src={data.image} alt="" className='w-full h-full object-cover'/>
      </div>
      <div className='flex flex-col justify-between p-3 flex-1 gap-3'>
          <div>
<h2 className='text-base font-semibold text-[#ff4d2d]'>{data.name}</h2>
<p><span className='font-medium text-gray-70'>Category:</span> {data.category}</p>
<p><span className='font-medium text-gray-70'>Food Type:</span> {data.foodType}</p>

<div className='mt-2 flex flex-wrap items-center gap-2 text-xs'>
    <span className={`rounded-full px-2 py-1 font-medium ${STATUS_STYLES[status.state] || STATUS_STYLES.none}`}>
        {status.label}
    </span>
    {badge && <span className='rounded-full bg-orange-50 px-2 py-1 font-medium text-[#c43a22]'>{badge}</span>}
</div>

<p className='mt-1 text-xs text-gray-500'>
    {data.discount
        ? `Configured: ${data.discount.type === "percentage" ? `${formatAmount(data.discount.value)}% off` : `₹${formatAmount(data.discount.value)} off`}`
        : "No discount configured"}
</p>

{(status.startsAt || status.endsAt) && (
    <p className='mt-1 text-xs text-gray-500'>
        {status.startsAt ? `Starts ${formatDiscountDate(status.startsAt)}` : ""}
        {status.startsAt && status.endsAt ? " · " : ""}
        {status.endsAt ? `Ends ${formatDiscountDate(status.endsAt)}` : ""}
    </p>
)}
          </div>
          <div className='flex items-center justify-between'>
            <div>
              <p className='text-xs text-gray-500'>Original price ₹{formatAmount(pricing.originalPrice)}</p>
              <div className='flex items-baseline gap-2'>
                <span className='text-[#ff4d2d] font-bold'>₹{formatAmount(pricing.finalPrice)}</span>
                {pricing.discountApplied && (
                  <span className='text-xs text-gray-500 line-through'>₹{formatAmount(pricing.originalPrice)}</span>
                )}
              </div>
            </div>
          <div className='flex items-center gap-2'>
<div className='p-2 cursor-pointer rounded-full hover:bg-[#ff4d2d]/10  text-[#ff4d2d]' onClick={()=>navigate(`/edit-item/${data._id}`)}>
<FaPen size={16}/>
</div>
<div className='p-2 cursor-pointer rounded-full hover:bg-[#ff4d2d]/10  text-[#ff4d2d]' onClick={handleDelete}>
<FaTrashAlt size={16}/>
</div>
          </div>

          </div>
      </div>
    </div>
  )
}

export default OwnerItemCard
