import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
    MIN_LOCATION_INTERVAL_MS,
    MIN_DISTANCE_METERS,
    MAX_LOCATION_INTERVAL_MS,
    DEFAULT_LOCATION_UPDATE_INTERVAL_MS,
    MIN_LOCATION_UPDATE_INTERVAL_MS,
    MAX_LOCATION_UPDATE_INTERVAL_MS,
    DEFAULT_MAX_LOCATION_ACCURACY_METERS,
    MAX_LOCATION_SPEED_METERS_PER_SECOND,
    DELIVERY_GEOLOCATION_OPTIONS,
    DELIVERY_LOCATION_STATUS,
    DELIVERY_LOCATION_STATUS_MESSAGES,
    isDeliveryPartner,
    haversineDistanceMeters,
    shouldPublishLocation,
    toValidCoordinates,
    resolveLocationUpdateIntervalMs,
    resolveLocationMaxAccuracyMeters,
    evaluateLocationFix
} from "../../frontend/src/utils/locationTracking.js"
import userReducer, {
    setDeliveryBoyLocation,
    setDeliveryBoyTrackingStatus
} from "../../frontend/src/redux/userSlice.js"
import {
    getSharedSocket,
    setSharedSocket,
    clearSharedSocket,
    subscribeToSharedSocket
} from "../../frontend/src/utils/socketManager.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const readFrontend = (relativePath) =>
    readFileSync(path.resolve(here, "../../frontend/src", relativePath), "utf8")

describe("delivery location tracking policy", () => {
    test("only authenticated delivery partners are eligible for live tracking", () => {
        assert.strictEqual(isDeliveryPartner({ _id: "u1", role: "deliveryBoy" }), true)
        assert.strictEqual(isDeliveryPartner({ _id: "u2", role: "user" }), false)
        assert.strictEqual(isDeliveryPartner({ _id: "u3", role: "owner" }), false)
        assert.strictEqual(isDeliveryPartner({ role: "deliveryBoy" }), false)
        assert.strictEqual(isDeliveryPartner(null), false)
    })

    test("distance uses metres on the earth's surface", () => {
        const pune = { lat: 18.5204, lon: 73.8567 }
        const same = haversineDistanceMeters(pune, pune)
        assert.ok(same < 1e-6)

        const hundredMetresNorth = haversineDistanceMeters(pune, { lat: 18.5213, lon: 73.8567 })
        assert.ok(hundredMetresNorth > 90 && hundredMetresNorth < 110)
    })

    test("the first valid position publishes and invalid coordinates never do", () => {
        const now = 1_000_000
        assert.strictEqual(shouldPublishLocation(null, { lat: 18.5, lon: 73.8 }, now), true)
        assert.strictEqual(shouldPublishLocation(null, { lat: Number.NaN, lon: 73.8 }, now), false)
        assert.strictEqual(shouldPublishLocation(null, { lat: 18.5, lon: undefined }, now), false)
        assert.strictEqual(shouldPublishLocation(null, null, now), false)
    })

    test("updates are suppressed inside the interval and when the rider barely moves", () => {
        const previous = { lat: 18.5, lon: 73.8, at: 1_000_000 }

        assert.strictEqual(
            shouldPublishLocation(previous, { lat: 18.6, lon: 73.9 }, previous.at + MIN_LOCATION_INTERVAL_MS - 1),
            false
        )

        const moved = shouldPublishLocation(
            previous,
            { lat: 18.50001, lon: 73.8 },
            previous.at + MIN_LOCATION_INTERVAL_MS
        )
        assert.strictEqual(moved, false, `a move below ${MIN_DISTANCE_METERS}m must not publish`)

        const farEnough = shouldPublishLocation(
            previous,
            { lat: 18.501, lon: 73.8 },
            previous.at + MIN_LOCATION_INTERVAL_MS
        )
        assert.strictEqual(farEnough, true)
    })

    test("a stale position publishes on the maximum interval even without movement", () => {
        const previous = { lat: 18.5, lon: 73.8, at: 1_000_000 }
        assert.strictEqual(
            shouldPublishLocation(previous, { lat: 18.5, lon: 73.8 }, previous.at + MAX_LOCATION_INTERVAL_MS),
            true
        )
    })
})

