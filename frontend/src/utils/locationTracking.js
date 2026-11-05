export const DELIVERY_PARTNER_ROLE = "deliveryBoy"

export const MIN_LOCATION_INTERVAL_MS = 15000
export const MIN_DISTANCE_METERS = 25
export const MAX_LOCATION_INTERVAL_MS = 60000

export const DEFAULT_LOCATION_UPDATE_INTERVAL_MS = 12000
export const MIN_LOCATION_UPDATE_INTERVAL_MS = 10000
export const MAX_LOCATION_UPDATE_INTERVAL_MS = 15000

export const DEFAULT_MAX_LOCATION_ACCURACY_METERS = 150
export const MAX_LOCATION_SPEED_METERS_PER_SECOND = 55

export const DELIVERY_GEOLOCATION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 10000
})

export const DELIVERY_LOCATION_STATUS = Object.freeze({
    REQUESTING: "requesting",
    WAITING: "waiting",
    ACTIVE: "active",
    PERMISSION_DENIED: "permission-denied",
    UNAVAILABLE: "unavailable",
    SOCKET_DISCONNECTED: "socket-disconnected",
    FAILED: "failed"
})

export const DELIVERY_LOCATION_STATUS_MESSAGES = Object.freeze({
    [DELIVERY_LOCATION_STATUS.REQUESTING]: "Requesting your current location...",
    [DELIVERY_LOCATION_STATUS.WAITING]: "Waiting for a valid GPS location...",
    [DELIVERY_LOCATION_STATUS.ACTIVE]: "Location tracking active.",
    [DELIVERY_LOCATION_STATUS.PERMISSION_DENIED]: "Location permission is required. Enable it in your browser settings and reload the dashboard.",
    [DELIVERY_LOCATION_STATUS.UNAVAILABLE]: "Location tracking is unavailable in this browser.",
    [DELIVERY_LOCATION_STATUS.SOCKET_DISCONNECTED]: "Live connection lost. Your latest location will be sent when it reconnects.",
    [DELIVERY_LOCATION_STATUS.FAILED]: "Unable to refresh GPS right now. Retrying automatically."
})

export const isValidLatitude = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90

export const isValidLongitude = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180

export const toValidCoordinates = (latitude, longitude) => {
    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
        return null
    }
    return { latitude, longitude }
}

export const resolveLocationUpdateIntervalMs = (value) => {
    const parsed = Number(value)
    if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) {
        return DEFAULT_LOCATION_UPDATE_INTERVAL_MS
    }
    return Math.min(
        MAX_LOCATION_UPDATE_INTERVAL_MS,
        Math.max(MIN_LOCATION_UPDATE_INTERVAL_MS, Math.round(parsed))
    )
}

export const resolveLocationMaxAccuracyMeters = (value) => {
    const parsed = Number(value)
    if (
        value === null ||
        value === undefined ||
        value === "" ||
        !Number.isFinite(parsed) ||
        parsed <= 0
    ) {
        return DEFAULT_MAX_LOCATION_ACCURACY_METERS
    }
    return parsed
}

const toRadians = (value) => (value * Math.PI) / 180

export const isDeliveryPartner = (user) =>
    Boolean(user && user._id && user.role === DELIVERY_PARTNER_ROLE)

export const haversineDistanceMeters = (from, to) => {
    if (!from || !to) {
        return Infinity
    }
    const earthRadiusMeters = 6371000
    const latDelta = toRadians(to.lat - from.lat)
    const lonDelta = toRadians(to.lon - from.lon)
    const fromLat = toRadians(from.lat)
    const toLat = toRadians(to.lat)
    const a =
        Math.sin(latDelta / 2) ** 2 +
        Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lonDelta / 2) ** 2
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export const evaluateLocationFix = (next, previous, options = {}) => {
    const reject = (reason) => ({
        accepted: false,
        reason,
        position: previous || null
    })

    if (!next) {
        return reject("missing-position")
    }

    const coordinates = toValidCoordinates(next.lat, next.lon)
    if (!coordinates) {
        return reject("invalid-coordinates")
    }

    if (
        typeof next.accuracy !== "number" ||
        !Number.isFinite(next.accuracy) ||
        next.accuracy < 0
    ) {
        return reject("invalid-accuracy")
    }

    const maxAccuracyMeters =
        options.maxAccuracyMeters ?? DEFAULT_MAX_LOCATION_ACCURACY_METERS
    if (next.accuracy > maxAccuracyMeters) {
        return reject("poor-accuracy")
    }

    if (
        typeof next.timestamp !== "number" ||
        !Number.isFinite(next.timestamp) ||
        next.timestamp <= 0
    ) {
        return reject("invalid-timestamp")
    }

    const position = {
        lat: coordinates.latitude,
        lon: coordinates.longitude,
        accuracy: next.accuracy,
        timestamp: next.timestamp
    }

    if (!previous) {
        return { accepted: true, reason: null, position }
    }

    if (previous.timestamp >= position.timestamp) {
        return reject("stale-or-out-of-order")
    }

    const elapsedSeconds = (position.timestamp - previous.timestamp) / 1000
    const distanceMeters = haversineDistanceMeters(previous, position)
    const maxSpeedMetersPerSecond =
        options.maxSpeedMetersPerSecond ?? MAX_LOCATION_SPEED_METERS_PER_SECOND
    if (
        !Number.isFinite(distanceMeters) ||
        distanceMeters > maxSpeedMetersPerSecond * elapsedSeconds
    ) {
        return reject("impossible-jump")
    }

    return { accepted: true, reason: null, position }
}

export const shouldPublishLocation = (previous, next, now, options = {}) => {
    if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) {
        return false
    }
    if (!previous) {
        return true
    }
    const minInterval = options.minIntervalMs ?? MIN_LOCATION_INTERVAL_MS
    const minDistance = options.minDistanceMeters ?? MIN_DISTANCE_METERS
    const maxInterval = options.maxIntervalMs ?? MAX_LOCATION_INTERVAL_MS
    const elapsed = now - previous.at
    if (!Number.isFinite(elapsed) || elapsed < minInterval) {
        return false
    }
    if (elapsed >= maxInterval) {
        return true
    }
    return haversineDistanceMeters(previous, next) >= minDistance
}
