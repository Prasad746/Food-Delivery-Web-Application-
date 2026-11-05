import React from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import FoodCard from './FoodCard'
import { renderWithProviders } from '../test/testUtils'

const baseItem = {
    _id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    price: 200,
    foodType: 'veg',
    shop: 'shop-1',
    rating: { average: 4, count: 12 }
}

const discount = (overrides = {}) => ({
    type: 'percentage',
    value: 20,
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2099-12-31T23:59:59.999Z',
    enabled: true,
    ...overrides
})

const renderCard = (data, preloaded) => renderWithProviders(<FoodCard data={data} />, { preloaded })

describe('FoodCard discount display', () => {
    it('shows original and discounted prices for an active percentage discount', () => {
        renderCard({ ...baseItem, discount: discount() })
        expect(screen.getByText('₹160')).toBeTruthy()
        expect(screen.getByText('₹200')).toBeTruthy()
        expect(screen.getByText('20% OFF')).toBeTruthy()
        expect(screen.getByText('You save ₹40')).toBeTruthy()
    })

    it('shows a fixed discount label and price', () => {
        renderCard({ ...baseItem, discount: discount({ type: 'fixed', value: 30 }) })
        expect(screen.getByText('₹170')).toBeTruthy()
        expect(screen.getByText('₹30 OFF')).toBeTruthy()
    })

    it('does not show a disabled discount as active', () => {
        renderCard({ ...baseItem, discount: discount({ enabled: false }) })
        expect(screen.getByText('₹200')).toBeTruthy()
        expect(screen.queryByText('20% OFF')).toBeNull()
        expect(screen.queryByText(/You save/)).toBeNull()
    })

    it('does not show a scheduled discount before its start date', () => {
        renderCard({ ...baseItem, discount: discount({ startDate: '2099-01-01T00:00:00.000Z' }) })
        expect(screen.getByText('₹200')).toBeTruthy()
        expect(screen.queryByText('20% OFF')).toBeNull()
    })

    it('does not show an expired discount as active', () => {
        renderCard({ ...baseItem, discount: discount({ endDate: '2020-01-02T00:00:00.000Z' }) })
        expect(screen.getByText('₹200')).toBeTruthy()
        expect(screen.queryByText('20% OFF')).toBeNull()
    })

    it('handles missing discount data safely', () => {
        renderCard(baseItem)
        expect(screen.getByText('₹200')).toBeTruthy()
        expect(screen.queryByText(/OFF/)).toBeNull()
    })

    it('adds the discounted price and snapshot fields to the cart', () => {
        const { store } = renderCard({ ...baseItem, discount: discount() })
        fireEvent.click(screen.getByLabelText('Increase quantity'))
        fireEvent.click(screen.getByLabelText('Add item to cart'))

        const [cartItem] = store.getState().user.cartItems
        expect(cartItem).toMatchObject({
            id: 'item-1',
            quantity: 1,
            price: 160,
            originalPrice: 200,
            discountType: 'percentage',
            discountValue: 20,
            discountAmount: 40,
            finalPrice: 160,
            shop: 'shop-1'
        })
        expect(store.getState().user.totalAmount).toBe(160)
    })

    it('preserves the selected quantity when adding the same item again', () => {
        const { store } = renderCard({ ...baseItem, discount: discount() })
        fireEvent.click(screen.getByLabelText('Increase quantity'))
        fireEvent.click(screen.getByLabelText('Add item to cart'))
        fireEvent.click(screen.getByLabelText('Add item to cart'))

        expect(store.getState().user.cartItems).toHaveLength(1)
        expect(store.getState().user.cartItems[0].quantity).toBe(2)
        expect(store.getState().user.totalAmount).toBe(320)
    })
})
