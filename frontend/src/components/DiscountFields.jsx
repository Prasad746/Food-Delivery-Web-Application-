import React from 'react'

const inputClass = 'w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500'

function DiscountFields({ value, onChange, errors = {} }) {
    const update = (patch) => {
        onChange({ ...value, ...patch })
    }

    return (
        <div className='border-t border-orange-100 pt-5 space-y-4'>
            <div>
                <label htmlFor='discount-type' className='block text-sm font-medium text-gray-700 mb-1'>
                    Discount
                </label>
                <select
                    id='discount-type'
                    className={inputClass}
                    value={value.type}
                    onChange={(event) => update({ type: event.target.value })}
                >
                    <option value='none'>No discount</option>
                    <option value='percentage'>Percentage discount</option>
                    <option value='fixed'>Fixed amount discount</option>
                </select>
                {errors.type && <p className='mt-1 text-sm text-red-600'>{errors.type}</p>}
            </div>

            {value.type !== 'none' && (
                <>
                    <div>
                        <label htmlFor='discount-value' className='block text-sm font-medium text-gray-700 mb-1'>
                            {value.type === 'percentage' ? 'Discount percentage' : 'Discount amount (₹)'}
                        </label>
                        <input
                            id='discount-value'
                            type='number'
                            min='0'
                            step='0.01'
                            inputMode='decimal'
                            placeholder={value.type === 'percentage' ? 'e.g. 20' : 'e.g. 30'}
                            className={inputClass}
                            value={value.value}
                            onChange={(event) => update({ value: event.target.value })}
                        />
                        {errors.value && <p className='mt-1 text-sm text-red-600'>{errors.value}</p>}
                    </div>

                    <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                        <div>
                            <label htmlFor='discount-start' className='block text-sm font-medium text-gray-700 mb-1'>
                                Start date (optional)
                            </label>
                            <input
                                id='discount-start'
                                type='date'
                                className={inputClass}
                                value={value.startDate}
                                onChange={(event) => update({ startDate: event.target.value })}
                            />
                            {errors.startDate && <p className='mt-1 text-sm text-red-600'>{errors.startDate}</p>}
                        </div>
                        <div>
                            <label htmlFor='discount-end' className='block text-sm font-medium text-gray-700 mb-1'>
                                End date (optional)
                            </label>
                            <input
                                id='discount-end'
                                type='date'
                                className={inputClass}
                                value={value.endDate}
                                onChange={(event) => update({ endDate: event.target.value })}
                            />
                            {errors.endDate && <p className='mt-1 text-sm text-red-600'>{errors.endDate}</p>}
                        </div>
                    </div>

                    <p className='text-xs text-gray-500'>
                        Leave the dates empty for an always-on discount. The end date includes the full selected day.
                    </p>

                    <label htmlFor='discount-enabled' className='flex items-center gap-3 text-sm font-medium text-gray-700'>
                        <input
                            id='discount-enabled'
                            type='checkbox'
                            className='h-4 w-4 accent-[#ff4d2d]'
                            checked={value.enabled !== false}
                            onChange={(event) => update({ enabled: event.target.checked })}
                        />
                        Discount enabled
                    </label>
                </>
            )}
        </div>
    )
}

export default DiscountFields
