import { describe, expect, it } from 'vitest'
import {
    calculateCartTotals,
    discountBadgeLabel,
    discountFormToPayload,
    getCartItemPricing,
    getDiscountStatus,
    getHistoricalItemPricing,
    getItemPricing,
    serializeDiscountField,
    validateDiscountForm
} from './discountPricing'

const now = new Date('2026-06-15T12:00:00.000Z')

const activeDiscount = (overrides = {}) => ({
    type: 'percentage',
    value: 20,
    startDate: '2026-06-01T00:00:00.000Z',
    endDate: '2026-06-30T23:59:59.999Z',
    enabled: true,
    ...overrides
})

describe('getItemPricing', () => {
    it('returns the original price when no discount is configured', () => {
        const pricing = getItemPricing({ price: 200 }, now)
        expect(pricing).toMatchObject({
            originalPrice: 200,
            finalPrice: 200,
            discountApplied: false,
            discountType: ''
        })
        expect(pricing.status.state).toBe('none')
    })

    it('applies a percentage discount with backend-compatible rounding', () => {
        const pricing = getItemPricing({ price: 199.99, discount: activeDiscount() }, now)
        expect(pricing.originalPrice).toBe(199.99)
        expect(pricing.discountAmount).toBe(40)
        expect(pricing.finalPrice).toBe(159.99)
        expect(pricing.discountApplied).toBe(true)
    })

    it('applies a fixed discount without exceeding the item price', () => {
        const pricing = getItemPricing({
            price: 200,
            discount: activeDiscount({ type: 'fixed', value: 30 })
        }, now)
        expect(pricing.finalPrice).toBe(170)
        expect(pricing.discountAmount).toBe(30)
    })

    it('supports a 100 percent discount', () => {
        const pricing = getItemPricing({
            price: 200,
            discount: activeDiscount({ value: 100 })
        }, now)
        expect(pricing.finalPrice).toBe(0)
        expect(pricing.discountAmount).toBe(200)
    })

    it('does not apply a disabled discount', () => {
        const pricing = getItemPricing({
            price: 200,
            discount: activeDiscount({ enabled: false })
        }, now)
        expect(pricing.finalPrice).toBe(200)
        expect(pricing.discountApplied).toBe(false)
        expect(pricing.status.state).toBe('disabled')
    })

    it('does not apply a scheduled discount before it starts', () => {
        const pricing = getItemPricing({
            price: 200,
            discount: activeDiscount({ startDate: '2026-06-16T00:00:00.000Z' })
        }, now)
        expect(pricing.finalPrice).toBe(200)
        expect(pricing.status.state).toBe('scheduled')
    })

    it('does not apply an expired discount', () => {
        const pricing = getItemPricing({
            price: 200,
            discount: activeDiscount({ endDate: '2026-06-14T23:59:59.999Z' })
        }, now)
        expect(pricing.finalPrice).toBe(200)
        expect(pricing.status.state).toBe('expired')
    })

    it('treats start and end timestamps as inclusive', () => {
        const atStart = getItemPricing({
            price: 200,
            discount: activeDiscount({
                startDate: now.toISOString(),
                endDate: '2026-06-30T00:00:00.000Z'
            })
        }, now)
        const atEnd = getItemPricing({
            price: 200,
            discount: activeDiscount({
                startDate: '2026-06-01T00:00:00.000Z',
                endDate: now.toISOString()
            })
        }, now)
        expect(atStart.discountApplied).toBe(true)
        expect(atEnd.discountApplied).toBe(true)
    })

    it('ignores invalid configured discounts', () => {
        const overPercentage = getItemPricing({
            price: 200,
            discount: activeDiscount({ value: 150 })
        }, now)
        const overFixed = getItemPricing({
            price: 200,
            discount: activeDiscount({ type: 'fixed', value: 250 })
        }, now)
        expect(overPercentage.finalPrice).toBe(200)
        expect(overPercentage.status.state).toBe('invalid')
        expect(overFixed.finalPrice).toBe(200)
        expect(overFixed.status.state).toBe('invalid')
    })

    it('handles missing and malformed discount data safely', () => {
        const missing = getItemPricing({ price: 100 })
        const malformed = getItemPricing({ price: 100, discount: 'bad-data' }, now)
        expect(missing.finalPrice).toBe(100)
        expect(malformed.finalPrice).toBe(100)
        expect(malformed.status.state).toBe('invalid')
    })
})

describe('getDiscountStatus', () => {
    it('distinguishes none, disabled, scheduled, expired and active states', () => {
        expect(getDiscountStatus(null).state).toBe('none')
        expect(getDiscountStatus(activeDiscount({ enabled: false }), { now }).state).toBe('disabled')
        expect(getDiscountStatus(activeDiscount({
            startDate: '2026-07-01T00:00:00.000Z',
            endDate: '2026-07-31T23:59:59.999Z'
        }), { now }).state).toBe('scheduled')
        expect(getDiscountStatus(activeDiscount({
            startDate: '2026-05-01T00:00:00.000Z',
            endDate: '2026-05-31T23:59:59.999Z'
        }), { now }).state).toBe('expired')
        expect(getDiscountStatus(activeDiscount(), { now }).state).toBe('active')
    })
})

