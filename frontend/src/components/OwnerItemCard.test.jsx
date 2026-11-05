import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import OwnerItemCard from './OwnerItemCard'
import { renderWithProviders } from '../test/testUtils'

vi.mock('../utils/axiosInstance', () => ({
    default: {
        delete: vi.fn()
    }
}))

const baseItem = {
    _id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    price: 200,
    category: 'Pizza',
    foodType: 'veg',
    shop: 'shop-1'
}

const discount = (overrides = {}) => ({
    type: 'percentage',
    value: 20,
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2099-12-31T23:59:59.999Z',
    enabled: true,
    ...overrides
})

describe('OwnerItemCard discount status', () => {
    it('shows an active discount with original and discounted prices', () => {
        renderWithProviders(<OwnerItemCard data={{ ...baseItem, discount: discount() }} />)
        expect(screen.getByText('Active')).toBeTruthy()
        expect(screen.getByText('20% OFF')).toBeTruthy()
        expect(screen.getByText('Configured: 20% off')).toBeTruthy()
        expect(screen.getByText('Original price ₹200')).toBeTruthy()
        expect(screen.getByText('₹160')).toBeTruthy()
    })

    it('labels a scheduled discount without presenting it as active', () => {
        renderWithProviders(<OwnerItemCard data={{
            ...baseItem,
            discount: discount({ startDate: '2099-01-01T00:00:00.000Z' })
        }} />)
        expect(screen.getByText('Scheduled')).toBeTruthy()
        expect(screen.queryByText('Active')).toBeNull()
        expect(screen.getByText('₹200')).toBeTruthy()
    })

    it('labels an expired discount without presenting it as active', () => {
        renderWithProviders(<OwnerItemCard data={{
            ...baseItem,
            discount: discount({ endDate: '2020-01-02T00:00:00.000Z' })
        }} />)
        expect(screen.getByText('Expired')).toBeTruthy()
        expect(screen.queryByText('Active')).toBeNull()
    })

    it('labels a disabled discount', () => {
        renderWithProviders(<OwnerItemCard data={{
            ...baseItem,
            discount: discount({ enabled: false })
        }} />)
        expect(screen.getByText('Disabled')).toBeTruthy()
        expect(screen.queryByText('Active')).toBeNull()
    })

    it('handles items without any discount', () => {
        renderWithProviders(<OwnerItemCard data={baseItem} />)
        expect(screen.getByText('No discount')).toBeTruthy()
        expect(screen.getByText('No discount configured')).toBeTruthy()
        expect(screen.getByText('Original price ₹200')).toBeTruthy()
    })
})
