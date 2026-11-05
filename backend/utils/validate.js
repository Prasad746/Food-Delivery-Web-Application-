import Joi from "joi"
import { PUBLIC_SIGNUP_ROLES } from "./roles.js"
import { normalizeDiscountConfig, validateDiscountConfig } from "./pricing.js"

const signUpSchema = Joi.object({
  fullName: Joi.string().min(3).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  mobile: Joi.string().min(10).max(15).required(),
  role: Joi.string().valid(...PUBLIC_SIGNUP_ROLES).default("user")
})

const signInSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
})

const sendOtpSchema = Joi.object({
  email: Joi.string().email().required()
})

const verifyOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(4).required()
})

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  newPassword: Joi.string().min(6).required(),
  resetToken: Joi.string().trim().min(32).max(256).required().messages({
    "any.required": "invalid or expired reset token",
    "string.base": "invalid or expired reset token",
    "string.empty": "invalid or expired reset token",
    "string.min": "invalid or expired reset token",
    "string.max": "invalid or expired reset token"
  })
})

const googleAuthSchema = Joi.object({
  firebaseToken: Joi.string().required(),
  mobile: Joi.string().trim().min(10).max(15).optional(),
  role: Joi.string().valid(...PUBLIC_SIGNUP_ROLES).default("user")
})

export const ITEM_CATEGORIES = [
  "Snacks",
  "Main Course",
  "Desserts",
  "Pizza",
  "Burgers",
  "Sandwiches",
  "South Indian",
  "North Indian",
  "Chinese",
  "Fast Food",
  "Others"
]

export const FOOD_TYPES = ["veg", "non veg"]

const itemName = Joi.string().trim().min(1).max(200)

const discountDateSchema = Joi.date().allow(null)

const discountCreateSchema = Joi.object({
  type: Joi.string().valid("percentage", "fixed").required(),
  value: Joi.number().positive().required(),
  startDate: discountDateSchema,
  endDate: discountDateSchema,
  enabled: Joi.boolean().default(true)
})

const discountUpdateSchema = Joi.object({
  type: Joi.string().valid("percentage", "fixed"),
  value: Joi.number().positive(),
  startDate: discountDateSchema,
  endDate: discountDateSchema,
  enabled: Joi.boolean()
}).min(1)

const itemCreateSchema = Joi.object({
  name: itemName.required(),
  category: Joi.string().valid(...ITEM_CATEGORIES).required(),
  foodType: Joi.string().valid(...FOOD_TYPES).required(),
  price: Joi.number().min(0).required(),
  discount: Joi.alternatives().try(discountCreateSchema, Joi.valid(null))
})

const itemUpdateSchema = Joi.object({
  name: itemName,
  category: Joi.string().valid(...ITEM_CATEGORIES),
  foodType: Joi.string().valid(...FOOD_TYPES),
  price: Joi.number().min(0),
  discount: Joi.alternatives().try(discountUpdateSchema, Joi.valid(null))
})

const parseDiscountField = (value) => {
  if (value === undefined) {
    return { provided: false }
  }
  if (value === null) {
    return { provided: true, value: null }
  }
  let parsed = value
  if (typeof value === "string") {
    if (!value.trim()) {
      return { provided: true, value: null }
    }
    try {
      parsed = JSON.parse(value)
    } catch {
      return { provided: true, error: "invalid discount configuration" }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { provided: true, error: "invalid discount configuration" }
  }
  return { provided: true, value: parsed }
}

const prepareDiscountPayload = (payload) => {
  const prepared = payload && typeof payload === "object" ? { ...payload } : payload
  if (!prepared || typeof prepared !== "object") {
    return { payload: prepared }
  }
  const parsedDiscount = parseDiscountField(prepared.discount)
  if (parsedDiscount.error) {
    return { error: parsedDiscount.error }
  }
  if (!parsedDiscount.provided) {
    delete prepared.discount
  } else {
    prepared.discount = parsedDiscount.value
  }
  return { payload: prepared }
}

const deliveryAddressSchema = Joi.object({
  text: Joi.string().trim().min(1).max(300).required(),
  latitude: Joi.number().strict().min(-90).max(90).required(),
  longitude: Joi.number().strict().min(-180).max(180).required()
}).required()

export const MAX_CANCELLATION_REASON_LENGTH = 300

const cancellationSchema = Joi.object({
  reason: Joi.string().trim().max(MAX_CANCELLATION_REASON_LENGTH).allow("").optional()
})

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value)

// Coordinates must be finite numbers inside valid geographic ranges.
export const toValidCoordinates = (latitude, longitude) => {
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    return null
  }
  if (latitude < -90 || latitude > 90) {
    return null
  }
  if (longitude < -180 || longitude > 180) {
    return null
  }
  return { latitude, longitude }
}

const firstValidationMessage = (error) => error.details[0].message

