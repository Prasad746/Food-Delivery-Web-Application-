export const DEFAULT_CUSTOMER_CITY_MAX_ACCURACY_METERS = 5000

export const resolveCustomerCityMaxAccuracyMeters = (value) => {
    const parsed = Number(value)
    if (value === null || value === undefined || value === "" || !Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_CUSTOMER_CITY_MAX_ACCURACY_METERS
    }
    return parsed
}

export const isCustomerCityAccuracyAcceptable = (accuracy, maxAccuracyMeters = DEFAULT_CUSTOMER_CITY_MAX_ACCURACY_METERS) => {
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) {
        return false
    }
    const limit = resolveCustomerCityMaxAccuracyMeters(maxAccuracyMeters)
    return accuracy <= limit
}