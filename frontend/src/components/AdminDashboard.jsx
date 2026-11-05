import React, { useEffect, useState } from 'react'
import Nav from './Nav'
import { useSelector } from 'react-redux'
import { FaUsers, FaUser, FaStore, FaMotorcycle, FaUserShield } from 'react-icons/fa'
import axios from '../utils/axiosInstance'
import { serverUrl } from '../utils/csrfClient'

const roleCards = [
  { key: "total", label: "Total Users", icon: FaUsers, color: "text-[#ff4d2d]", background: "bg-orange-50" },
  { key: "user", label: "Customers", icon: FaUser, color: "text-blue-600", background: "bg-blue-50" },
  { key: "owner", label: "Owners", icon: FaStore, color: "text-purple-600", background: "bg-purple-50" },
  { key: "deliveryBoy", label: "Delivery Partners", icon: FaMotorcycle, color: "text-green-600", background: "bg-green-50" },
  { key: "admin", label: "Admins", icon: FaUserShield, color: "text-gray-800", background: "bg-gray-100" },
]

function AdminDashboard() {
  const { userData } = useSelector(state => state.user)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const loadSummary = async () => {
      try {
        const { data } = await axios.get(`${serverUrl}/api/admin/summary`, { withCredentials: true })
        if (active) {
          setSummary(data.users)
          setError("")
        }
      } catch (err) {
        if (active) {
          setError(err?.response?.data?.message || "Unable to load admin summary")
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    loadSummary()
    return () => {
      active = false
    }
  }, [])

  return (
    <div className='w-full min-h-screen bg-[#fff9f6] flex flex-col items-center'>
      <Nav />
      <div className='w-full max-w-5xl px-4 sm:px-6 py-8'>
        <div className='mb-8'>
          <h1 className='text-2xl sm:text-3xl font-bold text-gray-900'>Admin Dashboard</h1>
          <p className='text-gray-600 mt-2'>
            Welcome{userData?.fullName ? `, ${userData.fullName}` : ""}. Review platform accounts and access.
          </p>
        </div>

        {loading && <p className='text-gray-600'>Loading platform summary...</p>}
        {!loading && error && (
          <div className='bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3'>
            {error}
          </div>
        )}
        {!loading && !error && summary && (
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4'>
            {roleCards.map(({ key, label, icon, color, background }) => (
              <div key={key} className='bg-white rounded-2xl border border-orange-100 shadow-sm p-5'>
                <div className={`w-11 h-11 rounded-full ${background} ${color} flex items-center justify-center mb-4`}>
                  {React.createElement(icon, { size: 20 })}
                </div>
                <p className='text-3xl font-bold text-gray-900'>{summary[key] ?? 0}</p>
                <p className='text-sm text-gray-600 mt-1'>{label}</p>
              </div>
            ))}
          </div>
        )}

        <div className='mt-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-5'>
          <div className='flex items-start gap-3'>
            <FaUserShield className='text-[#ff4d2d] mt-1' size={18} />
            <div>
              <p className='font-semibold text-gray-800'>Admin access is provisioned by the operator</p>
              <p className='text-sm text-gray-600 mt-1'>
                Public sign-up cannot create Admin accounts. Provision an existing account from the backend, then sign in normally.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AdminDashboard
