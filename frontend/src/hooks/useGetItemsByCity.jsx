import axios from 'axios'
import React, { useEffect } from 'react'
import { serverUrl } from '../utils/csrfClient'
import { useDispatch, useSelector } from 'react-redux'
import { setItemsInMyCity } from '../redux/userSlice'

function useGetItemsByCity() {
    const dispatch=useDispatch()
    const {currentCity}=useSelector(state=>state.user)
  useEffect(()=>{
  if(!currentCity){
    dispatch(setItemsInMyCity(null))
    return
  }
  const fetchItems=async () => {
    try {
           const result=await axios.get(`${serverUrl}/api/item/get-by-city/${encodeURIComponent(currentCity)}`,{withCredentials:true})
             dispatch(setItemsInMyCity(result.data))
     } catch (error) {
        console.log(error)
    }
}
fetchItems()
 
  },[currentCity, dispatch])
}

export default useGetItemsByCity
