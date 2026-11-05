import React, { useEffect, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { IoIosArrowRoundBack } from "react-icons/io";
import { useNavigate } from 'react-router-dom';
import UserOrderCard from '../components/UserOrderCard';
import OwnerOrderCard from '../components/OwnerOrderCard';
import { setMyOrders, updateOrderStatus, updateRealtimeOrderStatus } from '../redux/userSlice';
import useSocket from '../hooks/useSocket';


function MyOrders() {
  const { userData, myOrders } = useSelector(state => state.user)
  const socket = useSocket()
  const myOrdersRef = useRef(myOrders)
  const userDataRef = useRef(userData)
  useEffect(() => { myOrdersRef.current = myOrders }, [myOrders])
  useEffect(() => { userDataRef.current = userData }, [userData])
  const navigate = useNavigate()
  const dispatch = useDispatch()
  useEffect(() => {
    if (!socket) {
      return undefined
    }
    const handleNewOrder = (data) => {
      if (data.shopOrders?.owner._id == userDataRef.current?._id) {
        dispatch(setMyOrders([data, ...myOrdersRef.current]))
      }
    }
    const handleOrderStatus = ({ orderId, shopId, status, userId, ownerId, refund, cancelledAt, cancellationReason }) => {
      const currentUser = userDataRef.current
      if (userId == currentUser?._id) {
        dispatch(updateRealtimeOrderStatus({ orderId, shopId, status, refund, cancelledAt, cancellationReason }))
      } else if (ownerId && ownerId == currentUser?._id) {
        dispatch(updateOrderStatus({ orderId, shopId, status, refund, cancelledAt, cancellationReason }))
      }
    }
    socket.on('newOrder', handleNewOrder)
    socket.on('update-status', handleOrderStatus)

    return () => {
      socket.off('newOrder', handleNewOrder)
      socket.off('update-status', handleOrderStatus)
    }
  }, [socket, dispatch])



  
  return (
    <div className='"w-full min-h-screen bg-[#fff9f6] flex justify-center px-4'>
      <div className='w-full max-w-[800px] p-4'>

        <div className='flex items-center gap-[20px] mb-6 '>
          <div className=' z-[10] ' onClick={() => navigate("/")}>
            <IoIosArrowRoundBack size={35} className='text-[#ff4d2d]' />
          </div>
          <h1 className='text-2xl font-bold  text-start'>My Orders</h1>
        </div>
        <div className='space-y-6'>
          {myOrders?.map((order,index)=>(
            userData.role=="user" ?
            (
              <UserOrderCard data={order} key={index}/>
            )
            :
            userData.role=="owner"? (
              <OwnerOrderCard data={order} key={index}/>
            )
            :
            null
          ))}
        </div>
      </div>
    </div>
  )
}

export default MyOrders
