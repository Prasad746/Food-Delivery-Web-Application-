import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = (relative) => readFileSync(path.resolve(here, relative), "utf8")

const signInSource = readSource("../../frontend/src/pages/SignIn.jsx")
const signUpSource = readSource("../../frontend/src/pages/SignUp.jsx")
const controllerSource = readSource("../controllers/auth.controllers.js")

const { validateGoogleAuth } = await import("../utils/validate.js")
const { verifyFirebaseIdToken } = await import("../utils/firebase-admin.js")

describe("Google authentication — frontend sends Firebase ID token", () => {
    test("SignIn google-auth payload uses only the verified Firebase ID token plus an optional collected mobile", () => {
        assert.match(signInSource, /const payload=\{firebaseToken: idToken\}/)
        assert.match(signInSource, /payload\.mobile=googleMobile\.trim\(\)/)
        assert.match(
            signInSource,
            /axios\.post\(`\$\{serverUrl\}\/api\/auth\/google-auth`,payload,\{withCredentials:true\}/
        )
        const fn = signInSource.slice(signInSource.indexOf("const handleGoogleAuth"))
        assert.ok(!fn.includes("result.user.email"), "no unverified email from the popup may be sent")
        assert.match(fn, /data\?\.needsMobile/)
        assert.match(fn, /setPendingGoogleToken\(idToken\)/)
    })

    test("SignUp google-auth payload carries the Firebase ID token, collected mobile, and selected public role", () => {
        assert.match(signUpSource, /const idToken\s*=\s*await\s+result\.user\.getIdToken\(\)/)
        const payload = signUpSource.match(/axios\.post\(`\$\{serverUrl\}\/api\/auth\/google-auth`,\s*\{[\s\S]*?\}/)
        assert.ok(payload, "google-auth POST payload found")
        assert.match(payload[0], /firebaseToken:\s*idToken/)
        assert.match(payload[0], /\bmobile\b/)
        assert.match(payload[0], /\brole\b/)
        assert.ok(!payload[0].includes("email:"), "google-auth payload must not contain a client-supplied email")
    })

    test("both google flows surface backend errors and still rotate the CSRF token", () => {
        for (const source of [signInSource, signUpSource]) {
            const fn = source.slice(source.indexOf("handleGoogleAuth"))
            assert.match(fn, /window\.__VINGO_CSRF_TOKEN\s*=\s*data\.csrfToken/)
            assert.match(fn, /(data\?\.message|error\?\.response\?\.data\?\.message)/)
        }
    })
})

const googleAuthFnSource = controllerSource.slice(
    controllerSource.indexOf("export const googleAuth")
)

describe("Backend googleAuth controller identity discipline", () => {
    test("identity is derived solely from the Firebase-verified decoded token", () => {
        assert.match(googleAuthFnSource, /const decodedToken\s*=\s*await\s+verifyFirebaseIdToken\(firebaseToken\)/)
        assert.match(googleAuthFnSource, /const \{uid,email\}\s*=\s*decodedToken/)
        assert.match(googleAuthFnSource, /decodedToken\.name/, "real Firebase ID tokens carry a name claim")
        assert.ok(
            !/\bconst \{uid,email,fullName\}\s*=\s*decodedToken/.test(googleAuthFnSource),
            "must not assume a fullName claim exists"
        )
        const reqBodyUses = googleAuthFnSource.match(/req\.body/g) || []
        assert.ok(
            googleAuthFnSource.match(/const \{firebaseToken, mobile, role\}=req\.body/),
            "the only req.body reads are the Firebase token, profile mobile, and selected public role"
        )
        assert.strictEqual(reqBodyUses.length, 1, "all identity claims (uid/email/name) must come from the verified token")
    })

    test("guards require a usable identity and an explicitly verified google email", () => {
        assert.match(googleAuthFnSource, /typeof uid!=="string" \|\| uid\.trim\(\)===""/)
        assert.match(googleAuthFnSource, /typeof email!=="string" \|\| email\.trim\(\)===""/)
        assert.match(googleAuthFnSource, /decodedToken\.email_verified !== true/)
        assert.match(googleAuthFnSource, /res\.status\(401\)\.json\(\{message:"Google authentication failed"\}\)/)
        assert.ok(!/email_verified === false/.test(googleAuthFnSource), "false-only checks allow missing or malformed claims")

        const beforeAccountLookup = googleAuthFnSource.slice(0, googleAuthFnSource.indexOf("let user=await User.findOne"))
        assert.match(beforeAccountLookup, /decodedToken\.email_verified !== true/, "verification must run before account lookup/create")
    })

    test("new accounts never auto-link by email, always require a collected mobile, and use only a validated public role", () => {
        assert.match(googleAuthFnSource, /const existingEmailUser=await User\.findOne\(\{email\}\)/)
        assert.match(googleAuthFnSource, /An account with this email already exists/)
        assert.match(googleAuthFnSource, /needsMobile:true/)
        assert.match(googleAuthFnSource, /mobile:normalizedMobile/)
        assert.match(googleAuthFnSource, /const assignedRole=resolvePublicSignupRole\(role\)/)
        assert.match(googleAuthFnSource, /if\(!assignedRole\)/)
        assert.match(googleAuthFnSource, /role:assignedRole/)
        assert.ok(!/role:\s*role\b/.test(googleAuthFnSource), "raw client role must never be assigned")
        assert.ok(!/role:\s*"user"/.test(googleAuthFnSource), "new Google accounts must not ignore the selected public role")
        assert.match(googleAuthFnSource, /firebaseUid:uid/)
    })

    test("invalid or expired Firebase tokens return 401 instead of 500", () => {
        assert.match(googleAuthFnSource, /"Invalid or expired Firebase ID token"\)/)
        assert.match(googleAuthFnSource, /res\.status\(401\)\.json\(\{ message: "Invalid or expired Firebase ID token" \}\)/)
    })

    test("duplicate firebaseUid creation attempts return 409 with a clear retry message", () => {
        assert.match(googleAuthFnSource, /error\?\.code === 11000/)
        assert.match(googleAuthFnSource, /\/firebaseUid\/\.test\(error\?\.message \|\| ""\)/)
        assert.match(googleAuthFnSource, /This Google account is already registered/)
    })

    test("google login still issues the auth cookie via getCookieOptions and a post-login CSRF token", () => {
        assert.match(googleAuthFnSource, /res\.cookie\("token",token,getCookieOptions\(\)\)/)
        assert.match(googleAuthFnSource, /generateAndSetCsrfCookie\(res,"post-login"\)/)
        assert.match(googleAuthFnSource, /return res\.status\(200\)\.json\(\{ user: sanitizeUserProfile\(user\), csrfToken \}\)/)
    })
})

describe("validateGoogleAuth middleware", () => {
    const run = (body) => new Promise((resolve) => {
        const req = { body }
        let statusCode = null
        let message = null
        const res = {
            status(code) { statusCode = code; return this },
            json(payload) { message = payload?.message },
        }
        let nextCalled = false
        validateGoogleAuth(req, res, () => { nextCalled = true })
        Promise.resolve().then(() => resolve({ nextCalled, statusCode, message }))
    })

    test("rejects an email-only payload: firebaseToken is required", async () => {
        const result = await run({ email: "attacker@example.com" })
        assert.strictEqual(result.nextCalled, false)
        assert.strictEqual(result.statusCode, 400)
        assert.match(result.message, /firebaseToken/i)
    })

    test("accepts a token-bearing payload", async () => {
        const result = await run({ firebaseToken: "some.firebase.jwt.token" })
        assert.strictEqual(result.nextCalled, true)
        assert.strictEqual(result.statusCode, null)
    })

    test("accepts the public signup roles before account creation", async () => {
        for (const role of ["user", "owner", "deliveryBoy"]) {
            const result = await run({ firebaseToken: "some.firebase.jwt.token", role })
            assert.strictEqual(result.nextCalled, true, `${role} must be accepted`)
            assert.strictEqual(result.statusCode, null)
        }
    })

    test("rejects an Admin role from public Google auth", async () => {
        const result = await run({ firebaseToken: "some.firebase.jwt.token", role: "admin" })
        assert.strictEqual(result.nextCalled, false)
        assert.strictEqual(result.statusCode, 400)
        assert.match(result.message, /role.*(not allowed|must be one of)/i)
    })
})

describe("verifyFirebaseIdToken fails closed", () => {
    test("a garbage token is rejected, never trusted or treated as a valid identity", async () => {
        await assert.rejects(
            () => verifyFirebaseIdToken("not-a-real-firebase-id-token"),
            (err) => {
                assert.ok(err.message)
                assert.ok(
                    /Invalid or expired Firebase ID token|not configured/i.test(err.message),
                    "rejection must be explicit about token validity or configuration"
                )
                return true
            }
        )
    })
})
