import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import axios from '../utils/axiosInstance'
import CheckOut from './CheckOut'
import OrderPlaced from './OrderPlaced'
import { renderWithProviders } from '../test/testUtils'

vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }) => <div data-testid='map'>{children}</div>,
    TileLayer: () => null,
    Marker: () => null,
    useMap: () => ({ setView: () => {} })
}))

vi.mock('../utils/axiosInstance', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn()
    }
}))

const activeDiscount = {
    type: 'percentage',
    value: 20,
    startDate: '2020-01-01T00:00:00.000Z',
    endDate: '2099-12-31T23:59:59.999Z',
    enabled: true
}

const discountedItem = {
    _id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    price: 200,
    shop: 'shop-1',
    foodType: 'veg',
    isAvailable: true,
    discount: activeDiscount
}

const plainItem = {
    _id: 'item-2',
    name: 'Water',
    image: 'water.jpg',
    price: 100,
    shop: 'shop-1',
    foodType: 'veg',
    isAvailable: true
}

const discountedCartLine = {
    id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    shop: 'shop-1',
    foodType: 'veg',
    quantity: 2,
    price: 160,
    originalPrice: 200,
    discountType: 'percentage',
    discountValue: 20,
    discountAmount: 40,
    finalPrice: 160,
    discountApplied: true,
    isAvailable: true
}

const plainCartLine = {
    id: 'item-2',
    name: 'Water',
    image: 'water.jpg',
    shop: 'shop-1',
    foodType: 'veg',
    quantity: 1,
    price: 100,
    originalPrice: 100,
    discountType: '',
    discountValue: 0,
    discountAmount: 0,
    finalPrice: 100,
    discountApplied: false,
    isAvailable: true
}

const renderCheckout = (cartItems, mapState = { location: { lat: 18.5204, lon: 73.8567 }, address: 'Stage Five Test Address, FC Road, Pune' }) => renderWithProviders(null, {
    route: '/checkout',
    preloaded: { user: { cartItems }, map: mapState },
    routes: [
        { path: '/checkout', element: <CheckOut /> },
        { path: '/order-placed', element: <OrderPlaced /> }
    ]
})

const waitForCheckoutReady = async () => {
    const button = await screen.findByRole('button', { name: 'Place Order' })
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('false'))
    return button
}

describe('Checkout discount pricing', () => {
    beforeEach(() => {
        axios.get.mockReset()
        axios.post.mockReset()
        axios.get.mockImplementation((url) => {
            if (url.includes('item-1')) {
                return Promise.resolve({ data: discountedItem })
            }
            if (url.includes('item-2')) {
                return Promise.resolve({ data: plainItem })
            }
            return Promise.reject(new Error('unexpected request'))
        })
    })

    it('displays discounted line items, subtotal, delivery fee and total', async () => {
        renderCheckout([discountedCartLine, plainCartLine])
        await waitForCheckoutReady()

        expect(screen.getByText('20% OFF')).toBeTruthy()
        expect(screen.getByText('Subtotal after discounts')).toBeTruthy()
        expect(screen.getByText('₹420')).toBeTruthy()
        expect(screen.getByText('Discount savings')).toBeTruthy()
        expect(screen.getByText('-₹80')).toBeTruthy()
        expect(screen.getByText('₹40')).toBeTruthy()
        expect(screen.getByText('₹460')).toBeTruthy()
        expect(screen.getByText(/confirmed by the server/)).toBeTruthy()
    })

    it('sends only item ids, shops and quantities to the backend and shows the server total', async () => {
        axios.post.mockResolvedValue({
            data: {
                _id: 'order-1',
                paymentMethod: 'cod',
                totalAmount: 450,
                shopOrders: []
            }
        })
        renderCheckout([discountedCartLine, plainCartLine])
        const button = await waitForCheckoutReady()
        fireEvent.click(button)

        await screen.findByText('Order Placed!')
        expect(screen.getByText('₹450')).toBeTruthy()
        expect(screen.getByText(/recalculated by the server/)).toBeTruthy()

        const payload = axios.post.mock.calls[0][1]
        expect(payload.totalAmount).toBeUndefined()
        expect(payload.cartItems).toEqual([
            { id: 'item-1', shop: 'shop-1', quantity: 2 },
            { id: 'item-2', shop: 'shop-1', quantity: 1 }
        ])
    })

    it('shows a checkout API failure and allows another attempt', async () => {
        axios.post.mockRejectedValue({ response: { data: { message: 'cart is empty' } } })
        renderCheckout([discountedCartLine])
        const button = await waitForCheckoutReady()
        fireEvent.click(button)

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('cart is empty')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Place Order' }).getAttribute('aria-disabled')).toBe('false'))
    })

    it('preserves checkout without discounts', async () => {
        renderCheckout([plainCartLine])
        await waitForCheckoutReady()

        expect(screen.getAllByText('₹100').length).toBeGreaterThan(0)
        expect(screen.queryByText('Discount savings')).toBeNull()
        expect(screen.getByText('₹40')).toBeTruthy()
        expect(screen.getByText('₹140')).toBeTruthy()
    })
})

describe('Checkout location safety', () => {
    beforeEach(() => {
        axios.get.mockReset()
        axios.post.mockReset()
        axios.get.mockImplementation((url) => {
            if (url.includes('item-1')) return Promise.resolve({ data: discountedItem })
            if (url.includes('item-2')) return Promise.resolve({ data: plainItem })
            return Promise.reject(new Error('unexpected request'))
        })
    })

    const nullLocationCases = [
        ['null location', { location: null, address: null }],
        ['missing latitude', { location: { lat: null, lon: 73.8567 }, address: null }],
        ['missing longitude', { location: { lat: 18.5204, lon: null }, address: null }],
        ['invalid coordinates', { location: { lat: 999, lon: 999 }, address: null }],
    ]

    nullLocationCases.forEach(([label, mapState]) => {
        it(`renders checkout with ${label} without crashing`, async () => {
            renderCheckout([discountedCartLine], mapState)
            expect(await screen.findByText('Checkout')).toBeTruthy()
            expect(screen.getByRole('button', { name: 'Place Order' })).toBeTruthy()
            expect(screen.getByText(/Enter an address or use your current location/)).toBeTruthy()
            expect(screen.getByRole('button', { name: 'Place Order' }).getAttribute('aria-disabled')).toBe('true')
        })
    })

    it('allows manual address entry with null location', async () => {
        renderCheckout([discountedCartLine], { location: { lat: null, lon: null }, address: null })
        const input = await screen.findByPlaceholderText('Enter Your Delivery Address..')
        fireEvent.change(input, { target: { value: 'Manual test address, Pune' } })
        expect(input.value).toBe('Manual test address, Pune')
        expect(screen.getByRole('button', { name: 'Place Order' }).getAttribute('aria-disabled')).toBe('true')
    })

    it('keeps Place Order disabled when geolocation is denied and no valid location exists', async () => {
        renderCheckout([discountedCartLine], { location: { lat: null, lon: null }, address: null })
        expect(screen.getByRole('button', { name: 'Place Order' }).getAttribute('aria-disabled')).toBe('true')
    })

    it('restores checkout behavior with a valid location', async () => {
        renderCheckout([discountedCartLine])
        await waitForCheckoutReady()
        expect(screen.getByRole('button', { name: 'Place Order' }).getAttribute('aria-disabled')).toBe('false')
    })
})
