import React, { useEffect, useRef, useState } from 'react'
import { IoIosArrowRoundBack } from "react-icons/io";
import { IoSearchOutline } from "react-icons/io5";
import { TbCurrentLocation } from "react-icons/tb";
import { IoLocationSharp } from "react-icons/io5";
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import { useDispatch, useSelector } from 'react-redux';
import "leaflet/dist/leaflet.css"
import { setAddress, setLocation } from '../redux/mapSlice';
import { MdDeliveryDining } from "react-icons/md";
import { FaCreditCard } from "react-icons/fa";
import axios from '../utils/axiosInstance';
import { serverUrl } from '../utils/csrfClient';
import { FaMobileScreenButton } from "react-icons/fa6";
import { useNavigate } from 'react-router-dom';
import { addMyOrder } from '../redux/userSlice'
import useRefreshCartPricing from '../hooks/useRefreshCartPricing';
import { calculateCartTotals, discountBadgeLabel, formatAmount, getCartItemPricing } from '../utils/discountPricing';

const hasCoordinates = (location) => {
  const lat = location?.lat
  const lon = location?.lon
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

function RecenterMap({ location }) {
  const map = useMap();
  useEffect(() => {
    if (hasCoordinates(location)) {
      map.setView([location.lat, location.lon], 16, { animate: true });
    }
  }, [location, map]);
  return null;
}

function CheckOut() {
  const { location, address } = useSelector(state => state.map)
    const { cartItems } = useSelector(state => state.user)
  const [addressInput, setAddressInput] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("cod")
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderError, setOrderError] = useState("")
  const placingOrderRef = useRef(false)
  const navigate=useNavigate()
  const dispatch = useDispatch()
  const apiKey = import.meta.env.VITE_GEOAPIKEY
  const totals = calculateCartTotals(cartItems)
  const { refreshing, error: pricingError, refresh } = useRefreshCartPricing(cartItems)
  const unavailableItems = cartItems.filter(item => item.isAvailable === false)
  const hasValidAddress = addressInput.trim().length > 0
  const canPlaceOrder = cartItems.length > 0 && !placingOrder && !refreshing && !pricingError && unavailableItems.length === 0 && hasCoordinates(location) && hasValidAddress






  const onDragEnd = (e) => {
    const { lat, lng } = e.target._latlng
    dispatch(setLocation({ lat, lon: lng }))
    getAddressByLatLng(lat, lng)
  }
  const getCurrentLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation?.getCurrentPosition) {
      if (hasCoordinates(location)) {
        getAddressByLatLng(location.lat, location.lon)
      } else {
        alert("Unable to access your current location. Please search for an address or drag the map marker.")
      }
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        dispatch(setLocation({ lat: latitude, lon: longitude }))
        getAddressByLatLng(latitude, longitude)
      },
      () => {
        if (hasCoordinates(location)) {
          getAddressByLatLng(location.lat, location.lon)
        } else {
          alert("Unable to access your current location. Please search for an address or drag the map marker.")
        }
      },
      { enableHighAccuracy: true }
    )
  }

  const getAddressByLatLng = async (lat, lng) => {
    try {

      const result = await axios.get(`https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lng}&format=json&apiKey=${apiKey}`)
      dispatch(setAddress(result?.data?.results[0].address_line2))
    } catch (error) {
      console.log(error)
    }
  }

  const getLatLngByAddress = async () => {
    try {
      const result = await axios.get(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(addressInput)}&apiKey=${apiKey}`)
      const { lat, lon } = result.data.features[0].properties
      dispatch(setLocation({ lat, lon }))
    } catch (error) {
      console.log(error)
    }
  }

  const handlePlaceOrder=async () => {
    if (placingOrderRef.current || !canPlaceOrder) {
      return
    }
    placingOrderRef.current = true
    setPlacingOrder(true)
    setOrderError("")
    try {
      const pricingIsCurrent = await refresh()
      if (!pricingIsCurrent) {
        return
      }
      const csrfToken = window.__VINGO_CSRF_TOKEN || ''
      const cart = cartItems.map(item => ({
        id: item.id,
        shop: item.shop,
        quantity: item.quantity
      }))
      const result=await axios.post(`${serverUrl}/api/order/place-order`,{
        paymentMethod,
        deliveryAddress:{
          text:addressInput,
          latitude:location.lat,
          longitude:location.lon
        },
        cartItems: cart
      },{withCredentials:true, headers: { 'X-XSRF-TOKEN': csrfToken }})

      if(paymentMethod=="cod"){
      const order = result.data
      dispatch(addMyOrder(result.data))
      const confirmation = {
        serverTotal: Number(order?.totalAmount),
        previewTotal: totals.total,
        orderId: order?._id
      }
      if (Number.isFinite(confirmation.serverTotal)) {
        navigate("/order-placed", { state: confirmation })
      } else {
        navigate("/order-placed")
      }
      }else{
        const orderId=result.data.orderId
        const razorOrder=result.data.razorOrder
          if (Number.isFinite(totals.total)) {
            openRazorpayWindow(orderId,razorOrder,totals.total)
          } else {
            openRazorpayWindow(orderId,razorOrder)
          }
       }
    
    } catch (error) {
      setOrderError(error?.response?.data?.message || "Failed to place order. Please try again.")
    } finally {
      placingOrderRef.current = false
      setPlacingOrder(false)
    }
  }

const loadRazorpayScript = () => {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && window.Razorpay) {
      return resolve(true);
    }
    const existingScript = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(true));
      existingScript.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
};

const openRazorpayWindow = async (orderId, razorOrder, previewTotal) => {
  const isLoaded = await loadRazorpayScript();
  if (!isLoaded || typeof window.Razorpay === "undefined") {
    alert("Razorpay payment gateway failed to load. Please check your internet connection.");
    return;
  }

  const options = {
    key: import.meta.env.VITE_RAZORPAY_KEY_ID,
    amount: razorOrder.amount,
    currency: razorOrder.currency || 'INR',
    name: "Vingo",
    description: "Food Delivery Website",
    order_id: razorOrder.id,
    handler: async function (response) {
      try {
        const csrfToken = window.__VINGO_CSRF_TOKEN || ''
        const result = await axios.post(`${serverUrl}/api/order/verify-payment`, {
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_order_id: response.razorpay_order_id,
          razorpay_signature: response.razorpay_signature,
          orderId
        }, { withCredentials: true, headers: { 'X-XSRF-TOKEN': csrfToken } });
        dispatch(addMyOrder(result.data));
        navigate("/order-placed", {
          state: {
            serverTotal: Number(result.data?.totalAmount),
            previewTotal,
            orderId
          }
        });
      } catch (error) {
        console.error("Payment verification error:", error);
        alert(error?.response?.data?.message || "Payment verification failed. Please contact support.");
      }
    },
    modal: {
      ondismiss: function () {
        console.log("Payment window closed by user");
      }
    }
  };

  const rzp = new window.Razorpay(options);
  rzp.on('payment.failed', function (response) {
    console.error("Razorpay payment failed:", response.error);
    alert(`Payment Failed: ${response.error?.description || 'Transaction could not be completed'}`);
  });
  rzp.open();
};


  useEffect(() => {
    setAddressInput(address || "")
  }, [address])
  return (
    <div className='min-h-screen bg-[#fff9f6] flex items-center justify-center p-6'>
      <div className=' absolute top-[20px] left-[20px] z-[10]' onClick={() => navigate("/")}>
        <IoIosArrowRoundBack size={35} className='text-[#ff4d2d]' />
      </div>
      <div className='w-full max-w-[900px] bg-white rounded-2xl shadow-xl p-6 space-y-6'>
        <h1 className='text-2xl font-bold text-gray-800'>Checkout</h1>

        <section>
          <h2 className='text-lg font-semibold mb-2 flex items-center gap-2 text-gray-800'><IoLocationSharp className='text-[#ff4d2d]' /> Delivery Location</h2>
          <div className='flex gap-2 mb-3'>
            <input type="text" className='flex-1 border border-gray-300 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff4d2d]' placeholder='Enter Your Delivery Address..' value={addressInput} onChange={(e) => setAddressInput(e.target.value)} />
            <button className='bg-[#ff4d2d] hover:bg-[#e64526] text-white px-3 py-2 rounded-lg flex items-center justify-center' onClick={getLatLngByAddress}><IoSearchOutline size={17} /></button>
            <button className='bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded-lg flex items-center justify-center' onClick={getCurrentLocation}><TbCurrentLocation size={17} /></button>
          </div>
           <div className='rounded-xl border overflow-hidden'>
             <div className='h-64 w-full flex items-center justify-center'>
               {hasCoordinates(location) ? (
               <MapContainer
                 className={"w-full h-full"}
                 center={[location.lat, location.lon]}
                 zoom={16}
               >
                 <TileLayer
                   attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                   url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                 />
                 <RecenterMap location={location} />
                 <Marker position={[location.lat, location.lon]} draggable eventHandlers={{ dragend: onDragEnd }} />


               </MapContainer>
               ) : (
                 <div role='status' className='flex h-full w-full items-center justify-center bg-gray-100 text-sm text-gray-600'>
                   Enter an address or use your current location to show the map.
                 </div>
               )}
             </div>
           </div>
        </section>

        <section>
          <h2 className='text-lg font-semibold mb-3 text-gray-800'>Payment Method</h2>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
            <div className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${paymentMethod === "cod" ? "border-[#ff4d2d] bg-orange-50 shadow" : "border-gray-200 hover:border-gray-300"
              }`} onClick={() => setPaymentMethod("cod")}>

              <span className='inline-flex h-10 w-10 items-center justify-center rounded-full bg-green-100'>
                <MdDeliveryDining className='text-green-600 text-xl' />
              </span>
              <div >
                <p className='font-medium text-gray-800'>Cash On Delivery</p>
                <p className='text-xs text-gray-500'>Pay when your food arrives</p>
              </div>

            </div>
            <div className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${paymentMethod === "online" ? "border-[#ff4d2d] bg-orange-50 shadow" : "border-gray-200 hover:border-gray-300"
              }`} onClick={() => setPaymentMethod("online")}>

              <span className='inline-flex h-10 w-10 items-center justify-center rounded-full bg-purple-100'>
                <FaMobileScreenButton className='text-purple-700 text-lg' />
              </span>
              <span className='inline-flex h-10 w-10 items-center justify-center rounded-full bg-blue-100'>
                <FaCreditCard className='text-blue-700 text-lg' />
              </span>
              <div>
                <p className='font-medium text-gray-800'>UPI / Credit / Debit Card</p>
                <p className='text-xs text-gray-500'>Pay Securely Online</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className='text-lg font-semibold mb-3 text-gray-800'>Order Summary</h2>
<div className='rounded-xl border bg-gray-50 p-4 space-y-2'>
{cartItems.map((item,index)=>{
  const pricing = getCartItemPricing(item)
  const badge = pricing.discountApplied
    ? discountBadgeLabel({ type: pricing.discountType, value: pricing.discountValue })
    : ""
  return (
  <div key={item.id || index} className='flex justify-between gap-3 text-sm text-gray-700'>
    <div>
      <span>{item.name} x {item.quantity}</span>
      {badge && <span className='ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-[#c43a22]'>{badge}</span>}
      {pricing.discountApplied && <p className='text-xs text-green-700'>You save ₹{formatAmount(pricing.savings)}</p>}
    </div>
    <div className='text-right'>
      {pricing.discountApplied && <p className='text-xs text-gray-400 line-through'>₹{formatAmount(pricing.originalLineTotal)}</p>}
      <span>₹{formatAmount(pricing.lineTotal)}</span>
    </div>
  </div>
  )
})}
 <hr className='border-gray-200 my-2'/>
<div className='flex justify-between font-medium text-gray-800'>
  <span>Subtotal after discounts</span>
  <span>₹{formatAmount(totals.subtotal)}</span>
</div>
{totals.savings > 0 && (
  <div className='flex justify-between text-green-700'>
    <span>Discount savings</span>
    <span>-₹{formatAmount(totals.savings)}</span>
  </div>
)}
<div className='flex justify-between text-gray-700'>
  <span>Delivery Fee</span>
  <span>{totals.deliveryFee==0?"Free":`₹${formatAmount(totals.deliveryFee)}`}</span>
</div>
<div className='flex justify-between text-lg font-bold text-[#ff4d2d] pt-2'>
    <span>Total</span>
  <span>₹{formatAmount(totals.total)}</span>
</div>
<p className='text-xs text-gray-500'>Final prices, discounts and delivery fee are confirmed by the server when the order is placed.</p>
</div>
        </section>
        {refreshing && <p className='text-sm text-gray-500' role='status'>Refreshing item prices before checkout...</p>}
        {pricingError && (
          <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700' role='alert'>
            <p>{pricingError}</p>
            <button type='button' className='mt-2 font-semibold underline' onClick={refresh}>Retry</button>
          </div>
        )}
        {unavailableItems.length > 0 && (
          <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700' role='alert'>
            Remove unavailable items from your cart before placing this order.
          </div>
        )}
        {orderError && <p className='text-sm text-red-600' role='alert'>{orderError}</p>}
        <button className={`w-full bg-[#ff4d2d] hover:bg-[#e64526] text-white py-3 rounded-xl font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${!canPlaceOrder ? "cursor-not-allowed opacity-60" : ""}`} onClick={handlePlaceOrder} disabled={placingOrder} aria-disabled={!canPlaceOrder}>{placingOrder ? "Placing order..." : paymentMethod=="cod"?"Place Order":"Pay & Place Order"}</button>

      </div>
    </div>
  )
}

export default CheckOut
