export const PUBLIC_SIGNUP_ROLES = Object.freeze(["user", "owner", "deliveryBoy"])
export const ADMIN_ROLE = "admin"
export const USER_ROLES = Object.freeze([...PUBLIC_SIGNUP_ROLES, ADMIN_ROLE])

export const isPublicSignupRole = (role) => PUBLIC_SIGNUP_ROLES.includes(role)

export const resolvePublicSignupRole = (role) => {
    if (role === undefined || role === null || role === "") {
        return "user"
    }
    return isPublicSignupRole(role) ? role : null
}
