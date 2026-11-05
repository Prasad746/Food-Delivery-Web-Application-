import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { renderHook, waitFor } from '@testing-library/react'
import axios from 'axios'
import useGetCity from './useGetCity'
import { createTestStore } from '../test/testUtils'

vi.mock('axios', () => ({
    default: {
        get: vi.fn()
    }
}))

const renderCityHook = (preloaded = {}) => {
    const store = createTestStore({ user: preloaded })
    const wrapper = ({ children }) => <Provider store={store}>{children}</Provider>
    const hook = renderHook(() => useGetCity(), { wrapper })
    return { ...hook, store }
}

const mockGeolocation = (implementation) => {
    Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
            getCurrentPosition: vi.fn(implementation)
        }
    })
}

describe('useGetCity accuracy handling', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('accepts accurate GPS and stores the reverse-geocoded city as GPS', async () => {
        mockGeolocation((success) => success({
            coords: { latitude: 18.5, longitude: 73.8, accuracy: 100 }
        }))
        axios.get.mockResolvedValue({
            data: { results: [{ city: 'Accurate City', state: 'State', address_line2: 'Accurate address' }] }
        })

        const { store } = renderCityHook({
            userData: { _id: 'u1', role: 'user' }
        })

        await waitFor(() => {
            expect(store.getState().user.currentCity).toBe('Accurate City')
        })
        expect(store.getState().user.currentCitySource).toBe('gps')
    })

    it('rejects inaccurate GPS before reverse geocoding', async () => {
        mockGeolocation((success) => success({
            coords: { latitude: 18.5442, longitude: 73.8798, accuracy: 200000 }
        }))

        const { store } = renderCityHook({
            userData: { _id: 'u1', role: 'user' }
        })

        await waitFor(() => {
            expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled()
        })
        expect(axios.get).not.toHaveBeenCalled()
        expect(store.getState().user.currentCity).toBeNull()
        expect(store.getState().user.currentCitySource).toBeNull()
    })

    it('leaves the city unset when permission is denied', async () => {
        mockGeolocation((success, failure) => failure({ code: 1 }))

        const { store } = renderCityHook({
            userData: { _id: 'u1', role: 'user' }
        })

        await waitFor(() => {
            expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled()
        })
        expect(store.getState().user.currentCity).toBeNull()
    })

    it('leaves the city unset on timeout', async () => {
        mockGeolocation((success, failure) => failure({ code: 3 }))

        const { store } = renderCityHook({
            userData: { _id: 'u1', role: 'user' }
        })

        await waitFor(() => {
            expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled()
        })
        expect(store.getState().user.currentCity).toBeNull()
    })

    it('does not run GPS or overwrite a manually selected city', async () => {
        const getCurrentPosition = vi.fn()
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: { getCurrentPosition }
        })

        const { store } = renderCityHook({
            userData: { _id: 'u1', role: 'user' },
            currentCity: 'Selected City',
            currentCitySource: 'manual'
        })

        await waitFor(() => {
            expect(store.getState().user.currentCity).toBe('Selected City')
        })
        expect(getCurrentPosition).not.toHaveBeenCalled()
        expect(axios.get).not.toHaveBeenCalled()
    })
})