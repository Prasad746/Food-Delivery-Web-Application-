import { isProduction } from "../config/security.js"

// Central Express error handler. Registered after all routes so every
// propagated error reaches it. Production responses never include stack
// traces, internal error messages, or request data; diagnostics stay in
// server-side logs only.
export const errorHandler = (err, req, res, next) => {
  const rawStatus = Number.isInteger(err?.statusCode) ? err.statusCode : 500
  const statusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const production = isProduction()

  if (statusCode >= 500) {
    console.error("Unhandled error:", err?.stack || err?.message || "unknown error")
  } else if (!production) {
    console.error("Request error:", err?.message || "request error")
  }

  if (res.headersSent) {
    return next(err)
  }

  let message
  if (production) {
    message = statusCode >= 500 ? "Internal server error" : "Request failed"
  } else {
    message = err?.message || "Internal server error"
  }

  return res.status(statusCode).json({ message })
}
