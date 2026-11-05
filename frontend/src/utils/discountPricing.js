export const DISCOUNT_TYPES = ["percentage", "fixed"]
export const DELIVERY_FEE = 40
export const FREE_DELIVERY_THRESHOLD = 500

export const normalizeMoney = (value) => {
    const number = Number(value)
    if (!Number.isFinite(number)) {
        return 0
    }
    return Math.round(number * 100) / 100
}

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

export const getDiscountStatus = (discount, options = {}) => {
    if (!discount) {
        return {
            state: "none",
            label: "No discount",
            isActive: false,
            startsAt: null,
            endsAt: null
        }
    }
    if (typeof discount !== "object" || Array.isArray(discount)) {
        return {
            state: "invalid",
            label: "Invalid discount",
            isActive: false,
            startsAt: null,
            endsAt: null
        }
    }

    const startsAt = toValidDate(discount.startDate)
    const endsAt = toValidDate(discount.endDate)

    if (discount.enabled === false) {
        return {
            state: "disabled",
            label: "Disabled",
            isActive: false,
            startsAt: startsAt || null,
            endsAt: endsAt || null
        }
    }
    if (!isValidDiscountConfig(discount, options.price)) {
        return {
            state: "invalid",
            label: "Invalid discount",
            isActive: false,
            startsAt: startsAt || null,
            endsAt: endsAt || null
        }
    }

    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
    const nowTime = Number.isNaN(now.getTime()) ? Date.now() : now.getTime()
    if (startsAt && nowTime < startsAt.getTime()) {
        return {
            state: "scheduled",
            label: "Scheduled",
            isActive: false,
            startsAt,
            endsAt: endsAt || null
        }
    }
    if (endsAt && nowTime > endsAt.getTime()) {
        return {
            state: "expired",
            label: "Expired",
            isActive: false,
            startsAt: startsAt || null,
            endsAt
        }
    }

    return {
        state: "active",
        label: "Active",
        isActive: true,
        startsAt: startsAt || null,
        endsAt: endsAt || null
    }
}

export const getItemPricing = (item, now = new Date()) => {
    const originalPrice = normalizeMoney(item?.price)
    const status = getDiscountStatus(item?.discount, { now, price: originalPrice })
    const noDiscount = {
        originalPrice,
        finalPrice: originalPrice,
        discountType: "",
        discountValue: 0,
        discountAmount: 0,
        discountApplied: false,
        status
    }

    if (!Number.isFinite(Number(item?.price)) || Number(item?.price) < 0) {
        return { ...noDiscount, invalidPrice: true }
    }
    if (status.state !== "active") {
        return noDiscount
    }

    const pricePaise = Math.round(originalPrice * 100)
    const discountValue = normalizeMoney(item.discount.value)
    const requestedDiscountPaise = item.discount.type === "percentage"
        ? Math.round((pricePaise * discountValue) / 100)
        : Math.round(discountValue * 100)
    const discountPaise = Math.min(Math.max(requestedDiscountPaise, 0), pricePaise)
    const finalPaise = pricePaise - discountPaise

    return {
        originalPrice,
        finalPrice: finalPaise / 100,
        discountType: item.discount.type,
        discountValue,
        discountAmount: discountPaise / 100,
        discountApplied: discountPaise > 0,
        status
    }
}

export const formatAmount = (value) => {
    const number = normalizeMoney(value)
    return number.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")
}

export const discountBadgeLabel = (discount) => {
    if (!discount) {
        return ""
    }
    const type = discount.type ?? discount.discountType
    const value = Number(discount.value ?? discount.discountValue)
    if (!DISCOUNT_TYPES.includes(type) || !Number.isFinite(value) || value <= 0) {
        return ""
    }
    return type === "percentage" ? `${formatAmount(value)}% OFF` : `₹${formatAmount(value)} OFF`
}

export const formatDiscountDate = (value) => {
    const date = toValidDate(value)
    if (!date) {
        return ""
    }
    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    })
}

export const dateValueForInput = (value) => {
    const date = toValidDate(value)
    return date ? date.toISOString().slice(0, 10) : ""
}

