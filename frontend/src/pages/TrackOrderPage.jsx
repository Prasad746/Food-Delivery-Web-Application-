import axios from 'axios'
import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { serverUrl } from '../utils/csrfClient'
import { useEffect } from 'react'
import { useState } from 'react'
import { IoIosArrowRoundBack } from "react-icons/io";
import DeliveryBoyTracking from '../components/DeliveryBoyTracking'
import useSocket from '../hooks/useSocket'
function TrackOrderPage() {
    const { orderId } = useParams()
    const [currentOrder, setCurrentOrder] = useState() 
    const navigate = useNavigate()
    const socket=useSocket()
    const [liveLocations,setLiveLocations]=useState({})
    useEffect(()=> {
      if(!socket){
          return undefined
      }
      const handleDeliveryLocation=({deliveryBoyId,latitude,longitude})=>{
          setLiveLocations(prev=>({
              ...prev,
              [deliveryBoyId]:{lat:latitude,lon:longitude}
          }))
      }
      const handleOrderStatus=({orderId: updatedOrderId,shopId,status,refund,cancelledAt})=>{
          if(String(updatedOrderId)!==String(orderId)){
              return
          }
          setCurrentOrder(prev=>{
              if(!prev){
                  return prev
              }
              return {
                  ...prev,
                  shopOrders: (prev.shopOrders || []).map(shopOrder=>{
                      const currentShopId = shopOrder.shop?._id ?? shopOrder.shop
                      if(String(currentShopId)!==String(shopId)){
                          return shopOrder
                      }
                      return {
                          ...shopOrder,
                          status,
                          ...(refund !== undefined ? { refund } : {}),
                          ...(cancelledAt !== undefined ? { cancelledAt } : {})
                      }
                  })
              }
          })
      }
      socket.on('updateDeliveryLocation',handleDeliveryLocation)
      socket.on('update-status',handleOrderStatus)
      return ()=>{
          socket.off('updateDeliveryLocation',handleDeliveryLocation)
          socket.off('update-status',handleOrderStatus)
      }
    },[socket,orderId])

    useEffect(() => {
        const getOrder = async () => {
            try {
                const result = await axios.get(`${serverUrl}/api/order/get-order-by-id/${orderId}`, { withCredentials: true })
                setCurrentOrder(result.data)
            } catch (error) {
                console.log(error)
            }
        }
        getOrder()
    }, [orderId])
    return (
        <div className='max-w-4xl mx-auto p-4 flex flex-col gap-6'>
            <div className='relative flex items-center gap-4 top-[20px] left-[20px] z-[10] mb-[10px]' onClick={() => navigate("/")}>
                <IoIosArrowRoundBack size={35} className='text-[#ff4d2d]' />
                <h1 className='text-2xl font-bold md:text-center'>Track Order</h1>
            </div>
      {currentOrder?.shopOrders?.map((shopOrder,index)=>(
        <div className='bg-white p-4 rounded-2xl shadow-md border border-orange-100 space-y-4' key={index}>
         <div>
            <p className='text-lg font-bold mb-2 text-[#ff4d2d]'>{shopOrder.shop.name}</p>
            <p className='font-semibold'><span>Items:</span> {shopOrder.shopOrderItems?.map(i=>i.name).join(",")}</p>
            <p><span className='font-semibold'>Subtotal:</span> {shopOrder.subtotal}</p>
            <p className='mt-6'><span className='font-semibold'>Delivery address:</span> {currentOrder.deliveryAddress?.text}</p>
            <p className='mt-2 text-sm text-gray-500 capitalize'>Status: {shopOrder.status}</p>
         </div>
         {shopOrder.status === "cancelled" ?
         <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 space-y-1'>
            <p className='font-semibold'>This restaurant order was cancelled</p>
            {shopOrder.cancellationReason && <p>Reason: {shopOrder.cancellationReason}</p>}
            {shopOrder.refund?.status === "processed" && <p>Refund initiated</p>}
            {(shopOrder.refund?.status === "pending" || shopOrder.refund?.status === "processing") && <p>Refund is being processed</p>}
            {shopOrder.refund?.status === "failed" && <p>Refund could not be initiated. Please contact support.</p>}
         </div>
         : shopOrder.status!="delivered"?<>
{shopOrder.assignedDeliveryBoy?
<div className='text-sm text-gray-700'>
<p className='font-semibold'><span>Delivery Boy Name:</span> {shopOrder.assignedDeliveryBoy.fullName}</p>
<p className='font-semibold'><span>Delivery Boy contact No.:</span> {shopOrder.assignedDeliveryBoy.mobile}</p>
</div>:<p className='font-semibold'>Delivery Boy is not assigned yet.</p>}
         </>:<p className='text-green-600 font-semibold text-lg'>Delivered</p>}

{(shopOrder.assignedDeliveryBoy && shopOrder.status !== "delivered" && shopOrder.status !== "cancelled") && (
  <div className="h-[400px] w-full rounded-2xl overflow-hidden shadow-md">
    <DeliveryBoyTracking data={{
      deliveryBoyLocation:liveLocations[shopOrder.assignedDeliveryBoy._id] || {
        lat: shopOrder.assignedDeliveryBoy.location?.coordinates?.[1],
        lon: shopOrder.assignedDeliveryBoy.location?.coordinates?.[0]
      },
      customerLocation: {
        lat: currentOrder.deliveryAddress.latitude,
        lon: currentOrder.deliveryAddress.longitude
      }
    }} />
  </div>
)}



        </div>
      ))}



        </div>
    )
}

export default TrackOrderPage
