import React from 'react'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import UserOrderCard from './UserOrderCard'
import { renderWithProviders } from '../test/testUtils'

const snapshotItem = {
    _id: 'shop-order-item-1',
    name: 'Paneer Pizza',
    quantity: 2,
    price: 170,
    originalPrice: 200,
    discountType: 'percentage',
    discountValue: 20,
    discountAmount: 30,
    finalPrice: 170,
    item: {
        _id: 'item-1',
        name: 'Paneer Pizza',
        image: 'pizza.jpg',
        price: 999
    }
}

const order = (shopOrderItems, subtotal = 340) => ({
    _id: 'order-123456',
    createdAt: '2026-06-15T10:00:00.000Z',
    paymentMethod: 'cod',
    totalAmount: subtotal,
    shopOrders: [{
        _id: 'shop-order-1',
        shop: { _id: 'shop-1', name: 'Pizza Palace' },
        status: 'pending',
        shopOrderItems,
        subtotal
    }]
})

describe('UserOrderCard historical pricing', () => {
    it('renders historical snapshot prices instead of current item prices', () => {
        renderWithProviders(<UserOrderCard data={order([snapshotItem])} />)
        expect(screen.getByText('Qty: 2 x ₹170')).toBeTruthy()
        expect(screen.getByText('Original: ₹200')).toBeTruthy()
        expect(screen.getByText('20% OFF · Saved ₹30')).toBeTruthy()
        expect(screen.queryByText(/999/)).toBeNull()
        expect(screen.getByText('Total: ₹340')).toBeTruthy()
    })

    it('renders legacy orders without inventing a discount', () => {
        renderWithProviders(<UserOrderCard data={order([{
            name: 'Water',
            quantity: 1,
            price: 120
        }], 120)} />)
        expect(screen.getByText('Qty: 1 x ₹120')).toBeTruthy()
        expect(screen.queryByText(/Original:/)).toBeNull()
        expect(screen.queryByText(/Saved/)).toBeNull()
    })
})
