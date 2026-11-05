import React, { useEffect, useState } from 'react'
import axios from '../utils/axiosInstance'
import { serverUrl } from '../utils/csrfClient'
import { ClipLoader } from 'react-spinners'
import { FaChartLine, FaTrophy, FaUtensils } from 'react-icons/fa'
import { FiAlertCircle } from 'react-icons/fi'
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Line,
    LineChart,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from 'recharts'

const PERIOD_OPTIONS = [
    { key: "today", label: "Today" },
    { key: "last7", label: "Last 7 days" },
    { key: "last30", label: "Last 30 days" },
    { key: "thisMonth", label: "This month" },
    { key: "custom", label: "Custom range" }
]

const STATUS_COLORS = {
    pending: "#f59e0b",
    preparing: "#3b82f6",
    "out of delivery": "#8b5cf6",
    delivered: "#16a34a",
    cancelled: "#ef4444"
}

const formatCurrency = (value) =>
    `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

const formatPercentage = (value) => `${Number(value || 0).toFixed(1)}%`

const formatDate = (value) => {
    if (!value) return ""
    const parts = value.split("-").map(Number)
    if (parts.length !== 3 || parts.some(Number.isNaN)) return value
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    })
}

const formatPeriod = (period) => {
    if (!period?.startDate || !period?.endDate) return ""
    if (period.startDate === period.endDate) {
        return formatDate(period.startDate)
    }
    return `${formatDate(period.startDate)} - ${formatDate(period.endDate)}`
}

const formatChange = (current, previous) => {
    if (!previous) {
        return current ? "No prior-period baseline" : "No change"
    }
    const change = ((Number(current) - Number(previous)) / Number(previous)) * 100
    const prefix = change > 0 ? "+" : ""
    return `${prefix}${change.toFixed(1)}% vs previous period`
}

function SummaryCard({ title, value, detail, comparison, valueClass = "text-gray-900" }) {
    return (
        <div className='rounded-xl border border-orange-100 bg-white p-4 shadow-sm'>
            <p className='text-sm font-medium text-gray-500'>{title}</p>
            <p className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</p>
            {detail && <p className='mt-1 text-xs text-gray-500'>{detail}</p>}
            {comparison && <p className='mt-2 text-xs text-gray-400'>{comparison}</p>}
        </div>
    )
}

function FoodThumb({ name, image }) {
    return (
        <div className='flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-orange-100 bg-orange-50'>
            {image ? (
                <img src={image} alt={name} className='h-full w-full object-cover' loading='lazy' />
            ) : (
                <FaUtensils className='text-[#ff4d2d]' aria-hidden='true' />
            )}
        </div>
    )
}

function FoodEmptyState({ title, description }) {
    return (
        <div className='mt-4 flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-orange-200 bg-orange-50/40 p-4 text-center'>
            <FaUtensils size={24} className='text-[#ff4d2d]' aria-hidden='true' />
            <p className='font-semibold text-gray-800'>{title}</p>
            <p className='max-w-sm text-sm text-gray-500'>{description}</p>
        </div>
    )
}

function OwnerAnalytics({ shopId }) {
    const [selectedPeriod, setSelectedPeriod] = useState("last7")
    const [appliedRange, setAppliedRange] = useState({ period: "last7", startDate: "", endDate: "" })
    const [customStartDate, setCustomStartDate] = useState("")
    const [customEndDate, setCustomEndDate] = useState("")
    const [customError, setCustomError] = useState("")
    const [analytics, setAnalytics] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")
    const [refreshKey, setRefreshKey] = useState(0)

    useEffect(() => {
        let ignore = false
        const controller = new AbortController()
        const params = { period: appliedRange.period }
        if (appliedRange.period === "custom") {
            params.startDate = appliedRange.startDate
            params.endDate = appliedRange.endDate
        }

        setLoading(true)
        setError("")
        setAnalytics(null)

        axios.get(`${serverUrl}/api/order/analytics`, {
            params,
            withCredentials: true,
            signal: controller.signal
        }).then((result) => {
            if (!ignore) {
                setAnalytics(result.data)
            }
        }).catch((requestError) => {
            if (ignore || requestError?.code === "ERR_CANCELED") return
            setError(requestError?.response?.data?.message || "Failed to load restaurant analytics.")
        }).finally(() => {
            if (!ignore) {
                setLoading(false)
            }
        })

        return () => {
            ignore = true
            controller.abort()
        }
    }, [appliedRange.period, appliedRange.startDate, appliedRange.endDate, refreshKey, shopId])

    const selectPeriod = (period) => {
        setSelectedPeriod(period)
        setCustomError("")
        if (period !== "custom") {
            setAppliedRange({ period, startDate: "", endDate: "" })
        }
    }

    const applyCustomRange = (event) => {
        event.preventDefault()
        if (!customStartDate || !customEndDate) {
            setCustomError("Choose both a start date and an end date.")
            return
        }
        if (customEndDate < customStartDate) {
            setCustomError("End date must be on or after the start date.")
            return
        }
        setCustomError("")
        setAppliedRange({ period: "custom", startDate: customStartDate, endDate: customEndDate })
    }

    const summary = analytics?.summary
    const previous = analytics?.previous
    const hasOrders = (summary?.totalOrders || 0) > 0
    const statusDistribution = analytics?.statusDistribution || []
    const statusCounts = Object.fromEntries(statusDistribution.map((item) => [item.status, item.count]))
    const nonZeroStatuses = statusDistribution.filter((item) => item.count > 0)
    const bestSellers = analytics?.bestSellers || []
    const foodPerformance = analytics?.foodPerformance || []
    const selectedPeriodLabel = PERIOD_OPTIONS.find((option) => option.key === selectedPeriod)?.label || "Analytics"
    const activePeriod = analytics?.period

    return (
        <section className='w-full max-w-6xl rounded-2xl border border-orange-100 bg-[#fffdfb] p-4 shadow-sm sm:p-6 space-y-5' aria-busy={loading}>
            <div className='flex flex-col gap-2 md:flex-row md:items-end md:justify-between'>
                <div>
                    <p className='text-xs font-semibold uppercase tracking-[0.2em] text-[#ff4d2d]'>Restaurant analytics</p>
                    <h2 className='mt-1 flex items-center gap-2 text-xl font-bold text-gray-900 sm:text-2xl'>
                        <FaChartLine className='text-[#ff4d2d]' />
                        Performance overview
                    </h2>
                    <p className='mt-1 text-sm text-gray-500'>Metrics are based only on this restaurant&apos;s suborders.</p>
                </div>
                <div className='text-left md:text-right'>
                    <p className='text-sm font-semibold text-gray-700'>{activePeriod ? formatPeriod(activePeriod) : selectedPeriodLabel}</p>
                    <p className='text-xs text-gray-400'>
                        {activePeriod ? `${activePeriod.label} · ${activePeriod.timezone}` : "Select a date range"}
                    </p>
                </div>
            </div>

            <div className='rounded-xl border border-orange-100 bg-white p-3'>
                <div className='flex flex-wrap gap-2'>
                    {PERIOD_OPTIONS.map((option) => (
                        <button
                            key={option.key}
                            type='button'
                            onClick={() => selectPeriod(option.key)}
                            className={`rounded-full px-3 py-2 text-sm font-medium transition ${selectedPeriod === option.key
                                ? "bg-[#ff4d2d] text-white shadow-sm"
                                : "border border-orange-200 bg-white text-gray-600 hover:border-[#ff4d2d] hover:text-[#ff4d2d]"}`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                {selectedPeriod === "custom" && (
                    <form className='mt-3 grid grid-cols-1 gap-3 border-t border-orange-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end' onSubmit={applyCustomRange}>
                        <label className='text-sm font-medium text-gray-600'>
                            Start date
                            <input
                                type='date'
                                value={customStartDate}
                                max={customEndDate || undefined}
                                onChange={(event) => setCustomStartDate(event.target.value)}
                                className='mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff4d2d]'
                            />
                        </label>
                        <label className='text-sm font-medium text-gray-600'>
                            End date
                            <input
                                type='date'
                                value={customEndDate}
                                min={customStartDate || undefined}
                                onChange={(event) => setCustomEndDate(event.target.value)}
                                className='mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff4d2d]'
                            />
                        </label>
                        <button type='submit' className='rounded-lg bg-[#ff4d2d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#e64526]'>
                            Apply
                        </button>
                        {customError && <p className='text-sm text-red-600 sm:col-span-3'>{customError}</p>}
                    </form>
                )}
            </div>

            {loading && (
                <div className='flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-orange-100 bg-white'>
                    <ClipLoader size={30} color='#ff4d2d' />
                    <p className='text-sm text-gray-500'>Loading restaurant analytics...</p>
                </div>
            )}

            {!loading && error && (
                <div className='flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-center'>
                    <FiAlertCircle size={28} className='text-red-500' />
                    <p className='font-medium text-red-700'>{error}</p>
                    <button type='button' onClick={() => setRefreshKey((value) => value + 1)} className='rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700'>
                        Try again
                    </button>
                </div>
            )}

            {!loading && !error && analytics && (
                <>
                    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                        <SummaryCard
                            title='Total Orders'
                            value={summary.totalOrders}
                            detail='Restaurant suborders received'
                            comparison={formatChange(summary.totalOrders, previous.totalOrders)}
                        />
                        <SummaryCard
                            title='Revenue'
                            value={formatCurrency(summary.revenue)}
                            detail='Delivered, paid orders; delivery fees excluded'
                            comparison={formatChange(summary.revenue, previous.revenue)}
                            valueClass='text-green-700'
                        />
                        <SummaryCard
                            title='Completed Orders'
                            value={summary.completedOrders}
                            detail={`${summary.completionPercentage.toFixed(1)}% completion rate`}
                            comparison={formatChange(summary.completedOrders, previous.completedOrders)}
                        />
                        <SummaryCard
                            title='Pending Orders'
                            value={summary.pendingOrders}
                            detail={`${statusCounts.pending || 0} pending · ${statusCounts.preparing || 0} preparing · ${statusCounts["out of delivery"] || 0} out for delivery`}
                            comparison={formatChange(summary.pendingOrders, previous.pendingOrders)}
                            valueClass='text-amber-600'
                        />
                        <SummaryCard
                            title='Cancelled Orders'
                            value={summary.cancelledOrders}
                            detail={`${summary.cancellationPercentage.toFixed(1)}% cancellation rate`}
                            comparison={formatChange(summary.cancelledOrders, previous.cancelledOrders)}
                            valueClass='text-red-600'
                        />
                        <SummaryCard
                            title='Average Order Value'
                            value={formatCurrency(summary.averageOrderValue)}
                            detail='Revenue ÷ delivered paid orders'
                            comparison={formatChange(summary.averageOrderValue, previous.averageOrderValue)}
                        />
                    </div>

                    {!hasOrders && (
                        <div className='flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-orange-200 bg-white p-5 text-center'>
                            <FaChartLine size={30} className='text-[#ff4d2d]' />
                            <h3 className='text-lg font-semibold text-gray-800'>No orders in this period</h3>
                            <p className='max-w-md text-sm text-gray-500'>Try another date range to see order, revenue, and status trends for your restaurant.</p>
                        </div>
                    )}

                    {hasOrders && (
                        <>
                            <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
                                <div className='rounded-xl border border-orange-100 bg-white p-4'>
                                    <h3 className='text-base font-semibold text-gray-800'>Orders over time</h3>
                                    <p className='mb-3 text-xs text-gray-400'>{activePeriod?.granularity === "hour" ? "Hourly" : "Daily"} restaurant suborders</p>
                                    <div className='h-[260px] w-full'>
                                        <ResponsiveContainer width='100%' height='100%'>
                                            <BarChart data={analytics.series}>
                                                <CartesianGrid strokeDasharray='3 3' vertical={false} />
                                                <XAxis dataKey='label' tick={{ fontSize: 12 }} minTickGap={20} />
                                                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                                                <Tooltip formatter={(value) => [value, "Orders"]} />
                                                <Bar dataKey='orders' fill='#ff4d2d' radius={[4, 4, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>

                                <div className='rounded-xl border border-orange-100 bg-white p-4'>
                                    <h3 className='text-base font-semibold text-gray-800'>Revenue over time</h3>
                                    <p className='mb-3 text-xs text-gray-400'>Delivered, paid restaurant subtotals</p>
                                    <div className='h-[260px] w-full'>
                                        <ResponsiveContainer width='100%' height='100%'>
                                            <LineChart data={analytics.series}>
                                                <CartesianGrid strokeDasharray='3 3' vertical={false} />
                                                <XAxis dataKey='label' tick={{ fontSize: 12 }} minTickGap={20} />
                                                <YAxis tick={{ fontSize: 12 }} />
                                                <Tooltip formatter={(value) => [formatCurrency(value), "Revenue"]} />
                                                <Line type='monotone' dataKey='revenue' stroke='#16a34a' strokeWidth={2} dot={false} />
                                            </LineChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            </div>

                            <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
                                <div className='rounded-xl border border-orange-100 bg-white p-4'>
                                    <div className='flex items-start justify-between gap-3'>
                                        <div>
                                            <h3 className='text-base font-semibold text-gray-800'>Best-selling food</h3>
                                            <p className='text-xs text-gray-400'>Top 5 delivered items by quantity sold</p>
                                        </div>
                                        <span className='rounded-lg bg-orange-50 p-2 text-[#ff4d2d]'>
                                            <FaTrophy aria-hidden='true' />
                                        </span>
                                    </div>

                                    {bestSellers.length === 0 ? (
                                        <FoodEmptyState
                                            title='No qualifying food sales yet'
                                            description='Delivered, paid orders in this period will be ranked here.'
                                        />
                                    ) : (
                                        <ol className='mt-4 space-y-2'>
                                            {bestSellers.map((item) => (
                                                <li key={item.itemId || `${item.name}-${item.rank}`} className='flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5'>
                                                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${item.rank === 1
                                                        ? "bg-[#ff4d2d] text-white"
                                                        : item.rank <= 3
                                                            ? "bg-orange-100 text-[#ff4d2d]"
                                                            : "bg-gray-200 text-gray-600"}`}>
                                                        {item.rank}
                                                    </span>
                                                    <FoodThumb name={item.name} image={item.image} />
                                                    <div className='min-w-0 flex-1'>
                                                        <p className='truncate text-sm font-semibold text-gray-800'>{item.name}</p>
                                                        <p className='text-xs text-gray-400'>{item.orderCount} {item.orderCount === 1 ? "order" : "orders"}</p>
                                                    </div>
                                                    <div className='text-right'>
                                                        <p className='text-sm font-bold text-gray-900'>{item.quantitySold}</p>
                                                        <p className='text-xs text-gray-400'>sold</p>
                                                    </div>
                                                </li>
                                            ))}
                                        </ol>
                                    )}
                                </div>

                                <div className='rounded-xl border border-orange-100 bg-white p-4'>
                                    <div className='flex items-start justify-between gap-3'>
                                        <div>
                                            <h3 className='text-base font-semibold text-gray-800'>Food performance</h3>
                                            <p className='text-xs text-gray-400'>Revenue contribution from delivered, paid food sales</p>
                                        </div>
                                        <span className='rounded-lg bg-orange-50 p-2 text-[#ff4d2d]'>
                                            <FaUtensils aria-hidden='true' />
                                        </span>
                                    </div>

                                    {foodPerformance.length === 0 ? (
                                        <FoodEmptyState
                                            title='No food performance data yet'
                                            description='Delivered, paid item sales in this period will appear here.'
                                        />
                                    ) : (
                                        <div className='mt-4 overflow-x-auto'>
                                            <table className='w-full min-w-[520px] border-collapse text-sm'>
                                                <thead>
                                                    <tr className='border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wide text-gray-400'>
                                                        <th className='pb-2 pr-3'>Food item</th>
                                                        <th className='px-3 pb-2 text-right'>Qty sold</th>
                                                        <th className='px-3 pb-2 text-right'>Revenue</th>
                                                        <th className='pl-3 pb-2 text-right'>Contribution</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {foodPerformance.map((item) => (
                                                        <tr key={item.itemId || item.name} className='border-b border-gray-50 last:border-0'>
                                                            <td className='py-2.5 pr-3'>
                                                                <div className='flex min-w-0 items-center gap-2.5'>
                                                                    <FoodThumb name={item.name} image={item.image} />
                                                                    <p className='truncate font-medium text-gray-800'>{item.name}</p>
                                                                </div>
                                                            </td>
                                                            <td className='px-3 py-2.5 text-right text-gray-600'>{item.quantitySold}</td>
                                                            <td className='px-3 py-2.5 text-right font-semibold text-green-700'>{formatCurrency(item.revenue)}</td>
                                                            <td className='pl-3 py-2.5 text-right'>
                                                                <div className='flex items-center justify-end gap-2'>
                                                                    <span className='h-1.5 w-14 overflow-hidden rounded-full bg-orange-100' aria-hidden='true'>
                                                                        <span
                                                                            className='block h-full rounded-full bg-[#ff4d2d]'
                                                                            style={{ width: `${Math.max(0, Math.min(100, Number(item.contributionPercentage) || 0))}%` }}
                                                                        />
                                                                    </span>
                                                                    <span className='w-12 font-medium text-gray-700'>{formatPercentage(item.contributionPercentage)}</span>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className='rounded-xl border border-orange-100 bg-white p-4'>
                                <h3 className='text-base font-semibold text-gray-800'>Order status distribution</h3>
                                <p className='mb-3 text-xs text-gray-400'>Current status of restaurant suborders received in this period</p>
                                <div className='grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,280px)_1fr] md:items-center'>
                                    <div className='h-[240px] w-full'>
                                        <ResponsiveContainer width='100%' height='100%'>
                                            <PieChart>
                                                <Pie data={nonZeroStatuses} dataKey='count' nameKey='label' cx='50%' cy='50%' innerRadius={55} outerRadius={90}>
                                                    {nonZeroStatuses.map((item) => (
                                                        <Cell key={item.status} fill={STATUS_COLORS[item.status] || "#94a3b8"} />
                                                    ))}
                                                </Pie>
                                                <Tooltip />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                    <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                                        {statusDistribution.map((item) => (
                                            <div key={item.status} className='flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm'>
                                                <span className='flex items-center gap-2 text-gray-600'>
                                                    <span className='h-2.5 w-2.5 rounded-full' style={{ backgroundColor: STATUS_COLORS[item.status] || "#94a3b8" }} />
                                                    {item.label}
                                                </span>
                                                <span className='font-semibold text-gray-800'>{item.count}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </>
            )}
        </section>
    )
}

export default OwnerAnalytics
