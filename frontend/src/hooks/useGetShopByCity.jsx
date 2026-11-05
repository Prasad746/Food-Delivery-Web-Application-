import axios from 'axios'
import React, { useEffect } from 'react'
import { serverUrl } from '../utils/csrfClient'
import { useDispatch, useSelector } from 'react-redux'
import { setShopsInMyCity } from '../redux/userSlice'

function useGetShopByCity() {
    const dispatch=useDispatch()
    const {currentCity}=useSelector(state=>state.user)
  useEffect(()=>{
  if(!currentCity){
    dispatch(setShopsInMyCity(null))
    return
  }
  const fetchShops=async () => {
    try {
           const result=await axios.get(`${serverUrl}/api/shop/get-by-city/${encodeURIComponent(currentCity)}`,{withCredentials:true})
             dispatch(setShopsInMyCity(result.data))
     } catch (error) {
        console.log(error)
    }
}
fetchShops()
 
  },[currentCity, dispatch])
}

export default useGetShopByCity
