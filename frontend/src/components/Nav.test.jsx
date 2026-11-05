import React from 'react'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { setCurrentCity } from '../redux/userSlice'
import Nav from './Nav'
import { renderWithProviders } from '../test/testUtils'

describe('Nav header location', () => {
    it('renders the current city from shared Redux state', () => {
        renderWithProviders(<Nav />, {
            preloaded: {
                user: {
                    userData: { _id: 'u1', role: 'user', fullName: 'Test User' },
                    currentCity: 'Dongaon'
                }
            }
        })

        expect(screen.getAllByText('Dongaon').length).toBeGreaterThan(0)
    })

    it('updates the header when the shared location state changes', async () => {
        const { store } = renderWithProviders(<Nav />, {
            preloaded: {
                user: {
                    userData: { _id: 'u1', role: 'user', fullName: 'Test User' },
                    currentCity: 'Pune'
                }
            }
        })

        store.dispatch(setCurrentCity('Dongaon'))

        await waitFor(() => {
            expect(screen.getAllByText('Dongaon').length).toBeGreaterThan(0)
        })
    })
})