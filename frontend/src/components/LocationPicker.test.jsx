import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import axios from '../utils/axiosInstance'
import LocationPicker from './LocationPicker'
import { renderWithProviders } from '../test/testUtils'

vi.mock('../utils/axiosInstance', () => ({
    default: {
        get: vi.fn()
    }
}))

describe('LocationPicker', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('shows a manual city selection when no city is available', () => {
        renderWithProviders(<LocationPicker />, {
            preloaded: { user: { currentCity: null } }
        })

        expect(screen.getByRole('button', { name: /select delivery location/i })).toBeTruthy()
    })

    it('searches and stores a manually selected city', async () => {
        axios.get.mockResolvedValue({
            data: {
                results: [{
                    city: 'Selected City',
                    state: 'Selected State',
                    address_line2: 'Selected address',
                    lat: 18.5,
                    lon: 73.8
                }]
            }
        })

        const { store } = renderWithProviders(<LocationPicker />, {
            preloaded: { user: { currentCity: null } }
        })

        fireEvent.click(screen.getByRole('button', { name: /select delivery location/i }))
        fireEvent.change(screen.getByLabelText(/search city or area/i), { target: { value: 'Selected' } })
        fireEvent.click(screen.getByRole('button', { name: /^search$/i }))

        await waitFor(() => {
            expect(screen.getByText('Selected City')).toBeTruthy()
        })

        fireEvent.click(screen.getByText('Selected City'))

        expect(store.getState().user.currentCity).toBe('Selected City')
        expect(store.getState().user.currentCitySource).toBe('manual')
        expect(store.getState().map.location).toEqual({ lat: 18.5, lon: 73.8 })
    })

    it('can clear a manual city so GPS may run again', () => {
        const { store } = renderWithProviders(<LocationPicker />, {
            preloaded: {
                user: {
                    currentCity: 'Selected City',
                    currentCitySource: 'manual'
                }
            }
        })

        fireEvent.click(screen.getByRole('button', { name: /selected city/i }))
        fireEvent.click(screen.getByRole('button', { name: /use my current location/i }))

        expect(store.getState().user.currentCity).toBeNull()
        expect(store.getState().user.currentCitySource).toBeNull()
    })
})