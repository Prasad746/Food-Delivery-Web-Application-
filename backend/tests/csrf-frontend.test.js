import { test, describe, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

globalThis.window = globalThis

const csrfClient = await import("../../frontend/src/utils/csrfClient.js")
const axiosInstanceMod = await import("../../frontend/src/utils/axiosInstance.js")
const { default: userReducer, clearSessionState } = await import("../../frontend/src/redux/userSlice.js")
const { default: ownerReducer, clearOwnerSessionState } = await import("../../frontend/src/redux/ownerSlice.js")
const { default: mapReducer, clearMapSessionState } = await import("../../frontend/src/redux/mapSlice.js")
const api = axiosInstanceMod.default

const beforeEachReset = () => {
    csrfClient.setCsrfToken("")
    globalThis.__fetchCalls = []
    globalThis.fetch = async (url, opts) => {
        globalThis.__fetchCalls.push({ url, opts })
        throw new Error("no fetch stub configured")
    }
}

const stubFetch = (payload, { origin = "trusted", status = 200 } = {}) => {
    globalThis.__fetchCalls = []
    globalThis.fetch = async (url, opts) => {
        globalThis.__fetchCalls.push({ url, opts })
        if (status !== 200) {
            return { ok: false, status, json: async () => ({}) }
        }
        return { ok: true, status, json: async () => payload }
    }
    return globalThis.__fetchCalls
}

const captureAdapter = () => {
    const captured = []
    api.defaults.adapter = (config) => {
        captured.push(config)
        return Promise.resolve({ data: {}, status: 200, statusText: "OK", headers: {}, config })
    }
    return captured
}

const fetchCallCount = () => globalThis.__fetchCalls.length

describe("logout Redux session cleanup", () => {
    test("clearSessionState resets user-specific data and delivery locations without holding a socket", () => {
        const initial = userReducer(undefined, { type: "__noop" })
        const seeded = {
            ...initial,
            userData: { _id: "user-one", role: "deliveryBoy" },
            currentCity: "Pune",
            currentState: "MH",
            currentAddress: "12 stale street",
            shopInMyCity: [{ _id: "shop-one" }],
            itemsInMyCity: [{ _id: "item-one" }],
            cartItems: [{ id: "item-one", price: 120, quantity: 1 }],
            totalAmount: 120,
            myOrders: [{ _id: "order-one" }],
            searchItems: [{ _id: "item-one" }],
            deliveryBoyLocation: { lat: 18.5, lon: 73.8 }
        }

        const cleared = userReducer(seeded, clearSessionState())
        assert.deepStrictEqual(cleared, initial)
        assert.ok(!Object.prototype.hasOwnProperty.call(cleared, "socket"))
    })

    test("clearOwnerSessionState removes owner shop data", () => {
        const initial = ownerReducer(undefined, { type: "__noop" })
        const seeded = { ...initial, myShopData: { _id: "shop-one" } }

        assert.deepStrictEqual(ownerReducer(seeded, clearOwnerSessionState()), initial)
    })

    test("clearMapSessionState removes the selected map coordinates and address", () => {
        const initial = mapReducer(undefined, { type: "__noop" })
        const seeded = {
            ...initial,
            location: { lat: 18.5, lon: 73.8 },
            address: "12 stale heading"
        }

        assert.deepStrictEqual(mapReducer(seeded, clearMapSessionState()), initial)
    })
})

describe("CSRF client bootstrap (App.jsx useEffect path)", () => {
    beforeEach(beforeEachReset)

    test("bootstrapCsrfToken stores the csrfToken in window.__VINGO_CSRF_TOKEN", async () => {
        const calls = stubFetch({ csrfToken: "boot-token-123" })
        const token = await csrfClient.bootstrapCsrfToken()

        assert.strictEqual(token, "boot-token-123")
        assert.strictEqual(csrfClient.getCsrfToken(), "boot-token-123")
        assert.strictEqual(window.__VINGO_CSRF_TOKEN, "boot-token-123")
        assert.strictEqual(calls.length, 1)
        assert.ok(calls[0].url.endsWith("/api/csrf-token"))
        assert.strictEqual(calls[0].opts.credentials, "include")
    })

    test("bootstrap failure throws with the failing status and leaves the window token empty", async () => {
        stubFetch({}, { status: 503 })
        await assert.rejects(() => csrfClient.bootstrapCsrfToken(), /status 503/)
        assert.strictEqual(csrfClient.getCsrfToken(), "")
    })
})

describe("Shared axios instance token availability", () => {
    beforeEach(beforeEachReset)

    test("pre-login state-changing request bootstraps the token first, then attaches X-XSRF-TOKEN", async () => {
        const calls = stubFetch({ csrfToken: "auto-minted-token" })
        const captured = captureAdapter()

        await api.post(`${api.defaults.baseURL}/api/auth/signin`, { email: "e@example.com", password: "x" })

        assert.strictEqual(captured.length, 1)
        assert.strictEqual(captured[0].headers["X-XSRF-TOKEN"], "auto-minted-token")
        assert.strictEqual(calls.length, 1)
        assert.ok(calls[0].url.endsWith("/api/csrf-token"))
    })

    test("POST auto-attaches X-XSRF-TOKEN when the token is already present (send-delivery-otp)", async () => {
        csrfClient.setCsrfToken("existing-token")
        const captured = captureAdapter()
        const callsBefore = fetchCallCount()

        await api.post(`${api.defaults.baseURL}/api/order/send-delivery-otp`, { orderId: "ord123" })

        assert.strictEqual(captured[0].headers["X-XSRF-TOKEN"], "existing-token")
        assert.strictEqual(fetchCallCount(), callsBefore)
    })

    test("POST auto-attaches X-XSRF-TOKEN when the token is already present (verify-delivery-otp)", async () => {
        csrfClient.setCsrfToken("existing-token")
        const captured = captureAdapter()
        const callsBefore = fetchCallCount()

        await api.post(`${api.defaults.baseURL}/api/order/verify-delivery-otp`, { orderId: "ord123", otp: "1234" })

        assert.strictEqual(captured[0].headers["X-XSRF-TOKEN"], "existing-token")
        assert.strictEqual(fetchCallCount(), callsBefore)
    })

    test("untrusted third-party POSTs and GETs receive no CSRF header", async () => {
        csrfClient.setCsrfToken("existing-token")
        const captured = captureAdapter()

        await api.post("https://api.geoapify.com/v2/places", {})
        await api.get(`${api.defaults.baseURL}/api/order/my-orders`)

        const geoConfig = captured.find(c => c.url.startsWith("https://api.geoapify.com"))
        const getConfig = captured.find(c => c.method === "get")
        assert.ok(geoConfig, "geoapify request captured")
        assert.ok(getConfig, "GET request captured")
        assert.strictEqual(geoConfig.headers["X-XSRF-TOKEN"], undefined)
        assert.strictEqual(getConfig.headers["X-XSRF-TOKEN"], undefined)
    })
})

describe("DeliveryBoy uses the shared CSRF-enabled instance", () => {
    test("DeliveryBoy.jsx imports the shared instance and its two POSTs target the CSRF-protected order routes", () => {
        const source = readFileSync(
            path.resolve(here, "../../frontend/src/components/DeliveryBoy.jsx"),
            "utf8"
        )
        assert.match(source, /import axios from ['"]\.\.\/utils\/axiosInstance['"]/)
        assert.ok(!/(^|\n)\s*import axios from ['"]axios['"]/.test(source), "DeliveryBoy must not import plain axios")
        assert.ok(source.includes("/api/order/send-delivery-otp"))
        assert.ok(source.includes("/api/order/verify-delivery-otp"))
    })

    test("DeliveryBoy.jsx calls accept-order as POST through the shared instance", () => {
        const source = readFileSync(
            path.resolve(here, "../../frontend/src/components/DeliveryBoy.jsx"),
            "utf8"
        )
        assert.match(
            source,
            /axios\.post\(`\$\{serverUrl\}\/api\/order\/accept-order\/\$\{assignmentId\}`/,
            "accept-order must be a POST"
        )
        assert.ok(
            !source.includes("axios.get(`${serverUrl}/api/order/accept-order"),
            "accept-order must not be called with GET"
        )
    })
})

describe("Nav logout uses the shared CSRF-enabled instance", () => {
    const navSource = readFileSync(
        path.resolve(here, "../../frontend/src/components/Nav.jsx"),
        "utf8"
    )

    test("Nav.jsx posts to the logout endpoint through the shared instance", () => {
        assert.match(navSource, /import axios from ['"]\.\.\/utils\/axiosInstance['"]/)
        assert.ok(!/(^|\n)\s*import axios from ['"]axios['"]/.test(navSource), "Nav must not import plain axios")
        assert.match(
            navSource,
            /axios\.post\(`\$\{serverUrl\}\/api\/auth\/signout`,\s*\{\},\s*\{ withCredentials: true \}\)/,
            "logout must be a credentialed POST"
        )
        assert.ok(
            !navSource.includes("axios.get(`${serverUrl}/api/auth/signout"),
            "logout must not be called with GET"
        )
    })

    test("Nav.jsx clears the old CSRF token and re-bootstraps after logout", () => {
        assert.match(navSource, /window\.__VINGO_CSRF_TOKEN = ""/)
        assert.match(navSource, /bootstrapCsrfToken\(\)/)
    })

    test("Nav.jsx clears user, owner, and map session state even when logout request fails", () => {
        assert.match(navSource, /const \{ userData,\s*currentCity\s*,cartItems\}\s*=\s*useSelector/)
        assert.ok(!navSource.includes("socket"), "Nav must not read or disconnect the shared socket")
        assert.match(navSource, /clearSessionState\(\)/)
        assert.match(navSource, /clearOwnerSessionState\(\)/)
        assert.match(navSource, /clearMapSessionState\(\)/)
        const finallyBlock = navSource.match(/finally\s*\{([\s\S]*?)\}/)
        assert.ok(finallyBlock, "logout cleanup must run in finally")
        assert.match(finallyBlock[1], /clearLocalSession\(\)/)
    })
})

describe("CheckOut uses the shared CSRF-enabled instance and a defined serverUrl", () => {
    const checkoutSource = readFileSync(
        path.resolve(here, "../../frontend/src/pages/CheckOut.jsx"),
        "utf8"
    )

    test("CheckOut.jsx imports serverUrl from csrfClient and axios from the shared instance", () => {
        assert.strictEqual(typeof csrfClient.serverUrl, "string", "csrfClient must export serverUrl")
        assert.match(
            checkoutSource,
            /import\s+\{\s*serverUrl\s*\}\s+from\s+['"]\.\.\/utils\/csrfClient(?:\.js)?['"]/,
            "CheckOut must import serverUrl from the csrfClient module"
        )
        assert.match(checkoutSource, /import axios from ['"]\.\.\/utils\/axiosInstance['"]/)
        assert.ok(
            !/(^|\n)\s*import axios from ['"]axios['"]/.test(checkoutSource),
            "CheckOut must not import plain axios"
        )
    })

    test("Checkout state-changing requests use the shared instance and defined serverUrl", () => {
        assert.match(
            checkoutSource,
            /axios\.post\(`\$\{serverUrl\}\/api\/order\/place-order`/,
            "place-order must be a POST to serverUrl"
        )
        assert.match(
            checkoutSource,
            /axios\.post\(`\$\{serverUrl\}\/api\/order\/verify-payment`/,
            "verify-payment must be a POST to serverUrl"
        )
        assert.match(checkoutSource, /withCredentials:\s*true/)
        assert.match(checkoutSource, /'X-XSRF-TOKEN':\s*csrfToken/)
    })

    test("Checkout preserves the COD and online payment branches", () => {
        assert.match(checkoutSource, /if\s*\(\s*paymentMethod\s*==\s*["']cod["']\s*\)/)
        assert.match(checkoutSource, /dispatch\(addMyOrder\(result\.data\)\)/)
        assert.match(checkoutSource, /navigate\(["']\/order-placed["']\)/)
        assert.match(checkoutSource, /const orderId\s*=\s*result\.data\.orderId/)
        assert.match(checkoutSource, /const razorOrder\s*=\s*result\.data\.razorOrder/)
        assert.match(checkoutSource, /openRazorpayWindow\(orderId,\s*razorOrder\)/)
    })
})

describe("App.jsx Socket.IO lifecycle", () => {
    const appSource = readFileSync(
        path.resolve(here, "../../frontend/src/App.jsx"),
        "utf8"
    )

    test("Socket.IO is initialized exactly once with credentials", () => {
        const inits = appSource.match(/io\(serverUrl\s*,\s*\{withCredentials:true[,}]/g) || []
        assert.strictEqual(
            inits.length,
            1,
            "App.jsx must contain exactly one io(serverUrl, {withCredentials:true,...}) initialization"
        )
    })

    test("the socket variable is locally declared as const (no strict-mode undeclared assignment)", () => {
        assert.match(appSource, /const socketInstance=io\(serverUrl\s*,\s*\{withCredentials:true[,}]/)
        assert.ok(
            !/(?<!const )socketInstance=io\(/.test(appSource),
            "socket instance must never be assigned without a const declaration"
        )
    })

    test("the socket effect disconnects on cleanup, emits no client-controlled identity, and gates connection on userData", () => {
        const effect = appSource.slice(appSource.indexOf("const socketInstance=io"))
        assert.match(effect, /socketInstance\.disconnect\(\)/, "the effect must disconnect the socket on cleanup")
        assert.ok(
            !/socketInstance\.emit\(\s*['"]identity['"]/.test(effect),
            "App.jsx must not emit a client-controlled identity event; identity is derived server-side from the verified JWT"
        )
        assert.match(effect, /autoConnect:Boolean\(u\)/, "connection initialization must be gated by userData via autoConnect")
    })

    test("an authenticated user gets exactly one socket attempt per userData._id change", () => {
        assert.match(appSource, /\},\s*\[userData\?\._id\]\)/)
        assert.strictEqual((appSource.match(/const socketInstance=io\(/g) || []).length, 1)
        assert.match(appSource, /return\s*\(\s*\)?\s*=>\s*\{\s*socketInstance\.disconnect\(\)/)
    })

    test("socket effect depends on userData._id and csrf bootstrap still runs once on mount", () => {
        assert.match(appSource, /\},\s*\[userData\?\._id\]\)/)
        assert.match(appSource, /bootstrapCsrfToken\(\)/)
        assert.match(appSource, /\}, \[\]\)/)
    })

    test("the socket instance is published to the module store instead of Redux", () => {
        assert.match(appSource, /setSharedSocket\(socketInstance\)/)
        assert.match(appSource, /clearSharedSocket\(socketInstance\)/)
        assert.ok(!appSource.includes("setSocket"), "App must not dispatch a socket instance into Redux")
        assert.ok(!appSource.includes("dispatch(setSocket"), "socket instances are not serializable Redux state")
    })

    test("a signed-out session creates no new Socket.IO connection", () => {
    assert.match(appSource, /if\(!u\)\{\s*return undefined\s*\}/)
    const guardEnd = appSource.indexOf("const socketInstance=io")
    assert.ok(guardEnd > 0, "the socket creation guard should precede socket creation")
    assert.ok(
        appSource.indexOf("if(!u)") < guardEnd,
        "no socket should be created until authenticated userData exists"
    )
    })
})
