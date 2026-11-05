import { describe, expect, it } from 'vitest'
import userReducer, {
    addToCart,
    clearCurrentCitySelection,
    setCurrentCity,
    setCurrentCitySource,
    setManualCurrentCity,
    syncCartItems,
    updateQuantity
} from './userSlice'

const initial = () => userReducer(undefined, { type: '@@INIT' })

const discountedLine = {
    id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    shop: 'shop-1',
    foodType: 'veg',
    quantity: 1,
    price: 160,
    originalPrice: 200,
    discountType: 'percentage',
    discountValue: 20,
    discountAmount: 40,
    finalPrice: 160,
    discountApplied: true
}

describe('cart discount state', () => {
    it('adds a discounted item with its snapshot fields', () => {
        const state = userReducer(initial(), addToCart(discountedLine))
        expect(state.cartItems).toHaveLength(1)
        expect(state.cartItems[0]).toMatchObject({
            price: 160,
            originalPrice: 200,
            discountType: 'percentage',
            discountAmount: 40,
            quantity: 1
        })
        expect(state.totalAmount).toBe(160)
    })

    it('updates stale pricing on re-add without changing the selected quantity', () => {
        let state = userReducer(initial(), addToCart(discountedLine))
        state = userReducer(state, addToCart({
            ...discountedLine,
            price: 150,
            finalPrice: 150,
            discountAmount: 50,
            discountType: 'fixed',
            discountValue: 50,
            quantity: 1
        }))
        expect(state.cartItems).toHaveLength(1)
        expect(state.cartItems[0].quantity).toBe(2)
        expect(state.cartItems[0].price).toBe(150)
        expect(state.cartItems[0].discountType).toBe('fixed')
        expect(state.totalAmount).toBe(300)
    })

    it('refreshes prices through syncCartItems while preserving quantity', () => {
        let state = userReducer(initial(), addToCart({ ...discountedLine, quantity: 3 }))
        state = userReducer(state, syncCartItems([{
            id: 'item-1',
            price: 180,
            finalPrice: 180,
            originalPrice: 200,
            discountType: 'fixed',
            discountValue: 20,
            discountAmount: 20,
            isAvailable: true
        }]))
        expect(state.cartItems[0].quantity).toBe(3)
        expect(state.cartItems[0].price).toBe(180)
        expect(state.cartItems[0].discountType).toBe('fixed')
        expect(state.totalAmount).toBe(540)
    })

    it('marks unavailable items without removing them or their quantity', () => {
        let state = userReducer(initial(), addToCart({ ...discountedLine, quantity: 2 }))
        state = userReducer(state, syncCartItems([{ id: 'item-1', isAvailable: false }]))
        expect(state.cartItems[0].quantity).toBe(2)
        expect(state.cartItems[0].isAvailable).toBe(false)
    })

    it('clamps quantity updates and recalculates totals from the discounted unit price', () => {
        let state = userReducer(initial(), addToCart(discountedLine))
        state = userReducer(state, updateQuantity({ id: 'item-1', quantity: 500 }))
        expect(state.cartItems[0].quantity).toBe(99)
        expect(state.totalAmount).toBe(15840)
    })

    it('handles missing price data without producing a misleading total', () => {
        const state = userReducer(initial(), addToCart({
            id: 'item-2',
            name: 'Unknown price',
            shop: 'shop-1',
            quantity: 1
        }))
        expect(state.totalAmount).toBe(0)
    })
})

describe('customer city selection state', () => {
    it('stores a manually selected city and marks its source', () => {
        const state = userReducer(initial(), setManualCurrentCity({
            city: 'Selected City',
            state: 'Selected State',
            address: 'Selected address'
        }))

        expect(state.currentCity).toBe('Selected City')
        expect(state.currentState).toBe('Selected State')
        expect(state.currentAddress).toBe('Selected address')
        expect(state.currentCitySource).toBe('manual')
    })

    it('clears a manual selection so GPS can run again', () => {
        let state = userReducer(initial(), setManualCurrentCity({ city: 'Selected City' }))
        state = userReducer(state, clearCurrentCitySelection())

        expect(state.currentCity).toBeNull()
        expect(state.currentState).toBeNull()
        expect(state.currentAddress).toBeNull()
        expect(state.currentCitySource).toBeNull()
    })

    it('tracks whether a city came from GPS', () => {
        let state = userReducer(initial(), setCurrentCity('GPS City'))
        state = userReducer(state, setCurrentCitySource('gps'))

        expect(state.currentCity).toBe('GPS City')
        expect(state.currentCitySource).toBe('gps')
    })
})
