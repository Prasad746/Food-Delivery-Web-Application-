import React, { useEffect, useState } from 'react'
import { IoIosSearch } from "react-icons/io";
import { FiShoppingCart } from "react-icons/fi";
import { useDispatch, useSelector } from 'react-redux';
import { RxCross2 } from "react-icons/rx";
import axios from '../utils/axiosInstance';
import { serverUrl } from '../utils/csrfClient';
import { bootstrapCsrfToken } from '../utils/csrfClient';
import { setSearchItems, setUserData, clearSessionState } from '../redux/userSlice';
import { setMyShopData, clearOwnerSessionState } from '../redux/ownerSlice';
import { setLocation, setAddress, clearMapSessionState } from '../redux/mapSlice';
import { FaPlus } from "react-icons/fa6";
import { TbReceipt2 } from "react-icons/tb";
import { useNavigate } from 'react-router-dom';
import LocationPicker from './LocationPicker';
function Nav() {
    const { userData, currentCity ,cartItems} = useSelector(state => state.user)
        const { myShopData} = useSelector(state => state.owner)
    const [showInfo, setShowInfo] = useState(false)
    const [showSearch, setShowSearch] = useState(false)
    const [query,setQuery]=useState("")
    const dispatch = useDispatch()
    const navigate=useNavigate()
    const clearLocalSession = () => {
        dispatch(setUserData(null))
        dispatch(setSearchItems(null))
        dispatch(clearSessionState())
        dispatch(setMyShopData(null))
        dispatch(clearOwnerSessionState())
        dispatch(setLocation({ lat: null, lon: null }))
        dispatch(setAddress(null))
        dispatch(clearMapSessionState())
    }
    const handleLogOut = async () => {
        try {
            await axios.post(`${serverUrl}/api/auth/signout`, {}, { withCredentials: true })
        } catch (error) {
            console.error('Logout failed', error?.response?.status || 'network error')
        } finally {
            window.__VINGO_CSRF_TOKEN = ""
            clearLocalSession()
            bootstrapCsrfToken().catch(err => console.error('CSRF re-bootstrap after logout failed', err))
        }
    }

    useEffect(()=>{
        const normalizedQuery=query.trim()
        if(normalizedQuery){
          (async () => {
            try {
              const params=new URLSearchParams({ query: normalizedQuery, city: currentCity || "" })
              const result = await axios.get(`${serverUrl}/api/item/search-items?${params.toString()}`, { withCredentials: true })
              dispatch(setSearchItems(result.data))
            } catch (error) {
              console.log(error)
            }
          })()
        }else{
              dispatch(setSearchItems(null))
        }

    },[query, currentCity, dispatch])
    return (
        <div className='w-full h-[80px] flex items-center justify-between md:justify-center gap-[30px] px-[20px] fixed top-0 z-[9999] bg-[#fff9f6] overflow-visible'>

            {showSearch && userData.role == "user" && <div className='w-[90%] h-[70px]  bg-white shadow-xl rounded-lg items-center gap-[20px] flex fixed top-[80px] left-[5%] md:hidden'>
                <div className='flex items-center w-[30%] overflow-hidden gap-[10px] px-[10px] border-r-[2px] border-gray-400'>
                    <LocationPicker />
                </div>
                <div className='w-[80%] flex items-center gap-[10px]'>
                    <IoIosSearch size={25} className='text-[#ff4d2d]' />
                    <input type="text" placeholder='search delicious food...' className='px-[10px] text-gray-700 outline-0 w-full' onChange={(e)=>setQuery(e.target.value)} value={query}/>
                </div>
            </div>}



            <h1 className='text-3xl font-bold mb-2 text-[#ff4d2d]'>Vingo</h1>
            {userData.role == "user" && <div className='md:w-[60%] lg:w-[40%] h-[70px] bg-white shadow-xl rounded-lg items-center gap-[20px] hidden md:flex'>
                <div className='flex items-center w-[30%] overflow-hidden gap-[10px] px-[10px] border-r-[2px] border-gray-400'>
                    <LocationPicker />
                </div>
                <div className='w-[80%] flex items-center gap-[10px]'>
                    <IoIosSearch size={25} className='text-[#ff4d2d]' />
                    <input type="text" placeholder='search delicious food...' className='px-[10px] text-gray-700 outline-0 w-full' onChange={(e)=>setQuery(e.target.value)} value={query}/>
                </div>
            </div>}

            <div className='flex items-center gap-4'>
                {userData.role == "user" && (showSearch ? <RxCross2 size={25} className='text-[#ff4d2d] md:hidden' onClick={() => setShowSearch(false)} /> : <IoIosSearch size={25} className='text-[#ff4d2d] md:hidden' onClick={() => setShowSearch(true)} />)
                }
                {userData.role == "owner"? <>
                 {myShopData && <> <button className='hidden md:flex items-center gap-1 p-2 cursor-pointer rounded-full bg-[#ff4d2d]/10 text-[#ff4d2d]' onClick={()=>navigate("/add-item")}>
                        <FaPlus size={20} />
                        <span>Add Food Item</span>
                    </button>
                      <button className='md:hidden flex items-center  p-2 cursor-pointer rounded-full bg-[#ff4d2d]/10 text-[#ff4d2d]' onClick={()=>navigate("/add-item")}>
                        <FaPlus size={20} />
                    </button></>}
                   
                    <div className='hidden md:flex items-center gap-2 cursor-pointer relative px-3 py-1 rounded-lg bg-[#ff4d2d]/10 text-[#ff4d2d] font-medium' onClick={()=>navigate("/my-orders")}>
                      <TbReceipt2 size={20}/>
                      <span>My Orders</span>
                      
                    </div>
                     <div className='md:hidden flex items-center gap-2 cursor-pointer relative px-3 py-1 rounded-lg bg-[#ff4d2d]/10 text-[#ff4d2d] font-medium' onClick={()=>navigate("/my-orders")}>
                      <TbReceipt2 size={20}/>
                      
                    </div>
                </>: (
                    <>
                 {userData.role=="user" &&    <div className='relative cursor-pointer' onClick={()=>navigate("/cart")}>
                    <FiShoppingCart size={25} className='text-[#ff4d2d]' />
                    <span className='absolute right-[-9px] top-[-12px] text-[#ff4d2d]'>{cartItems.length}</span>
                </div>}   
           


                {userData.role!="admin" && <button className='hidden md:block px-3 py-1 rounded-lg bg-[#ff4d2d]/10 text-[#ff4d2d] text-sm font-medium' onClick={()=>navigate("/my-orders")}>
                    My Orders
                </button>}
                    </>
                )}



                <div className='w-[40px] h-[40px] rounded-full flex items-center justify-center bg-[#ff4d2d] text-white text-[18px] shadow-xl font-semibold cursor-pointer' onClick={() => setShowInfo(prev => !prev)}>
                    {userData?.fullName.slice(0, 1)}
                </div>
                {showInfo && <div className={`fixed top-[80px] right-[10px] 
                    ${userData.role=="deliveryBoy"?"md:right-[20%] lg:right-[40%]":"md:right-[10%] lg:right-[25%]"} w-[180px] bg-white shadow-2xl rounded-xl p-[20px] flex flex-col gap-[10px] z-[9999]`}>
                    <div className='text-[17px] font-semibold'>{userData.fullName}</div>
                    {userData.role=="user" && <div className='md:hidden text-[#ff4d2d] font-semibold cursor-pointer' onClick={()=>navigate("/my-orders")}>My Orders</div>}
                    
                    <div className='text-[#ff4d2d] font-semibold cursor-pointer' onClick={handleLogOut}>Log Out</div>
                </div>}

            </div>
        </div>
    )
}


export default Nav
