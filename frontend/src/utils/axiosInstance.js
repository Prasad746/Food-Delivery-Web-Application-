import axios from "axios"
import { serverUrl, ensureCsrfToken } from "./csrfClient.js"

const api = axios.create({
  baseURL: serverUrl,
  withCredentials: true,
})

api.interceptors.request.use(async (config) => {
  if (config.url && config.url.startsWith("https://api.geoapify.com")) {
    return config
  }

  if (config.method && ["post", "put", "patch", "delete"].includes(config.method.toLowerCase())) {
    const csrfToken = await ensureCsrfToken().catch(() => "")
    if (csrfToken) {
      config.headers["X-XSRF-TOKEN"] = csrfToken
    } else {
      console.warn("CSRF token unavailable for state-changing request to", config.url)
    }
  }

  return config
}, (error) => Promise.reject(error))

export default api
