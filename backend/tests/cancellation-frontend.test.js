import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, "../../frontend/src")

const readSource = (relativePath) => readFileSync(path.join(frontend, relativePath), "utf8")

const userOrderCard = readSource("components/UserOrderCard.jsx")
const ownerOrderCard = readSource("components/OwnerOrderCard.jsx")
const myOrdersPage = readSource("pages/MyOrders.jsx")
const trackOrderPage = readSource("pages/TrackOrderPage.jsx")
const userSliceSource = readSource("redux/userSlice.js")

const { default: userReducer, updateOrderStatus, updateRealtimeOrderStatus } = await import("../../frontend/src/redux/userSlice.js")

describe("customer cancellation UI", () => {
    test("UserOrderCard calls the per-shop cancellation endpoint with a bounded reason", () => {
        assert.ok(userOrderCard.includes("/api/order/cancel/"))
        assert.ok(userOrderCard.includes("${data._id}/${shopOrderId}"))
        assert.ok(userOrderCard.includes("CANCELLABLE_STATUSES"))
        assert.ok(userOrderCard.includes("maxLength={300}"))
        assert.ok(userOrderCard.includes("Confirm cancellation"))
        assert.ok(userOrderCard.includes("Only this restaurant's items will be cancelled"))
        assert.ok(userOrderCard.includes("refundLabel"))
        assert.ok(userOrderCard.includes("updateRealtimeOrderStatus"))
    })

    test("owner and tracking views render cancelled shop orders", () => {
        assert.ok(ownerOrderCard.includes("isCancelled"))
        assert.ok(ownerOrderCard.includes("Cancelled by customer"))
        assert.ok(ownerOrderCard.includes("cancellationReason"))
        assert.ok(trackOrderPage.includes("This restaurant order was cancelled"))
        assert.ok(trackOrderPage.includes("update-status"))
        assert.ok(trackOrderPage.includes("status !== \"cancelled\""))
    })

    test("customers and owners both receive cancellation socket updates", () => {
        assert.ok(myOrdersPage.includes("ownerId"))
        assert.ok(myOrdersPage.includes("updateOrderStatus"))
        assert.ok(myOrdersPage.includes("updateRealtimeOrderStatus"))
        assert.ok(userSliceSource.includes("applyShopOrderUpdate"))
    })
})

describe("cancellation Redux state", () => {
    test("customer shop-order arrays are updated with status, refund, and cancellation time", () => {
        const initial = userReducer(undefined, { type: "__noop" })
        const seeded = {
            ...initial,
            myOrders: [{
                _id: "order-one",
                shopOrders: [
                    { _id: "shop-order-one", shop: { _id: "shop-one" }, status: "pending" },
                    { _id: "shop-order-two", shop: { _id: "shop-two" }, status: "preparing" }
                ]
            }]
        }
        const refund = { status: "processed", amount: 100 }
        const next = userReducer(seeded, updateRealtimeOrderStatus({
            orderId: "order-one",
            shopId: "shop-one",
            status: "cancelled",
            refund,
            cancelledAt: "2026-11-04T10:00:00.000Z"
        }))

        assert.strictEqual(next.myOrders[0].shopOrders[0].status, "cancelled")
        assert.deepStrictEqual(next.myOrders[0].shopOrders[0].refund, refund)
        assert.strictEqual(next.myOrders[0].shopOrders[0].cancelledAt, "2026-11-04T10:00:00.000Z")
        assert.strictEqual(next.myOrders[0].shopOrders[1].status, "preparing")
        assert.strictEqual(seeded.myOrders[0].shopOrders[0].status, "pending")
    })

    test("owner shop-order objects are updated without changing the order shape", () => {
        const initial = userReducer(undefined, { type: "__noop" })
        const seeded = {
            ...initial,
            myOrders: [{
                _id: "order-two",
                shopOrders: { _id: "shop-order-three", shop: { _id: "shop-three" }, status: "preparing" }
            }]
        }
        const next = userReducer(seeded, updateOrderStatus({
            orderId: "order-two",
            shopId: "shop-three",
            status: "cancelled",
            cancelledAt: "2026-11-04T11:00:00.000Z"
        }))

        assert.strictEqual(next.myOrders[0].shopOrders.status, "cancelled")
        assert.strictEqual(next.myOrders[0].shopOrders.cancelledAt, "2026-11-04T11:00:00.000Z")
        assert.ok(!Array.isArray(next.myOrders[0].shopOrders))
    })
})
