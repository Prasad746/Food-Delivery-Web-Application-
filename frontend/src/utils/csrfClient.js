const envApiUrl = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_API_URL : undefined
const isProd = typeof import.meta.env !== "undefined" ? import.meta.env.PROD : false

if (!envApiUrl && isProd) {
  throw new Error("Configuration error: VITE_API_URL environment variable is required in production.")
}

export const serverUrl = (envApiUrl || "http://localhost:8000").replace(/\/$/, "")

if (typeof window !== "undefined" && window.__VINGO_CSRF_TOKEN === undefined) {
  window.__VINGO_CSRF_TOKEN = ""
}

export const getCsrfToken = () =>
  typeof window !== "undefined" ? window.__VINGO_CSRF_TOKEN || "" : ""

export const setCsrfToken = (token) => {
  if (typeof window !== "undefined") {
    window.__VINGO_CSRF_TOKEN = token || ""
  }
}

export const bootstrapCsrfToken = async () => {
  const res = await fetch(`${serverUrl}/api/csrf-token`, { credentials: "include" })
  if (!res.ok) {
    throw new Error(`CSRF bootstrap request failed with status ${res.status}`)
  }
  const data = await res.json()
  if (!data || !data.csrfToken) {
    throw new Error("CSRF bootstrap response missing csrfToken")
  }
  setCsrfToken(data.csrfToken)
  return data.csrfToken
}

let pendingBootstrap = null

export const ensureCsrfToken = async () => {
  const existing = getCsrfToken()
  if (existing) {
    return existing
  }
  if (!pendingBootstrap) {
    pendingBootstrap = bootstrapCsrfToken().finally(() => {
      pendingBootstrap = null
    })
  }
  return pendingBootstrap
}
