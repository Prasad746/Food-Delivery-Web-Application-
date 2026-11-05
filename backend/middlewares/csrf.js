import jwt from "jsonwebtoken"
import { randomBytes } from "node:crypto"

import {
  getAllowedOrigins,
  getCookieOptions,
  getJwtSecret
} from "../config/security.js"

// Generate a cryptographically secure random CSRF ID
const generateCSRFId = () => {
  return randomBytes(18).toString("base64url")
}

const isTrustedOrigin = (allowedOrigins, origin) =>
  typeof origin === "string" && allowedOrigins.includes(origin)

const bootstrapWithConfig = (config, req, res) => {
  const origin = req.headers.origin

  if (!isTrustedOrigin(config.allowedOrigins, origin)) {
    return res.status(403).json({ message: "Invalid origin" })
  }

  const csrfId = generateCSRFId()

  const signedToken = jwt.sign(
    {
      csrf: csrfId,
      purpose: "initial"
    },
    getJwtSecret(),
    {
      expiresIn: "24h"
    }
  )

  res.cookie("XSRF-TOKEN", signedToken, {
    httpOnly: false,
    sameSite: config.cookieOptions.sameSite,
    secure: config.cookieOptions.secure,
    maxAge: 24 * 60 * 60 * 1000
  })

  res.json({ csrfToken: signedToken })
}

// Safe methods: CORS preflight and idempotent reads bypass CSRF validation
// CSRF defense applies to state-changing methods only (POST/PUT/PATCH/DELETE)
const middlewareWithConfig = (config, req, res, next) => {
  if (
    req.method === "OPTIONS" ||
    req.method === "GET" ||
    req.method === "HEAD"
  ) {
    return next()
  }

  const origin = req.headers.origin

  if (!isTrustedOrigin(config.allowedOrigins, origin)) {
    return res.status(403).json({ message: "Invalid origin" })
  }

  const headerToken = req.headers["x-xsrf-token"]

  if (!headerToken) {
    return res.status(403).json({ message: "Missing CSRF token" })
  }

  let decoded

  try {
    decoded = jwt.verify(headerToken, getJwtSecret())
  } catch (err) {
    return res.status(403).json({
      message: "Invalid or expired CSRF token"
    })
  }

  if (
    !decoded ||
    (
      decoded.purpose !== "initial" &&
      decoded.purpose !== "post-login"
    )
  ) {
    return res.status(403).json({
      message: "Invalid CSRF token purpose"
    })
  }

  const cookieToken = req.cookies["XSRF-TOKEN"]

  if (!cookieToken) {
    return res.status(403).json({
      message: "CSRF token cookie missing"
    })
  }

  if (headerToken !== cookieToken) {
    return res.status(403).json({
      message: "CSRF token mismatch"
    })
  }

  next()
}

export const createCsrfHandlers = (config) => ({
  csrfBootstrap: (req, res) =>
    bootstrapWithConfig(config, req, res),

  csrfMiddleware: (req, res, next) =>
    middlewareWithConfig(config, req, res, next)
})

export const csrfBootstrap = (req, res) =>
  bootstrapWithConfig(
    {
      allowedOrigins: getAllowedOrigins(),
      cookieOptions: getCookieOptions()
    },
    req,
    res
  )

export const csrfMiddleware = (req, res, next) =>
  middlewareWithConfig(
    {
      allowedOrigins: getAllowedOrigins()
    },
    req,
    res,
    next
  )