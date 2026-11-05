import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = (relative) => readFileSync(path.resolve(here, relative), "utf8")

const homeSource = readSource("../../frontend/src/pages/Home.jsx")
const signUpSource = readSource("../../frontend/src/pages/SignUp.jsx")
const signInSource = readSource("../../frontend/src/pages/SignIn.jsx")
const adminDashboardSource = readSource("../../frontend/src/components/AdminDashboard.jsx")
const userModelSource = readSource("../models/user.model.js")
const authControllerSource = readSource("../controllers/auth.controllers.js")

const routeLine = (role) => homeSource
    .split(/\r?\n/)
    .find(line => new RegExp(`userData\\.role\\s*==\\s*["']${role}["']`).test(line))

const dashboardFor = (role) => {
    const line = routeLine(role)
    assert.ok(line, `Home.jsx must route ${role} from backend userData.role`)
    const match = line.match(/<([A-Za-z0-9_]+)\s*\/>/)
    assert.ok(match, `Home.jsx must render a dashboard for ${role}`)
    return match[1]
}

describe("Role-based dashboard routing", () => {
    test("customer role renders the customer dashboard", () => {
        assert.strictEqual(dashboardFor("user"), "UserDashboard")
    })

    test("owner role renders the owner dashboard", () => {
        assert.strictEqual(dashboardFor("owner"), "OwnerDashboard")
    })

    test("delivery role renders the delivery dashboard", () => {
        assert.strictEqual(dashboardFor("deliveryBoy"), "DeliveryBoy")
    })

    test("admin role renders the admin dashboard", () => {
        assert.strictEqual(dashboardFor("admin"), "AdminDashboard")
    })

    test("routing reads the backend-provided Redux user role", () => {
        assert.match(homeSource, /const\s*\{\s*userData\s*\}\s*=\s*useSelector\(state\s*=>\s*state\.user\)/)
        assert.ok(
            !/localStorage|sessionStorage|useParams|useSearchParams/.test(homeSource),
            "route selection must not come from client-controlled storage or URL state"
        )
    })

    test("Admin access is not a public signup option", () => {
        assert.match(signUpSource, /\["user",\s*"owner",\s*"deliveryBoy"\]/)
        assert.ok(!/["']admin["']/.test(signUpSource), "signup UI must not offer an admin role")
        assert.match(signUpSource, /Admin accounts are provisioned by the operator/)
    })

    test("Admin dashboard uses the protected backend summary API", () => {
        assert.match(adminDashboardSource, /\/api\/admin\/summary/)
        assert.match(adminDashboardSource, /from '\.\.\/utils\/axiosInstance'/)
    })
})

describe("Role-aware authentication", () => {
    test("SignUp sends the selected public role to Google auth", () => {
        const start = signUpSource.indexOf("const handleGoogleAuth")
        const end = signUpSource.indexOf("return (", start)
        const handler = signUpSource.slice(start, end)
        assert.ok(start >= 0 && end > start, "SignUp Google handler must be present")
        assert.match(handler, /firebaseToken:\s*idToken/)
        assert.match(handler, /mobile,/)
        assert.match(handler, /role,/)
        assert.match(handler, /dispatch\(setUserData\(data\.user\)\)/)
    })

    test("new Google accounts use a validated public role in the backend", () => {
        const handler = authControllerSource.slice(authControllerSource.indexOf("export const googleAuth"))
        assert.match(handler, /const\s*\{[^}]*role[^}]*\}\s*=\s*req\.body/)
        assert.match(handler, /resolvePublicSignupRole\(role\)/)
        assert.match(handler, /role:\s*assignedRole/)
        assert.ok(!/role:\s*"user"/.test(handler), "Google auth must not hardcode every new account to user")
    })

    test("Admin role remains in the user model for provisioned accounts", () => {
        assert.match(userModelSource, /USER_ROLES/)
    })

    test("SignIn stores the backend-provided user role in Redux", () => {
        assert.match(signInSource, /dispatch\(setUserData\(data\.user\)\)/)
    })
})
