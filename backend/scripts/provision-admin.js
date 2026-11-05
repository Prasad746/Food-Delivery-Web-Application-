import "dotenv/config"
import mongoose from "mongoose"
import connectDb from "../config/db.js"
import { provisionAdmin } from "../utils/provisionAdmin.js"

const email = process.argv[2]

const run = async () => {
    if (!email) {
        console.error("Usage: npm run admin:provision -- <existing-account-email>")
        process.exitCode = 1
        return
    }

    await connectDb()
    const result = await provisionAdmin({ email })

    if (!result.ok) {
        if (result.reason === "not-found") {
            console.error(`No account found for ${result.email}. Create the account first, then provision Admin access.`)
        } else if (result.reason === "ambiguous-email") {
            console.error("Multiple accounts matched that email. Use the exact stored email address.")
        } else {
            console.error("An email address is required.")
        }
        process.exitCode = 1
        return
    }

    console.log(result.alreadyAdmin
        ? `${result.email} already has Admin access.`
        : `Admin access granted to ${result.email}.`)
}

run()
    .catch(() => {
        console.error("Admin provisioning failed.")
        process.exitCode = 1
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {})
    })
