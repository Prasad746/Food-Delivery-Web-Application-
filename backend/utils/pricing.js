const DISCOUNT_TYPES = ["percentage", "fixed"]

export const normalizeMoney = (value) => Math.round(value * 100) / 100

const toValidDate = (value) => {
    if (value === null || value === undefined || value === "") {
        return null
    }
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
}

export const validateDiscountConfig = (discount, price) => {
    if (discount === null || discount === undefined) {
        return { valid: true }
    }
    if (typeof discount !== "object" || Array.isArray(discount)) {
        return { valid: false, error: "invalid discount configuration" }
    }
    if (!DISCOUNT_TYPES.includes(discount.type)) {
        return { valid: false, error: "discount type must be percentage or fixed" }
    }

    const value = Number(discount.value)
    if (!Number.isFinite(value) || value <= 0) {
        return { valid: false, error: "discount value must be greater than 0" }
    }
    if (discount.type === "percentage" && value > 100) {
        return { valid: false, error: "percentage discount must be greater than 0 and less than or equal to 100" }
    }
    if (discount.type === "fixed") {
        const numericPrice = Number(price)
        if (Number.isFinite(numericPrice) && normalizeMoney(value) > normalizeMoney(numericPrice)) {
            return { valid: false, error: "fixed discount must not exceed the item price" }
        }
    }

    const startDate = toValidDate(discount.startDate)
    if (startDate === undefined) {
        return { valid: false, error: "invalid discount start date" }
    }
    const endDate = toValidDate(discount.endDate)
    if (endDate === undefined) {
        return { valid: false, error: "invalid discount end date" }
    }
    if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
        return { valid: false, error: "discount end date must be later than the start date" }
    }

    return { valid: true }
}

export const isValidDiscountConfig = (discount, price) =>
    validateDiscountConfig(discount, price).valid

export const normalizeDiscountConfig = (discount) => {
    if (!discount) {
        return null
    }
    return {
        type: discount.type,
        value: normalizeMoney(Number(discount.value)),
        startDate: toValidDate(discount.startDate) || null,
        endDate: toValidDate(discount.endDate) || null,
        enabled: discount.enabled !== false
    }
}

export const mergeDiscountConfig = (existing, patch) => {
    if (patch === null || patch === undefined) {
        return null
    }
    const base = existing
        ? (typeof existing.toObject === "function" ? existing.toObject() : { ...existing })
        : {}
    return {
        type: patch.type !== undefined ? patch.type : base.type,
        value: patch.value !== undefined ? patch.value : base.value,
        startDate: patch.startDate !== undefined ? patch.startDate : base.startDate,
        endDate: patch.endDate !== undefined ? patch.endDate : base.endDate,
        enabled: patch.enabled !== undefined ? patch.enabled : (base.enabled !== undefined ? base.enabled : true)
    }
}

export const calculateItemPricing = (item, now = new Date()) => {
    const originalPrice = normalizeMoney(Number(item?.price))
    if (!Number.isFinite(originalPrice) || originalPrice < 0) {
        throw new Error("invalid item price")
    }

    const noDiscount = () => ({
        originalPrice,
        discountType: "",
        discountValue: 0,
        discountAmount: 0,
        finalPrice: originalPrice,
        discountApplied: false
    })

    const discount = item?.discount
    if (!discount || discount.enabled === false) {
        return noDiscount()
    }
    if (!isValidDiscountConfig(discount, originalPrice)) {
        return noDiscount()
    }

    const nowDate = now instanceof Date ? now : new Date(now)
    if (Number.isNaN(nowDate.getTime())) {
        return noDiscount()
    }
    const startDate = toValidDate(discount.startDate)
    const endDate = toValidDate(discount.endDate)
    if (startDate && nowDate.getTime() < startDate.getTime()) {
        return noDiscount()
    }
    if (endDate && nowDate.getTime() > endDate.getTime()) {
        return noDiscount()
    }

    const pricePaise = Math.round(originalPrice * 100)
    const discountValue = normalizeMoney(Number(discount.value))
    const requestedDiscountPaise = discount.type === "percentage"
        ? Math.round((pricePaise * discountValue) / 100)
        : Math.round(discountValue * 100)
    const discountPaise = Math.min(Math.max(requestedDiscountPaise, 0), pricePaise)
    const finalPaise = pricePaise - discountPaise

    return {
        originalPrice,
        discountType: discount.type,
        discountValue,
        discountAmount: discountPaise / 100,
        finalPrice: finalPaise / 100,
        discountApplied: discountPaise > 0
    }
}
