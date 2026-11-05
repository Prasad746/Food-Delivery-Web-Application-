import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { isMailConfigError, validateMailConfig } from "../utils/mail.js"

const validMail = Object.freeze({
    EMAIL: "sender@vingo.in",
    PASS: "abcd1234efgh5678"
})

const assertInvalidConfig = (env) => {
    assert.throws(
        () => validateMailConfig(env),
        (error) => isMailConfigError(error) && error.code === "MAIL_NOT_CONFIGURED"
    )
}

describe("mail configuration validation", () => {
    test("rejects missing, malformed, and placeholder credentials", () => {
        assertInvalidConfig({ EMAIL: "", PASS: validMail.PASS })
        assertInvalidConfig({ EMAIL: "not-an-email", PASS: validMail.PASS })
        assertInvalidConfig({ EMAIL: "your email address", PASS: validMail.PASS })
        assertInvalidConfig({ EMAIL: "your_email@vingo.in", PASS: validMail.PASS })
        assertInvalidConfig({ EMAIL: validMail.EMAIL, PASS: "" })
        assertInvalidConfig({ EMAIL: validMail.EMAIL, PASS: "short" })
        assertInvalidConfig({ EMAIL: validMail.EMAIL, PASS: "your app password" })
    })

    test("accepts and trims a valid email and app password", () => {
        const config = validateMailConfig({
            EMAIL: ` ${validMail.EMAIL} `,
            PASS: ` ${validMail.PASS} `
        })

        assert.deepEqual(config, {
            email: validMail.EMAIL,
            pass: validMail.PASS
        })
    })

    test("does not treat a real address as a placeholder", () => {
        assert.doesNotThrow(() => validateMailConfig({
            EMAIL: "myemail@vingo.in",
            PASS: "testablepassword123"
        }))
    })
})