describe("automatic delivery location policy", () => {
    test("the default update interval is 12 seconds and stays inside 10-15 seconds", () => {
        assert.strictEqual(DEFAULT_LOCATION_UPDATE_INTERVAL_MS, 12000)
        assert.strictEqual(MIN_LOCATION_UPDATE_INTERVAL_MS, 10000)
        assert.strictEqual(MAX_LOCATION_UPDATE_INTERVAL_MS, 15000)
        assert.strictEqual(resolveLocationUpdateIntervalMs(undefined), 12000)
        assert.strictEqual(resolveLocationUpdateIntervalMs(""), 12000)
        assert.strictEqual(resolveLocationUpdateIntervalMs("garbage"), 12000)
        assert.strictEqual(resolveLocationUpdateIntervalMs(5000), 10000)
        assert.strictEqual(resolveLocationUpdateIntervalMs("11000"), 11000)
        assert.strictEqual(resolveLocationUpdateIntervalMs(20000), 15000)
    })

    test("latitude and longitude validation rejects non-finite, non-numeric, and out-of-range values", () => {
        assert.deepStrictEqual(toValidCoordinates(18.5204, 73.8567), {
            latitude: 18.5204,
            longitude: 73.8567
        })
        assert.deepStrictEqual(toValidCoordinates(-90, 180), { latitude: -90, longitude: 180 })
        assert.deepStrictEqual(toValidCoordinates(90, -180), { latitude: 90, longitude: -180 })

        for (const [lat, lon] of [
            [undefined, 73.8],
            [18.5, null],
            [Number.NaN, 73.8],
            [18.5, Number.POSITIVE_INFINITY],
            ["18.5", 73.8],
            [90.0001, 73.8],
            [18.5, 180.0001],
            [null, null]
        ]) {
            assert.strictEqual(toValidCoordinates(lat, lon), null, `${lat},${lon} must be rejected`)
        }
    })

    test("geolocation options request high accuracy with bounded age and timeout", () => {
        assert.deepStrictEqual(DELIVERY_GEOLOCATION_OPTIONS, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 10000
        })
    })

    test("all dashboard statuses have user-facing messages", () => {
        for (const status of Object.values(DELIVERY_LOCATION_STATUS)) {
            assert.strictEqual(typeof DELIVERY_LOCATION_STATUS_MESSAGES[status], "string")
            assert.ok(DELIVERY_LOCATION_STATUS_MESSAGES[status].length > 0)
        }
    })

    test("the location Redux action contains serializable location data only", () => {
        const payload = {
            lat: 20.179788,
            lon: 76.718966,
            accuracy: 41,
            timestamp: 1_000_000,
            updatedAt: "2026-11-04T10:00:00.000Z"
        }
        const state = userReducer(undefined, setDeliveryBoyLocation(payload))
        assert.deepStrictEqual(state.deliveryBoyLocation, payload)
        assert.doesNotThrow(() => JSON.stringify(state.deliveryBoyLocation))
        assert.strictEqual(state.deliveryBoyTrackingStatus, null)

        const withStatus = userReducer(state, setDeliveryBoyTrackingStatus(DELIVERY_LOCATION_STATUS.ACTIVE))
        assert.strictEqual(withStatus.deliveryBoyTrackingStatus, DELIVERY_LOCATION_STATUS.ACTIVE)
    })

    test("the Redux user state never contains a Socket.IO instance", () => {
        const state = userReducer(undefined, { type: "@@INIT" })
        assert.ok(!Object.prototype.hasOwnProperty.call(state, "socket"))
        assert.strictEqual(state.deliveryBoyLocation, null)
        assert.strictEqual(state.deliveryBoyTrackingStatus, null)
    })

    test("the shared socket store notifies consumers and ignores stale clears", () => {
        const first = { id: "first" }
        const second = { id: "second" }
        let notifications = 0
        const unsubscribe = subscribeToSharedSocket(() => {
            notifications += 1
        })

        clearSharedSocket()
        assert.strictEqual(getSharedSocket(), null)

        setSharedSocket(first)
        assert.strictEqual(getSharedSocket(), first)
        assert.strictEqual(notifications, 1)

        clearSharedSocket(second)
        assert.strictEqual(getSharedSocket(), first)
        assert.strictEqual(notifications, 1)

        setSharedSocket(second)
        assert.strictEqual(getSharedSocket(), second)
        assert.strictEqual(notifications, 2)

        clearSharedSocket(second)
        assert.strictEqual(getSharedSocket(), null)
        assert.strictEqual(notifications, 3)

        unsubscribe()
        setSharedSocket(first)
        assert.strictEqual(notifications, 3)
        clearSharedSocket(first)
    })
})

