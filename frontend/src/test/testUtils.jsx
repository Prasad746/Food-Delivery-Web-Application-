import React from 'react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render } from '@testing-library/react'
import userReducer from '../redux/userSlice'
import ownerReducer from '../redux/ownerSlice'
import mapReducer from '../redux/mapSlice'

const userInitial = userReducer(undefined, { type: '@@INIT' })
const ownerInitial = ownerReducer(undefined, { type: '@@INIT' })
const mapInitial = mapReducer(undefined, { type: '@@INIT' })

export const createTestStore = (preloaded = {}) => configureStore({
    reducer: {
        user: userReducer,
        owner: ownerReducer,
        map: mapReducer
    },
    preloadedState: {
        user: { ...userInitial, ...(preloaded.user || {}) },
        owner: { ...ownerInitial, ...(preloaded.owner || {}) },
        map: { ...mapInitial, ...(preloaded.map || {}) }
    }
})

export const renderWithProviders = (ui, options = {}) => {
    const store = options.store || createTestStore(options.preloaded)
    const route = options.route || '/'
    const routes = options.routes

    const content = routes ? (
        <Routes>
            {routes.map(({ path, element }) => (
                <Route key={path} path={path} element={element} />
            ))}
        </Routes>
    ) : ui

    return {
        store,
        ...render(
            <Provider store={store}>
                <MemoryRouter initialEntries={[route]}>
                    {content}
                </MemoryRouter>
            </Provider>
        )
    }
}
