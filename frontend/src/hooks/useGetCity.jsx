import axios from 'axios'
import React, { useEffect, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { clearCurrentCitySelection, setCurrentAddress, setCurrentCity, setCurrentCitySource, setCurrentState } from '../redux/userSlice'
import { setAddress, setLocation } from '../redux/mapSlice'
import { isDeliveryPartner } from '../utils/locationTracking'
import {
    isCustomerCityAccuracyAcceptable,
    resolveCustomerCityMaxAccuracyMeters
} from '../utils/customerLocation'

const configuredMaxAccuracy = import.meta.env.VITE_CUSTOMER_LOCATION_MAX_ACCURACY_METERS
const MAX_CITY_ACCURACY_METERS = resolveCustomerCityMaxAccuracyMeters(configuredMaxAccuracy)

function useGetCity() {
    const dispatch = useDispatch()
    const { userData, currentCitySource } = useSelector(state => state.user)
    const hasManualCity = currentCitySource === "manual"
    const apiKey = import.meta.env.VITE_GEOAPIKEY
    const latestRequestId = useRef(0)
    useEffect(() => {
        if(!userData || isDeliveryPartner(userData)){
            return undefined
        }
        if(hasManualCity){
            return undefined
        }
        const requestId = ++latestRequestId.current
        let active = true
        const controller = new AbortController()
        dispatch(clearCurrentCitySelection())
        if (typeof navigator === "undefined" || !navigator.geolocation?.getCurrentPosition) {
            return () => {
                active = false
                controller.abort()
            }
        }
        navigator.geolocation.getCurrentPosition(async (position) => {
            const latitude = position.coords.latitude
            const longitude = position.coords.longitude
            const accuracy = position.coords.accuracy
            if (!active || requestId !== latestRequestId.current) {
                return
            }
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                if (active && requestId === latestRequestId.current) {
                    dispatch(clearCurrentCitySelection())
                }
                return
            }
            if (!isCustomerCityAccuracyAcceptable(accuracy, MAX_CITY_ACCURACY_METERS)) {
                if (active && requestId === latestRequestId.current) {
                    dispatch(clearCurrentCitySelection())
                }
                return
            }
            dispatch(setLocation({ lat: latitude, lon: longitude }))
            try {
                const result = await axios.get(`https://api.geoapify.com/v1/geocode/reverse?lat=${latitude}&lon=${longitude}&format=json&apiKey=${apiKey}`, {
                    signal: controller.signal
                })
                if (!active || requestId !== latestRequestId.current) {
                    return
                }
                const place = result?.data?.results?.[0]
                const cityToDispatch = place?.city || place?.county || null
                if (!cityToDispatch) {
                    dispatch(clearCurrentCitySelection())
                    return
                }
                dispatch(setCurrentCity(cityToDispatch))
                dispatch(setCurrentState(place?.state || null))
                dispatch(setCurrentAddress(place?.address_line2 || place?.address_line1 || null))
                dispatch(setAddress(place?.address_line2 || place?.address_line1 || null))
                dispatch(setCurrentCitySource("gps"))
            } catch {
                if (controller.signal.aborted || !active || requestId !== latestRequestId.current) {
                    return
                }
                dispatch(clearCurrentCitySelection())
            }
        }, () => {
            if (active && requestId === latestRequestId.current) {
                dispatch(clearCurrentCitySelection())
            }
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
        return () => {
            active = false
            controller.abort()
        }
    }, [apiKey, dispatch, hasManualCity, userData])
}

export default useGetCity