describe("GPS quality acceptance", () => {
    const dongaonFix = {
        lat: 20.179788,
        lon: 76.718966,
        accuracy: 41,
        timestamp: 1_000_000
    }
    const puneFix = {
        lat: 18.6519,
        lon: 73.7971,
        accuracy: 20,
        timestamp: dongaonFix.timestamp + 12000
    }

    test("accuracy and speed thresholds are defined and accuracy is configurable", () => {
        assert.strictEqual(DEFAULT_MAX_LOCATION_ACCURACY_METERS, 150)
        assert.strictEqual(MAX_LOCATION_SPEED_METERS_PER_SECOND, 55)
        assert.strictEqual(resolveLocationMaxAccuracyMeters(undefined), 150)
        assert.strictEqual(resolveLocationMaxAccuracyMeters(""), 150)
        assert.strictEqual(resolveLocationMaxAccuracyMeters("garbage"), 150)
        assert.strictEqual(resolveLocationMaxAccuracyMeters(0), 150)
        assert.strictEqual(resolveLocationMaxAccuracyMeters("80"), 80)
    })

    test("a valid Dongaon GPS position is accepted with its quality metadata", () => {
        const decision = evaluateLocationFix(dongaonFix, null)

        assert.strictEqual(decision.accepted, true)
        assert.strictEqual(decision.reason, null)
        assert.deepStrictEqual(decision.position, dongaonFix)
    })

    test("a sudden Pune GPS position is rejected as an impossible jump", () => {
        const decision = evaluateLocationFix(puneFix, dongaonFix)

        assert.strictEqual(decision.accepted, false)
        assert.strictEqual(decision.reason, "impossible-jump")
        assert.strictEqual(decision.position, dongaonFix)
    })

    test("poor accuracy fixes are rejected and the threshold is configurable", () => {
        const poorDongaonFix = {
            ...dongaonFix,
            accuracy: DEFAULT_MAX_LOCATION_ACCURACY_METERS + 1,
            timestamp: dongaonFix.timestamp + 12000
        }
        const rejected = evaluateLocationFix(poorDongaonFix, dongaonFix)
        assert.strictEqual(rejected.accepted, false)
        assert.strictEqual(rejected.reason, "poor-accuracy")
        assert.strictEqual(rejected.position, dongaonFix)

        const strict = evaluateLocationFix(
            { ...dongaonFix, accuracy: 50 },
            null,
            { maxAccuracyMeters: 25 }
        )
        assert.strictEqual(strict.accepted, false)
        assert.strictEqual(strict.reason, "poor-accuracy")

        const relaxed = evaluateLocationFix(
            { ...dongaonFix, accuracy: 50 },
            null,
            { maxAccuracyMeters: 60 }
        )
        assert.strictEqual(relaxed.accepted, true)
    })

    test("older or equal source timestamps are rejected and the last fix is retained", () => {
        let latest = evaluateLocationFix(dongaonFix, null).position

        for (const timestamp of [dongaonFix.timestamp - 1, dongaonFix.timestamp]) {
            const rejected = evaluateLocationFix(
                { ...dongaonFix, lat: 20.18, timestamp },
                latest
            )
            assert.strictEqual(rejected.accepted, false)
            assert.strictEqual(rejected.reason, "stale-or-out-of-order")
            assert.strictEqual(rejected.position, latest)
            latest = rejected.position
        }

        assert.deepStrictEqual(latest, dongaonFix)
    })

    test("plausible movement after the source timestamp gap is accepted", () => {
        const nearby = {
            ...dongaonFix,
            lat: dongaonFix.lat + 0.0002,
            timestamp: dongaonFix.timestamp + 12000
        }
        const decision = evaluateLocationFix(nearby, dongaonFix)
        assert.strictEqual(decision.accepted, true)
    })

    test("accepted coordinates preserve the existing customer payload shape", () => {
        const decision = evaluateLocationFix(dongaonFix, null)
        assert.deepStrictEqual(
            { latitude: decision.position.lat, longitude: decision.position.lon },
            { latitude: dongaonFix.lat, longitude: dongaonFix.lon }
        )
    })
})