// Search safety: user text is trimmed, length-capped and regex-escaped before
// it reaches any $regex filter, so metacharacters can never widen the match,
// change query meaning, or hang the event loop on crafted patterns.
export const MAX_SEARCH_TEXT_LENGTH = 100

export const MAX_SUPPORT_MESSAGE_LENGTH = 500

const supportChatSchema = Joi.object({
  message: Joi.string().trim().min(1).max(MAX_SUPPORT_MESSAGE_LENGTH).required().messages({
    "string.base": "message must be a string",
    "string.empty": "message is required",
    "string.min": "message is required",
    "string.max": `message must be ${MAX_SUPPORT_MESSAGE_LENGTH} characters or fewer`,
    "any.required": "message is required"
  }),
  orderId: Joi.string()
    .trim()
    .pattern(/^[a-f0-9]{24}$/i)
    .allow("")
    .optional()
    .messages({
      "string.pattern.base": "orderId must be a valid order id"
    })
})

const escapeSearchLiteral = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const sanitizeSearchText = (value) => {
    if (typeof value !== "string") {
        return { ok: false }
    }
    const text = value.trim()
    if (!text) {
        return { ok: false, empty: true }
    }
    if (text.length > MAX_SEARCH_TEXT_LENGTH) {
        return { ok: false, tooLong: true }
    }
    return { ok: true, text }
}

// Exact city lookups keep the original anchored, case-insensitive semantics.
export const exactTextPattern = (text) => new RegExp(`^${escapeSearchLiteral(text)}$`, "i")

// Free-text search keeps the original substring, case-insensitive semantics
// but as a literal, so ".*" no longer matches everything.
export const substringTextPattern = (text) => new RegExp(escapeSearchLiteral(text), "i")

export const validateItemCreateBody = (payload) => {
  const prepared = prepareDiscountPayload(payload)
  if (prepared.error) {
    return { error: prepared.error }
  }
  const { error, value } = itemCreateSchema.validate(prepared.payload, { abortEarly: false })
  if (error) {
    return { error: firstValidationMessage(error) }
  }
  const fields = {
    name: value.name,
    category: value.category,
    foodType: value.foodType,
    price: value.price
  }
  if (value.discount !== undefined && value.discount !== null) {
    const discountCheck = validateDiscountConfig(value.discount, value.price)
    if (!discountCheck.valid) {
      return { error: discountCheck.error }
    }
    fields.discount = normalizeDiscountConfig(value.discount)
  }
  return { fields }
}

export const validateItemUpdateBody = (payload) => {
  const prepared = prepareDiscountPayload(payload)
  if (prepared.error) {
    return { error: prepared.error }
  }
  const { error, value } = itemUpdateSchema.validate(prepared.payload, { abortEarly: false })
  if (error) {
    return { error: firstValidationMessage(error) }
  }
  const fields = {}
  if (value.name !== undefined) {
    fields.name = value.name
  }
  if (value.category !== undefined) {
    fields.category = value.category
  }
  if (value.foodType !== undefined) {
    fields.foodType = value.foodType
  }
  if (value.price !== undefined) {
    fields.price = value.price
  }
  if (value.discount !== undefined) {
    fields.discount = value.discount === null ? null : { ...value.discount }
  }
  return { fields }
}

export const validateDeliveryAddressBody = (payload) => {
  const { error, value } = deliveryAddressSchema.validate(payload === undefined ? null : payload, { abortEarly: false })
  if (error) {
    return { error: firstValidationMessage(error) }
  }
  return {
    address: {
      text: value.text,
      latitude: value.latitude,
      longitude: value.longitude
    }
  }
}

export const validateCancellationBody = (payload) => {
  const { error, value } = cancellationSchema.validate(payload === undefined ? {} : payload, { abortEarly: false })
  if (error) {
    return { error: firstValidationMessage(error) }
  }
  return { reason: value.reason || "" }
}

export const validateSupportChatBody = (payload) => {
  const { error, value } = supportChatSchema.validate(payload === undefined ? null : payload, { abortEarly: false })
  if (error) {
    return { error: firstValidationMessage(error) }
  }
  return {
    message: value.message,
    orderId: value.orderId || null
  }
}

export const validateSignUp = (req, res, next) => {
  const { error } = signUpSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export const validateSignIn = (req, res, next) => {
  const { error } = signInSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export const validateSendOtp = (req, res, next) => {
  const { error } = sendOtpSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export const validateVerifyOtp = (req, res, next) => {
  const { error } = verifyOtpSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export const validateResetPassword = (req, res, next) => {
  const { error } = resetPasswordSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export const validateGoogleAuth = (req, res, next) => {
  const { error } = googleAuthSchema.validate(req.body)
  if (error) {
    return res.status(400).json({ message: error.details[0].message })
  }
  next()
}

export { signUpSchema, signInSchema, sendOtpSchema, verifyOtpSchema, resetPasswordSchema, googleAuthSchema }