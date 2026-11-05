import { describe, expect, it } from 'vitest'
import {
    DEFAULT_CUSTOMER_CITY_MAX_ACCURACY_METERS,
    isCustomerCityAccuracyAcceptable,
    resolveCustomerCityMaxAccuracyMeters
} from './customerLocation'

describe('customer city accuracy', () => {
    it('accepts an accurate city-level fix', () => {
        expect(isCustomerCityAccuracyAcceptable(500)).toBe(true)
    })

    it('rejects the observed unreliable fix', () => {
        expect(isCustomerCityAccuracyAcceptable(200000)).toBe(false)
    })

    it('rejects missing and invalid accuracy values', () => {
        expect(isCustomerCityAccuracyAcceptable(undefined)).toBe(false)
        expect(isCustomerCityAccuracyAcceptable(null)).toBe(false)
        expect(isCustomerCityAccuracyAcceptable(Number.NaN)).toBe(false)
        expect(isCustomerCityAccuracyAcceptable(-1)).toBe(false)
        expect(isCustomerCityAccuracyAcceptable("50")).toBe(false)
    })

    it('uses a configurable threshold with a safe default', () => {
        expect(DEFAULT_CUSTOMER_CITY_MAX_ACCURACY_METERS).toBe(5000)
        expect(resolveCustomerCityMaxAccuracyMeters(undefined)).toBe(5000)
        expect(resolveCustomerCityMaxAccuracyMeters("")).toBe(5000)
        expect(resolveCustomerCityMaxAccuracyMeters("garbage")).toBe(5000)
        expect(resolveCustomerCityMaxAccuracyMeters(0)).toBe(5000)
        expect(resolveCustomerCityMaxAccuracyMeters("2500")).toBe(2500)
        expect(isCustomerCityAccuracyAcceptable(3000, 2500)).toBe(false)
        expect(isCustomerCityAccuracyAcceptable(2000, 2500)).toBe(true)
    })

    it('accepts exactly the configured limit', () => {
        expect(isCustomerCityAccuracyAcceptable(5000, 5000)).toBe(true)
    })
})