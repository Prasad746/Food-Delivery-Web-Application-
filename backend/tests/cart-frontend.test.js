import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const readFrontend = (relativePath) =>
    readFileSync(path.resolve(here, "../../frontend/src", relativePath), "utf8")

const foodCardSource = readFrontend("components/FoodCard.jsx")
const userSliceSource = readFrontend("redux/userSlice.js")
const navSource = readFrontend("components/Nav.jsx")
const checkoutSource = readFrontend("pages/CheckOut.jsx")

describe("customer cart and search frontend safety", () => {
    test("search results normalize the populated shop to a checkout-compatible id", () => {
        assert.match(foodCardSource, /typeof data\.shop === "object"/)
        assert.match(foodCardSource, /data\.shop\._id/)
        assert.match(foodCardSource, /shop:shopId/)
        assert.match(navSource, /new URLSearchParams\(\{ query: normalizedQuery, city: currentCity \|\| "" \}\)/)
        assert.match(navSource, /query\.trim\(\)/)
    })

    test("food cards cannot add unavailable items or exceed the quantity cap", () => {
        assert.match(foodCardSource, /MAX_ITEM_QUANTITY = 99/)
        assert.match(foodCardSource, /quantity\s*<\s*MAX_ITEM_QUANTITY/)
        assert.match(foodCardSource, /data\.isAvailable\s*!==\s*false/)
    })

    test("checkout blocks duplicate submissions while a placement request is in flight", () => {
        assert.match(checkoutSource, /placingOrderRef\.current/)
        assert.match(checkoutSource, /setPlacingOrder\(true\)/)
        assert.match(checkoutSource, /finally\s*\{/)
        assert.match(checkoutSource, /disabled=\{placingOrder\}/)
    })

    test("the cart slice validates items and clamps quantities to the supported range", () => {
        assert.match(userSliceSource, /const MAX_ITEM_QUANTITY = 99/)
        assert.match(userSliceSource, /const clampQuantity =/)
        assert.match(userSliceSource, /Math\.min\(MAX_ITEM_QUANTITY, Math\.max\(1,/)
        assert.match(userSliceSource, /!cartItem\.id \|\| !cartItem\.shop \|\| requestedQuantity <= 0/)
        assert.match(userSliceSource, /existingItem\.quantity = clampQuantity\(existingItem\.quantity \+ quantity\)/)
        assert.match(userSliceSource, /item\.quantity = clampQuantity\(quantity\)/)
    })
})
