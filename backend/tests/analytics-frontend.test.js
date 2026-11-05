import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const analyticsSource = fs.readFileSync(
    new URL("../../frontend/src/components/OwnerAnalytics.jsx", import.meta.url),
    "utf8"
)
const ownerDashboardSource = fs.readFileSync(
    new URL("../../frontend/src/components/OwnerDashboard.jsx", import.meta.url),
    "utf8"
)

describe("restaurant analytics dashboard frontend", () => {
    test("is integrated into the existing owner dashboard", () => {
        assert.match(ownerDashboardSource, /import OwnerAnalytics from '\.\/OwnerAnalytics'/)
        assert.match(ownerDashboardSource, /<OwnerAnalytics shopId=\{myShopData\._id\}/)
    })

    test("loads backend analytics with all supported date filters", () => {
        assert.match(analyticsSource, /\/api\/order\/analytics/)
        for (const label of ["Today", "Last 7 days", "Last 30 days", "This month", "Custom range"]) {
            assert.ok(analyticsSource.includes(label), `missing filter label: ${label}`)
        }
        assert.match(analyticsSource, /params\.startDate = appliedRange\.startDate/)
        assert.match(analyticsSource, /params\.endDate = appliedRange\.endDate/)
    })

    test("renders loading, error, and empty states", () => {
        assert.match(analyticsSource, /Loading restaurant analytics/)
        assert.match(analyticsSource, /Try again/)
        assert.match(analyticsSource, /No orders in this period/)
        assert.match(analyticsSource, /setError/)
    })

    test("renders responsive charts from backend series and status data", () => {
        assert.match(analyticsSource, /ResponsiveContainer/)
        assert.match(analyticsSource, /BarChart data=\{analytics\.series\}/)
        assert.match(analyticsSource, /LineChart data=\{analytics\.series\}/)
        assert.match(analyticsSource, /const statusDistribution = analytics\?\.statusDistribution \|\| \[\]/)
        assert.match(analyticsSource, /grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3/)
        assert.match(analyticsSource, /grid-cols-1 gap-4 xl:grid-cols-2/)
        assert.ok(!analyticsSource.includes("sampleData"))
        assert.ok(!analyticsSource.includes("mockData"))
    })

    test("renders best-selling food and food performance from backend analytics", () => {
        assert.match(analyticsSource, /const bestSellers = analytics\?\.bestSellers \|\| \[\]/)
        assert.match(analyticsSource, /const foodPerformance = analytics\?\.foodPerformance \|\| \[\]/)
        assert.match(analyticsSource, /bestSellers\.map\(/)
        assert.match(analyticsSource, /foodPerformance\.map\(/)
        assert.match(analyticsSource, /Top 5 delivered items by quantity sold/)
        assert.match(analyticsSource, /item\.quantitySold/)
        assert.match(analyticsSource, /item\.orderCount/)
        assert.match(analyticsSource, /item\.contributionPercentage/)
        assert.match(analyticsSource, /item\.rank/)
        assert.match(analyticsSource, /<img src=\{image\} alt=\{name\}/)
        assert.match(analyticsSource, /No qualifying food sales yet/)
        assert.match(analyticsSource, /No food performance data yet/)
    })
})
