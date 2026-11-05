import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import axios from '../utils/axiosInstance'
import AddItem from './AddItem'
import { renderWithProviders } from '../test/testUtils'

vi.mock('../utils/axiosInstance', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn()
    }
}))

const fillRequiredFields = () => {
    fireEvent.change(screen.getByPlaceholderText('Enter Food Name'), { target: { value: 'Paneer Pizza' } })
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '200' } })
    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'Pizza' } })
}

const submit = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

const submittedFormData = () => axios.post.mock.calls[0][1]

describe('AddItem discount management', () => {
    beforeEach(() => {
        axios.get.mockReset()
        axios.post.mockReset()
        axios.post.mockResolvedValue({ data: { _id: 'shop-1', items: [] } })
    })

    it('creates an item without a discount field', async () => {
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(submittedFormData().get('discount')).toBeNull()
    })

    it('creates an item with a percentage discount and schedule', async () => {
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'percentage' } })
        fireEvent.change(screen.getByLabelText('Discount percentage'), { target: { value: '20' } })
        fireEvent.change(screen.getByLabelText('Start date (optional)'), { target: { value: '2026-06-10' } })
        fireEvent.change(screen.getByLabelText('End date (optional)'), { target: { value: '2026-06-12' } })
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(JSON.parse(submittedFormData().get('discount'))).toEqual({
            type: 'percentage',
            value: 20,
            startDate: '2026-06-10T00:00:00.000Z',
            endDate: '2026-06-12T23:59:59.999Z',
            enabled: true
        })
    })

    it('creates an item with a fixed discount and disabled status', async () => {
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'fixed' } })
        fireEvent.change(screen.getByLabelText('Discount amount (₹)'), { target: { value: '30' } })
        fireEvent.click(screen.getByLabelText('Discount enabled'))
        submit()

        await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
        expect(JSON.parse(submittedFormData().get('discount'))).toMatchObject({
            type: 'fixed',
            value: 30,
            startDate: null,
            endDate: null,
            enabled: false
        })
    })

    it('blocks a fixed discount above the item price', () => {
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'fixed' } })
        fireEvent.change(screen.getByLabelText('Discount amount (₹)'), { target: { value: '250' } })
        submit()

        expect(screen.getByText('Fixed discount cannot exceed the item price')).toBeTruthy()
        expect(axios.post).not.toHaveBeenCalled()
    })

    it('blocks an invalid date range', () => {
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'percentage' } })
        fireEvent.change(screen.getByLabelText('Discount percentage'), { target: { value: '20' } })
        fireEvent.change(screen.getByLabelText('Start date (optional)'), { target: { value: '2026-06-10' } })
        fireEvent.change(screen.getByLabelText('End date (optional)'), { target: { value: '2026-06-09' } })
        submit()

        expect(screen.getByText('End date must be after the start date')).toBeTruthy()
        expect(axios.post).not.toHaveBeenCalled()
    })

    it('shows an API failure message', async () => {
        axios.post.mockRejectedValue({ response: { data: { message: 'Invalid item data' } } })
        renderWithProviders(<AddItem />)
        fillRequiredFields()
        submit()

        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('Invalid item data')
    })
})