export const dateInputToIso = (value, endOfDay = false) => {
    if (!value) {
        return null
    }
    const time = endOfDay ? "23:59:59.999" : "00:00:00.000"
    const date = new Date(`${value}T${time}Z`)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const createEmptyDiscountForm = () => ({
    type: "none",
    value: "",
    startDate: "",
    endDate: "",
    enabled: true
})

export const discountToForm = (discount) => {
    if (!discount) {
        return createEmptyDiscountForm()
    }
    return {
        type: DISCOUNT_TYPES.includes(discount.type) ? discount.type : "none",
        value: discount.value !== undefined && discount.value !== null ? String(discount.value) : "",
        startDate: dateValueForInput(discount.startDate),
        endDate: dateValueForInput(discount.endDate),
        enabled: discount.enabled !== false
    }
}

export const validateDiscountForm = (form, price) => {
    const errors = {}
    if (!form || form.type === "none") {
        return { valid: true, errors }
    }
    if (!DISCOUNT_TYPES.includes(form.type)) {
        errors.type = "Select a valid discount type"
    }

    const rawValue = String(form.value ?? "").trim()
    const value = Number(rawValue)
    if (!rawValue || !Number.isFinite(value) || value <= 0) {
        errors.value = "Enter a discount value greater than 0"
    } else if (form.type === "percentage" && value > 100) {
        errors.value = "Percentage discount must be 100 or less"
    } else if (form.type === "fixed") {
        const numericPrice = Number(price)
        if (!Number.isFinite(numericPrice) || normalizeMoney(value) > normalizeMoney(numericPrice)) {
            errors.value = "Fixed discount cannot exceed the item price"
        }
    }

    const startDate = form.startDate ? dateInputToIso(form.startDate) : null
    const endDate = form.endDate ? dateInputToIso(form.endDate, true) : null
    if (form.startDate && !startDate) {
        errors.startDate = "Enter a valid start date"
    }
    if (form.endDate && !endDate) {
        errors.endDate = "Enter a valid end date"
    }
    if (startDate && endDate && new Date(endDate).getTime() <= new Date(startDate).getTime()) {
        errors.endDate = "End date must be after the start date"
    }

    return { valid: Object.keys(errors).length === 0, errors }
}

export const discountFormToPayload = (form) => {
    if (!form || form.type === "none") {
        return null
    }
    return {
        type: form.type,
        value: normalizeMoney(Number(form.value)),
        startDate: dateInputToIso(form.startDate),
        endDate: dateInputToIso(form.endDate, true),
        enabled: form.enabled !== false
    }
}

export const serializeDiscountField = (payload) => payload === null ? "" : JSON.stringify(payload)

export const buildCartPricingFields = (item, now = new Date()) => {
    const pricing = getItemPricing(item, now)
    const shop = item?.shop && typeof item.shop === "object" ? item.shop._id : item?.shop
    return {
        id: item?._id ?? item?.id,
        name: item?.name,
        image: item?.image,
        shop,
        foodType: item?.foodType,
        price: pricing.finalPrice,
        originalPrice: pricing.originalPrice,
        discountType: pricing.discountType,
        discountValue: pricing.discountValue,
        discountAmount: pricing.discountAmount,
        finalPrice: pricing.finalPrice,
        discountApplied: pricing.discountApplied,
        isAvailable: item?.isAvailable !== false
    }
}

export const getCartItemPricing = (cartItem) => {
    const rawFinal = cartItem?.finalPrice ?? cartItem?.price
    const finalPrice = normalizeMoney(rawFinal)
    const rawOriginal = cartItem?.originalPrice ?? cartItem?.price
    const originalPrice = normalizeMoney(rawOriginal)
    const discountType = DISCOUNT_TYPES.includes(cartItem?.discountType) ? cartItem.discountType : ""
    const storedDiscountAmount = normalizeMoney(cartItem?.discountAmount)
    const discountAmount = storedDiscountAmount > 0
        ? storedDiscountAmount
        : normalizeMoney(Math.max(originalPrice - finalPrice, 0))
    const discountValue = normalizeMoney(cartItem?.discountValue)
    const quantity = Math.max(0, Number(cartItem?.quantity) || 0)
    const discountApplied = Boolean(discountType) && discountAmount > 0 && originalPrice >= finalPrice
    const lineTotal = normalizeMoney(finalPrice * quantity)
    const originalLineTotal = normalizeMoney((discountApplied ? originalPrice : finalPrice) * quantity)

    return {
        finalPrice,
        originalPrice: discountApplied ? originalPrice : finalPrice,
        discountType: discountApplied ? discountType : "",
        discountValue: discountApplied ? discountValue : 0,
        discountAmount: discountApplied ? discountAmount : 0,
        discountApplied,
        quantity,
        lineTotal,
        originalLineTotal,
        savings: normalizeMoney(Math.max(originalLineTotal - lineTotal, 0)),
        hasPrice: Number.isFinite(Number(rawFinal))
    }
}

export const calculateCartTotals = (cartItems) => {
    const lines = (cartItems || []).map((item) => ({
        item,
        ...getCartItemPricing(item)
    }))
    const subtotal = normalizeMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0))
    const savings = normalizeMoney(lines.reduce((sum, line) => sum + line.savings, 0))
    const deliveryFee = subtotal > FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE
    return {
        lines,
        subtotal,
        savings,
        deliveryFee,
        total: normalizeMoney(subtotal + deliveryFee)
    }
}

export const getHistoricalItemPricing = (line) => {
    const rawFinal = line?.finalPrice ?? line?.price
    const finalPrice = normalizeMoney(rawFinal)
    const rawOriginal = line?.originalPrice ?? rawFinal
    const originalPrice = normalizeMoney(rawOriginal)
    const discountType = DISCOUNT_TYPES.includes(line?.discountType) ? line.discountType : ""
    const discountValue = normalizeMoney(line?.discountValue)
    const discountAmount = normalizeMoney(line?.discountAmount)
    const discountApplied = Boolean(discountType) && (discountAmount > 0 || discountValue > 0) && originalPrice >= finalPrice

    return {
        finalPrice,
        originalPrice: discountApplied ? originalPrice : finalPrice,
        discountType: discountApplied ? discountType : "",
        discountValue: discountApplied ? discountValue : 0,
        discountAmount: discountApplied ? discountAmount : 0,
        discountApplied
    }
}
