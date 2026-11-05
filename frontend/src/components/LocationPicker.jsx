import React, { useState } from 'react'
import { FaLocationDot } from 'react-icons/fa6'
import { IoClose } from 'react-icons/io5'
import { useDispatch, useSelector } from 'react-redux'
import axios from '../utils/axiosInstance'
import { clearCurrentCitySelection, setManualCurrentCity } from '../redux/userSlice'
import { setAddress, setLocation } from '../redux/mapSlice'

function LocationPicker() {
    const dispatch = useDispatch()
    const { currentCity, currentCitySource } = useSelector(state => state.user)
    const [isOpen, setIsOpen] = useState(false)
    const [query, setQuery] = useState("")
    const [results, setResults] = useState([])
    const [status, setStatus] = useState("idle")
    const [error, setError] = useState("")
    const apiKey = import.meta.env.VITE_GEOAPIKEY

    const openPicker = () => {
        setIsOpen(true)
        setError("")
    }

    const closePicker = () => {
        setIsOpen(false)
    }

    const handleSearch = async (event) => {
        event.preventDefault()
        const text = query.trim()
        if (!text) {
            setResults([])
            setStatus("idle")
            return
        }
        setStatus("loading")
        setError("")
        try {
            const response = await axios.get("https://api.geoapify.com/v1/geocode/search", {
                params: {
                    text,
                    format: "json",
                    limit: 5,
                    apiKey
                }
            })
            setResults(response?.data?.results || [])
            setStatus("success")
        } catch {
            setResults([])
            setStatus("error")
            setError("Unable to search locations right now. Please try again.")
        }
    }

    const selectPlace = (place) => {
        const city = place?.city || place?.county || place?.name
        if (!city) {
            return
        }
        dispatch(setManualCurrentCity({
            city,
            state: place?.state || null,
            address: place?.address_line2 || place?.address_line1 || null
        }))
        if (Number.isFinite(place?.lat) && Number.isFinite(place?.lon)) {
            dispatch(setLocation({ lat: place.lat, lon: place.lon }))
        }
        dispatch(setAddress(place?.address_line2 || place?.address_line1 || null))
        setIsOpen(false)
    }

    const useCurrentLocation = () => {
        dispatch(clearCurrentCitySelection())
        setIsOpen(false)
    }

    const label = currentCity || "Select location"

    return (
        <>
            <button
                type="button"
                className="flex min-w-0 items-center gap-[10px] text-left"
                onClick={openPicker}
                aria-label={currentCity ? `Selected city ${currentCity}. Change location` : "Select delivery location"}
            >
                <FaLocationDot size={25} className="shrink-0 text-[#ff4d2d]" />
                <span className="w-[80%] truncate text-gray-600">{label}</span>
            </button>

            {isOpen && (
                <div className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/40 px-4 pt-24" role="presentation">
                    <div
                        className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="location-picker-title"
                    >
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <h2 id="location-picker-title" className="text-lg font-semibold text-gray-800">Select your delivery city</h2>
                                <p className="mt-1 text-sm text-gray-500">
                                    {currentCitySource === "manual" ? `Currently selected: ${currentCity}` : "Search for your city or use your current location."}
                                </p>
                            </div>
                            <button type="button" onClick={closePicker} aria-label="Close location picker" className="rounded-full p-2 text-gray-500 hover:bg-gray-100">
                                <IoClose size={20} />
                            </button>
                        </div>

                        <form className="mt-4 flex gap-2" onSubmit={handleSearch}>
                            <input
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search city or area"
                                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#ff4d2d]"
                                aria-label="Search city or area"
                            />
                            <button
                                type="submit"
                                disabled={status === "loading"}
                                className="rounded-lg bg-[#ff4d2d] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {status === "loading" ? "Searching..." : "Search"}
                            </button>
                        </form>

                        {status === "error" && (
                            <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
                        )}

                        {status === "success" && results.length === 0 && (
                            <p className="mt-3 text-sm text-gray-500">No matching locations found. Try a nearby city or area.</p>
                        )}

                        {results.length > 0 && (
                            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">
                                {results.map((place, index) => {
                                    const city = place?.city || place?.county || place?.name
                                    const detail = place?.address_line2 || place?.address_line1 || ""
                                    return (
                                        <li key={`${city}-${index}`}>
                                            <button
                                                type="button"
                                                onClick={() => selectPlace(place)}
                                                className="w-full rounded-lg border border-gray-200 p-3 text-left hover:border-[#ff4d2d] hover:bg-orange-50"
                                            >
                                                <span className="block text-sm font-semibold text-gray-800">{city || "Unnamed location"}</span>
                                                {detail && <span className="mt-1 block text-xs text-gray-500">{detail}</span>}
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}

                        <button
                            type="button"
                            onClick={useCurrentLocation}
                            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-[#ff4d2d] px-4 py-2 text-sm font-semibold text-[#ff4d2d] hover:bg-orange-50"
                        >
                            <FaLocationDot size={16} />
                            Use my current location
                        </button>
                    </div>
                </div>
            )}
        </>
    )
}

export default LocationPicker