import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const recommendationsSource = fs.readFileSync(
    new URL("../../frontend/src/components/FoodRecommendations.jsx", import.meta.url),
    "utf8"
)
const userDashboardSource = fs.readFileSync(
    new URL("../../frontend/src/components/UserDashboard.jsx", import.meta.url),
    "utf8"
)

describe("food recommendations frontend", () => {
    test("is integrated into the customer dashboard", () => {
        assert.match(userDashboardSource, /import FoodRecommendations from '\.\/FoodRecommendations'/)
        assert.match(userDashboardSource, /<FoodRecommendations \/>/)
        assert.match(recommendationsSource, /Recommended For You/)
    })

    test("loads the authenticated recommendation endpoint with a supported limit", () => {
        assert.match(recommendationsSource, /import api from '\.\.\/utils\/axiosInstance'/)
        assert.match(recommendationsSource, /api\.get\("\/api\/item\/recommendations"/)
        assert.match(recommendationsSource, /limit: 8/)
        assert.match(recommendationsSource, /AbortController/)
        assert.match(recommendationsSource, /ERR_CANCELED/)
    })

    test("reuses the existing food card and keeps checkout-compatible shop IDs", () => {
        assert.match(recommendationsSource, /import FoodCard from '\.\/FoodCard'/)
        assert.match(recommendationsSource, /<FoodCard data=\{\{ \.\.\.item, shop: item\.shopId \}\} \/>/)
        assert.match(recommendationsSource, /item\.shop\?\.name/)
        assert.match(recommendationsSource, /navigate\(`\/shop\/\$\{item\.shopId\}`\)/)
    })

    test("hides items already in the cart without duplicating cart state", () => {
        assert.match(recommendationsSource, /const \{ cartItems \} = useSelector/)
        assert.match(recommendationsSource, /new Set\(\(cartItems \|\| \[\]\)\.map\(\(item\) => String\(item\.id\)\)\)/)
        assert.match(recommendationsSource, /recommendations\.filter\(\(item\) => !cartIds\.has\(String\(item\._id\)\)\)/)
        assert.match(recommendationsSource, /already in your cart/)
    })

    test("renders loading, error, retry, and empty states", () => {
        assert.match(recommendationsSource, /status === "loading"/)
        assert.match(recommendationsSource, /status === "error"/)
        assert.match(recommendationsSource, /Try again/)
        assert.match(recommendationsSource, /setReloadKey/)
        assert.match(recommendationsSource, /No recommendations yet/)
        assert.match(recommendationsSource, /aria-busy="true"/)
    })

    test("shows the recommendation reason and source-specific context", () => {
        assert.match(recommendationsSource, /item\.recommendation\?\.reason/)
        assert.match(recommendationsSource, /SOURCE_MESSAGES\[payload\?\.meta\?\.source\]/)
        for (const source of ["history", "popular", "fallback"]) {
            assert.match(recommendationsSource, new RegExp(`${source}:`))
        }
    })
})