describe('discount form validation and serialization', () => {
    it('accepts a valid percentage discount', () => {
        const result = validateDiscountForm({
            type: 'percentage',
            value: '20',
            startDate: '',
            endDate: '',
            enabled: true
        }, 200)
        expect(result.valid).toBe(true)
    })

    it('rejects empty, zero, negative and over-100 percentage values', () => {
        for (const value of ['', '0', '-5', '101']) {
            const result = validateDiscountForm({
                type: 'percentage',
                value,
                startDate: '',
                endDate: '',
                enabled: true
            }, 200)
            expect(result.valid).toBe(false)
            expect(result.errors.value).toBeTruthy()
        }
    })

    it('rejects a fixed discount above the item price', () => {
        const result = validateDiscountForm({
            type: 'fixed',
            value: '250',
            startDate: '',
            endDate: '',
            enabled: true
        }, 200)
        expect(result.valid).toBe(false)
        expect(result.errors.value).toContain('cannot exceed')
    })

    it('rejects an end date before the start date', () => {
        const result = validateDiscountForm({
            type: 'percentage',
            value: '20',
            startDate: '2026-06-10',
            endDate: '2026-06-09',
            enabled: true
        }, 200)
        expect(result.valid).toBe(false)
        expect(result.errors.endDate).toBeTruthy()
    })

    it('accepts the same start and end day because the end date is end-of-day', () => {
        const result = validateDiscountForm({
            type: 'percentage',
            value: '20',
            startDate: '2026-06-10',
            endDate: '2026-06-10',
            enabled: true
        }, 200)
        expect(result.valid).toBe(true)
    })

    it('serializes start-of-day, end-of-day and disabled state', () => {
        const payload = discountFormToPayload({
            type: 'fixed',
            value: '30',
            startDate: '2026-06-10',
            endDate: '2026-06-12',
            enabled: false
        })
        expect(payload).toEqual({
            type: 'fixed',
            value: 30,
            startDate: '2026-06-10T00:00:00.000Z',
            endDate: '2026-06-12T23:59:59.999Z',
            enabled: false
        })
        expect(JSON.parse(serializeDiscountField(payload)).enabled).toBe(false)
    })

    it('clears a discount with an empty multipart field', () => {
        expect(discountFormToPayload({ type: 'none' })).toBeNull()
        expect(serializeDiscountField(null)).toBe('')
    })
})

describe('cart and historical pricing', () => {
    it('preserves discounted line snapshots and computes savings', () => {
        const pricing = getCartItemPricing({
            price: 160,
            originalPrice: 200,
            discountType: 'percentage',
            discountValue: 20,
            discountAmount: 40,
            quantity: 2
        })
        expect(pricing.lineTotal).toBe(320)
        expect(pricing.originalLineTotal).toBe(400)
        expect(pricing.savings).toBe(80)
        expect(pricing.hasPrice).toBe(true)
    })

    it('handles cart items with missing price data', () => {
        const pricing = getCartItemPricing({ id: 'i1', quantity: 1 })
        expect(pricing.hasPrice).toBe(false)
        expect(pricing.finalPrice).toBe(0)
        expect(pricing.lineTotal).toBe(0)
    })

    it('keeps delivery free above 500 and charges 40 at or below 500', () => {
        const atLimit = calculateCartTotals([{ id: 'i1', price: 500, quantity: 1 }])
        const aboveLimit = calculateCartTotals([{ id: 'i1', price: 501, quantity: 1 }])
        expect(atLimit.deliveryFee).toBe(40)
        expect(atLimit.total).toBe(540)
        expect(aboveLimit.deliveryFee).toBe(0)
        expect(aboveLimit.total).toBe(501)
    })

    it('combines discounted and plain lines into authoritative totals', () => {
        const totals = calculateCartTotals([
            {
                id: 'i1',
                price: 160,
                originalPrice: 200,
                discountType: 'percentage',
                discountValue: 20,
                discountAmount: 40,
                quantity: 2
            },
            { id: 'i2', price: 100, quantity: 1 }
        ])
        expect(totals.subtotal).toBe(420)
        expect(totals.savings).toBe(80)
        expect(totals.deliveryFee).toBe(40)
        expect(totals.total).toBe(460)
    })

    it('uses historical order snapshots instead of the current item price', () => {
        const historical = getHistoricalItemPricing({
            item: { _id: 'i1', price: 999 },
            price: 170,
            originalPrice: 200,
            discountType: 'percentage',
            discountValue: 20,
            discountAmount: 30,
            finalPrice: 170
        })
        expect(historical.finalPrice).toBe(170)
        expect(historical.originalPrice).toBe(200)
        expect(historical.discountAmount).toBe(30)
        expect(historical.discountApplied).toBe(true)
    })

    it('does not invent a discount for older orders without snapshot fields', () => {
        const historical = getHistoricalItemPricing({
            item: { _id: 'i1', price: 999 },
            price: 120,
            quantity: 1
        })
        expect(historical.finalPrice).toBe(120)
        expect(historical.originalPrice).toBe(120)
        expect(historical.discountApplied).toBe(false)
    })

    it('formats customer-facing discount labels', () => {
        expect(discountBadgeLabel({ type: 'percentage', value: 20 })).toBe('20% OFF')
        expect(discountBadgeLabel({ type: 'fixed', value: 30 })).toBe('₹30 OFF')
        expect(discountBadgeLabel(null)).toBe('')
    })
})
