import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"

let appInitialized = false

export const initializeFirebaseAdmin = () => {
  if (appInitialized || getApps().length > 0) {
    appInitialized = true
    return true
  }

  // Check for required credentials
  const hasPrivateKey = process.env.FIREBASE_PRIVATE_KEY
  const hasClientEmail = process.env.FIREBASE_CLIENT_EMAIL

  if (!hasPrivateKey || !hasClientEmail) {
    console.warn(
      "Firebase Admin SDK not configured: set FIREBASE_PRIVATE_KEY and FIREBASE_CLIENT_EMAIL in .env"
    )
    return false
  }

  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")

    initializeApp({
      credential: cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: privateKey,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    })

    appInitialized = true
    console.log("Firebase Admin SDK initialized successfully")
    return true
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error)
    return false
  }
}

export const verifyFirebaseIdToken = async (idToken) => {
  const initialized = initializeFirebaseAdmin()

  // Fail closed when the Admin SDK could not be initialized
  if (!initialized) {
    const configError = new Error("Firebase Admin SDK is not configured")
    configError.code = "firebase/not-configured"
    throw configError
  }

  try {
    return await getAuth().verifyIdToken(idToken)
  } catch (error) {
    console.error("Firebase ID token verification error:", error?.message)
    const firebaseError = new Error("Invalid or expired Firebase ID token")
    firebaseError.code = error?.code || "firebase/token-unvalid"
    throw firebaseError
  }
}

export default { verifyFirebaseIdToken, initializeFirebaseAdmin }
