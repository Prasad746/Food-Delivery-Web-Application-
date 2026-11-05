import { useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
    DELIVERY_GEOLOCATION_OPTIONS,
    DELIVERY_LOCATION_STATUS,
    evaluateLocationFix,
    isDeliveryPartner,
    resolveLocationMaxAccuracyMeters,
    resolveLocationUpdateIntervalMs
} from '../utils/locationTracking'
import { getSharedSocket, subscribeToSharedSocket } from '../utils/socketManager'
import { setDeliveryBoyLocation, setDeliveryBoyTrackingStatus } from '../redux/userSlice'

const configuredInterval = import.meta.env.VITE_LOCATION_UPDATE_INTERVAL_MS
const configuredMaxAccuracy = import.meta.env.VITE_LOCATION_MAX_ACCURACY_METERS
const LOCATION_UPDATE_INTERVAL_MS = resolveLocationUpdateIntervalMs(configuredInterval)
const MAX_LOCATION_ACCURACY_METERS = resolveLocationMaxAccuracyMeters(configuredMaxAccuracy)

function useUpdateLocation() {
    const dispatch = useDispatch()
    const { userData } = useSelector(state => state.user)
    const userId = userData?._id
    const eligible = isDeliveryPartner(userData)

    useEffect(() => {
        if (!eligible || !userId) {
            dispatch(setDeliveryBoyTrackingStatus(null))
            return undefined
        }

        if (typeof navigator === 'undefined' || !navigator.geolocation?.watchPosition) {
            dispatch(setDeliveryBoyTrackingStatus(DELIVERY_LOCATION_STATUS.UNAVAILABLE))
            return undefined
        }

        let active = true
        let stopped = false
        let watchId = null
        let intervalId = null
        let latest = null
        let firstPublishPending = true
        let lastStatus = null
        let currentSocket = null

        const reportStatus = (status) => {
            if (lastStatus === status) {
                return
            }
            lastStatus = status
            dispatch(setDeliveryBoyTrackingStatus(status))
        }

        const publishLatest = () => {
            if (!active || stopped || !latest) {
                return false
            }

            dispatch(setDeliveryBoyLocation(latest))

            if (!currentSocket || !currentSocket.connected) {
                reportStatus(DELIVERY_LOCATION_STATUS.SOCKET_DISCONNECTED)
                return false
            }

            currentSocket.emit('updateLocation', {
                latitude: latest.lat,
                longitude: latest.lon
            })
            reportStatus(DELIVERY_LOCATION_STATUS.ACTIVE)
            return true
        }

        const stopAcquisition = () => {
            stopped = true
            if (watchId !== null) {
                try {
                    navigator.geolocation.clearWatch(watchId)
                } catch {
                    // The watcher is already gone in this browser.
                }
                watchId = null
            }
            if (intervalId !== null) {
                clearInterval(intervalId)
                intervalId = null
            }
        }

        const handlePosition = (position) => {
            if (!active || stopped) {
                return
            }

            const decision = evaluateLocationFix(
                {
                    lat: position?.coords?.latitude,
                    lon: position?.coords?.longitude,
                    accuracy: position?.coords?.accuracy,
                    timestamp: position?.timestamp
                },
                latest,
                { maxAccuracyMeters: MAX_LOCATION_ACCURACY_METERS }
            )

            if (!decision.accepted) {
                return
            }

            latest = {
                ...decision.position,
                updatedAt: new Date().toISOString()
            }

            if (firstPublishPending) {
                firstPublishPending = false
                publishLatest()
            }
        }

        const handlePositionError = (error) => {
            if (!active || stopped) {
                return
            }
            if (error?.code === 1) {
                stopAcquisition()
                reportStatus(DELIVERY_LOCATION_STATUS.PERMISSION_DENIED)
                return
            }
            reportStatus(DELIVERY_LOCATION_STATUS.FAILED)
        }

        const handleConnect = () => {
            if (!active || stopped) {
                return
            }
            if (latest) {
                publishLatest()
            } else {
                reportStatus(DELIVERY_LOCATION_STATUS.WAITING)
            }
        }

        const handleDisconnect = () => {
            if (!active || stopped) {
                return
            }
            reportStatus(DELIVERY_LOCATION_STATUS.SOCKET_DISCONNECTED)
        }

        const bindSocket = (nextSocket) => {
            if (currentSocket === nextSocket) {
                return
            }
            if (currentSocket) {
                currentSocket.off('connect', handleConnect)
                currentSocket.off('disconnect', handleDisconnect)
            }
            currentSocket = nextSocket || null
            if (currentSocket) {
                currentSocket.on('connect', handleConnect)
                currentSocket.on('disconnect', handleDisconnect)
                if (currentSocket.connected) {
                    handleConnect()
                }
            }
        }

        reportStatus(DELIVERY_LOCATION_STATUS.REQUESTING)
        bindSocket(getSharedSocket())
        const unsubscribeSocket = subscribeToSharedSocket(() => {
            bindSocket(getSharedSocket())
        })

        try {
            watchId = navigator.geolocation.watchPosition(
                handlePosition,
                handlePositionError,
                DELIVERY_GEOLOCATION_OPTIONS
            )
        } catch {
            reportStatus(DELIVERY_LOCATION_STATUS.UNAVAILABLE)
            if (currentSocket) {
                currentSocket.off('connect', handleConnect)
                currentSocket.off('disconnect', handleDisconnect)
            }
            unsubscribeSocket()
            return undefined
        }

        intervalId = setInterval(publishLatest, LOCATION_UPDATE_INTERVAL_MS)

        return () => {
            active = false
            if (watchId !== null) {
                try {
                    navigator.geolocation.clearWatch(watchId)
                } catch {
                    // The watcher is already gone in this browser.
                }
            }
            if (intervalId !== null) {
                clearInterval(intervalId)
            }
            if (currentSocket) {
                currentSocket.off('connect', handleConnect)
                currentSocket.off('disconnect', handleDisconnect)
            }
            unsubscribeSocket()
        }
    }, [dispatch, eligible, userId])
}

export default useUpdateLocation
