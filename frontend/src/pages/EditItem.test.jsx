import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import axios from '../utils/axiosInstance'
import EditItem from './EditItem'
import { renderWithProviders } from '../test/testUtils'

vi.mock('../utils/axiosInstance', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn()
    }
}))

const existingItem = {
    _id: 'item-1',
    name: 'Paneer Pizza',
    image: 'pizza.jpg',
    price: 200,
    category: 'Pizza',
    foodType: 'veg',
    discount: {
        type: 'percentage',
        value: 20,
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-06-30T23:59:59.999Z',
        enabled: true
    }
}

const renderEditItem = () => renderWithProviders(null, {
    route: '/edit-item/item-1',
    routes: [{ path: '/edit-item/:itemId', element: <EditItem /> }]
})

const waitForItem = async () => {
    await screen.findByDisplayValue('Paneer Pizza')
    expect(screen.getByLabelText('Discount').value).toBe('percentage')
}

const submit = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

const submittedDiscount = () => JSON.parse(axios.post.mock.calls[0][1].get('discount'))

describe('EditItem discount management', () => {
    beforeEach(() => {
        axios.get.mockReset()
        axios.post.mockReset()
        axios.get.mockImplementation((url) => {
            if (url.includes('/api/shop/get-my')) {
                return Promise.reject(new Error('shop unavailable'))
            }
            return Promise.resolve({ data: existingItem })
        })
        axios.post.mockResolvedValue({ data: existingItem })
    })

    it('populates the existing discount and updates its value', async () => {
        renderEditItem()
        await waitForItem()

        fireEvent.change(screen.getByLabelText('Discount percentage'), { target: { value: '25' } })
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(submittedDiscount()).toMatchObject({
            type: 'percentage',
            value: 25,
            enabled: true
        })
    })

    it('disables an existing discount without clearing it', async () => {
        renderEditItem()
        await waitForItem()

        fireEvent.click(screen.getByLabelText('Discount enabled'))
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(submittedDiscount()).toMatchObject({
            type: 'percentage',
            value: 20,
            enabled: false
        })
    })

    it('clears the discount with the backend-supported empty multipart field', async () => {
        renderEditItem()
        await waitForItem()

        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'none' } })
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(axios.post.mock.calls[0][1].get('discount')).toBe('')
    })

    it('revalidates a fixed discount against the price', async () => {
        renderEditItem()
        await waitForItem()

        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'fixed' } })
        fireEvent.change(screen.getByLabelText('Discount amount (₹)'), { target: { value: '250' } })
        submit()

        expect(screen.getByText('Fixed discount cannot exceed the item price')).toBeTruthy()
        expect(axios.post).not.toHaveBeenCalled()
    })

    it('shows an API failure message', async () => {
        axios.post.mockRejectedValue({
            response: { data: { message: 'discount end date must be later than the start date' } }
        })
        renderEditItem()
        await waitForItem()
        submit()

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('discount end date must be later than the start date')
    })
})
