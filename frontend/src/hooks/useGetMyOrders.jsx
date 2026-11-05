import axios from 'axios'
import React, { useEffect } from 'react'
import { serverUrl } from '../utils/csrfClient'
import { useDispatch, useSelector } from 'react-redux'
import { setMyOrders } from '../redux/userSlice'

function useGetMyOrders() {
    const dispatch=useDispatch()
    const {userData}=useSelector(state=>state.user)
  useEffect(()=>{
  const fetchOrders=async () => {
    try {
           const result=await axios.get(`${serverUrl}/api/order/my-orders`,{withCredentials:true})
            dispatch(setMyOrders(result.data))
   


    } catch (error) {
        console.log(error)
    }
}
  fetchOrders()

 
  
  },[dispatch, userData])
}

export default useGetMyOrders