describe("delivery location privacy wiring", () => {
    const hookSource = readFrontend("hooks/useUpdateLocation.jsx")

    test("the app-level hook is delivery-partner gated and owns exactly one watcher", () => {
        assert.match(hookSource, /isDeliveryPartner\(userData\)/)
        assert.strictEqual((hookSource.match(/watchPosition\(/g) || []).length, 1)
        assert.strictEqual((hookSource.match(/setInterval\(/g) || []).length, 1)
        assert.match(hookSource, /clearWatch\(/)
        assert.match(hookSource, /clearInterval\(/)
        assert.match(hookSource, /DELIVERY_GEOLOCATION_OPTIONS/)
        assert.ok(!hookSource.includes("console.log"), "location payloads must never be logged")
    })

    test("location updates use the existing Socket.IO event and emit the latest coordinates", () => {
        assert.match(hookSource, /currentSocket\.emit\(['"]updateLocation['"]/)
        assert.match(hookSource, /latitude:\s*latest\.lat/)
        assert.match(hookSource, /longitude:\s*latest\.lon/)
        assert.match(hookSource, /getSharedSocket\(\)/)
        assert.match(hookSource, /subscribeToSharedSocket\(/)
        assert.ok(!hookSource.includes("axios"), "socket tracking must not add redundant REST calls")
        assert.ok(!hookSource.includes("/api/user/update-location"))
        assert.ok(!hookSource.includes("removeAllListeners"))
    })

    test("socket connect and disconnect listeners are bound and removed specifically", () => {
        assert.match(hookSource, /currentSocket\.on\(['"]connect['"],\s*handleConnect\)/)
        assert.match(hookSource, /currentSocket\.off\(['"]connect['"],\s*handleConnect\)/)
        assert.match(hookSource, /currentSocket\.on\(['"]disconnect['"],\s*handleDisconnect\)/)
        assert.match(hookSource, /currentSocket\.off\(['"]disconnect['"],\s*handleDisconnect\)/)
        assert.match(hookSource, /if\s*\(latest\)\s*\{\s*publishLatest\(\)/)
    })

    test("rejected fixes never write location state or emit socket events", () => {
        assert.match(hookSource, /evaluateLocationFix\(/)
        assert.match(hookSource, /accuracy:\s*position\?\.coords\?\.accuracy/)
        assert.match(hookSource, /timestamp:\s*position\?\.timestamp/)
        assert.match(hookSource, /MAX_LOCATION_ACCURACY_METERS/)
        assert.match(hookSource, /latest\s*=\s*\{\s*\.\.\.decision\.position/)

        const rejectionStart = hookSource.indexOf("if (!decision.accepted)")
        const rejectionEnd = hookSource.indexOf("if (firstPublishPending)", rejectionStart)
        assert.ok(rejectionStart >= 0)
        assert.ok(rejectionEnd > rejectionStart)
        const rejectionBlock = hookSource.slice(rejectionStart, rejectionEnd)
        assert.match(rejectionBlock, /return/)
        assert.ok(!rejectionBlock.includes("dispatch("))
        assert.ok(!rejectionBlock.includes("setDeliveryBoyLocation"))
        assert.ok(!rejectionBlock.includes(".emit("))
    })

    test("reconnect publishes only the retained accepted position", () => {
        assert.match(hookSource, /let latest = null/)
        assert.match(hookSource, /if\s*\(!active \|\| stopped \|\| !latest\)/)
        assert.match(hookSource, /latest\s*=\s*\{\s*\.\.\.decision\.position/)
        assert.match(hookSource, /if\s*\(latest\)\s*\{\s*publishLatest\(\)/)

        const trackingSource = readFrontend("utils/locationTracking.js")
        for (const coordinate of ["20.179788", "76.718966", "18.6519", "73.7971"]) {
            assert.ok(!hookSource.includes(coordinate), "the hook must not inject fallback coordinates")
            assert.ok(!trackingSource.includes(coordinate), "the policy must not inject fallback coordinates")
        }
    })

    test("permission denial stops acquisition while transient errors preserve tracking", () => {
        assert.match(hookSource, /error\?\.code === 1/)
        assert.match(hookSource, /stopAcquisition\(\)/)
        assert.match(hookSource, /DELIVERY_LOCATION_STATUS\.PERMISSION_DENIED/)
        assert.match(hookSource, /DELIVERY_LOCATION_STATUS\.FAILED/)
        assert.match(hookSource, /DELIVERY_LOCATION_STATUS\.SOCKET_DISCONNECTED/)
    })

    test("the rider dashboard no longer starts a second geolocation watcher", () => {
        const riderSource = readFrontend("components/DeliveryBoy.jsx")
        assert.ok(!riderSource.includes("watchPosition"), "only the app-level hook may watch geolocation")
        assert.match(riderSource, /deliveryBoyLocation,deliveryBoyTrackingStatus\}=useSelector/)
        assert.match(riderSource, /DELIVERY_LOCATION_STATUS_MESSAGES/)
    })

    test("socket consumers read the shared module instead of Redux", () => {
        for (const file of ["components/DeliveryBoy.jsx", "pages/MyOrders.jsx", "pages/TrackOrderPage.jsx"]) {
            const source = readFrontend(file)
            assert.match(source, /import useSocket from '\.\.\/hooks\/useSocket'/, `${file} must use the shared socket hook`)
            assert.match(source, /useSocket\(\)/, `${file} must read the shared socket instance`)
        }
        const manager = readFrontend("utils/socketManager.js")
        assert.match(manager, /setSharedSocket/)
        assert.match(manager, /clearSharedSocket/)
        assert.match(manager, /subscribeToSharedSocket/)
        const hook = readFrontend("hooks/useSocket.js")
        assert.match(hook, /useSyncExternalStore/)
    })

    test("checkout uses the browser position and falls back to a valid map location", () => {
        const checkoutSource = readFrontend("pages/CheckOut.jsx")
        assert.match(checkoutSource, /navigator\.geolocation\.getCurrentPosition/)
        assert.match(checkoutSource, /enableHighAccuracy:\s*true/)
        assert.match(checkoutSource, /const hasCoordinates =/)
        assert.match(checkoutSource, /hasCoordinates\(location\)/)
        assert.ok(!checkoutSource.includes("userData?.location"))
    })

    test("delivery sessions do not start an independent city GPS lookup", () => {
        const citySource = readFrontend("hooks/useGetCity.jsx")
        const guardIndex = citySource.indexOf("if(!userData || isDeliveryPartner(userData))")
        const acquisitionIndex = citySource.indexOf("navigator.geolocation.getCurrentPosition")

        assert.ok(guardIndex >= 0)
        assert.ok(acquisitionIndex > guardIndex)
        assert.match(citySource, /import \{ isDeliveryPartner \}/)
    })

    test("city hooks skip empty cities and encode the city path segment", () => {
        for (const hook of ["useGetShopByCity.jsx", "useGetItemsByCity.jsx"]) {
            const source = readFrontend(`hooks/${hook}`)
            assert.match(source, /if\(!currentCity\)/, `${hook} must not request without a city`)
            assert.match(source, /encodeURIComponent\(currentCity\)/, `${hook} must encode the city`)
        }
    })

    test("owners no longer receive rider identity or location in status responses", () => {
        const ownerCardSource = readFrontend("components/OwnerOrderCard.jsx")
        assert.ok(!ownerCardSource.includes("availableBoys"))
        const assignmentSource = readFrontend("components/DeliveryBoy.jsx")
        assert.ok(!assignmentSource.includes("a?.deliveryAddress"), "pre-acceptance assignments must not show addresses")
        assert.ok(!assignmentSource.includes("a?.items"), "pre-acceptance assignments must not expose items")
    })
})
