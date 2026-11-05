import User from "./models/user.model.js"
import DeliveryAssignment from "./models/deliveryAssignment.model.js"
import jwt from "jsonwebtoken"
import { toValidCoordinates } from "./utils/validate.js"
import { isCurrentAuthVersion } from "./utils/authVersion.js"
import { hashSessionToken, isSessionTokenRevoked } from "./utils/sessionRevocation.js"
import { getJwtSecret } from "./config/security.js"

export { toValidCoordinates }

const AUTH_COOKIE_NAME = "token"
// No secrets are logged anywhere in this module: tokens, cookies and
// handshake payloads are discarded immediately after verification.

export const extractTokenFromCookieHeader = (cookieHeader) => {
  if (typeof cookieHeader !== "string" || cookieHeader === "") {
    return null
  }
  for (const entry of cookieHeader.split(";")) {
    const eq = entry.indexOf("=")
    if (eq === -1) {
      continue
    }
    if (entry.slice(0, eq).trim() === AUTH_COOKIE_NAME) {
      const value = entry.slice(eq + 1).trim()
      return value === "" ? null : value
    }
  }
  return null
}

// Engine.IO calls this before a Socket.IO connection is established. Browser
// handshakes must present an explicitly trusted Origin. A missing Origin is
// accepted only for non-browser clients that authenticate with
// socket.handshake.auth.token and therefore send no auth cookie; cookie-only
// handshakes without an Origin are treated as browser traffic and rejected.
// JWT verification still happens in socketAuthMiddleware for every connection.
export const createSocketOriginValidator = (allowedOrigins = []) => {
  const trustedOrigins = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : [])
  return (req, callback) => {
    const origin = req?.headers?.origin
    if (origin) {
      if (!trustedOrigins.has(origin)) {
        return callback("Origin not allowed", false)
      }
      return callback(null, true)
    }
    if (extractTokenFromCookieHeader(req?.headers?.cookie)) {
      return callback("Origin required for cookie authentication", false)
    }
    return callback(null, true)
  }
}

// Server-side credential check: identity is derived ONLY from the signed
// JWT carried either in socket.handshake.auth.token or in the auth cookie.
// A client-supplied userId is never trusted as proof of identity.
export const socketAuthMiddleware = async (socket, next) => {
  try {
    const token =
      (socket.handshake.auth && socket.handshake.auth.token) ||
      extractTokenFromCookieHeader(socket.handshake.headers?.cookie)

    if (!token) {
      return next(new Error("socket authentication required"))
    }

    let payload
    try {
      payload = jwt.verify(token, getJwtSecret())
    } catch (err) {
      return next(new Error("socket authentication failed"))
    }

    if (!payload || !payload.userId) {
      return next(new Error("socket authentication failed"))
    }

    if (!(await isCurrentAuthVersion(payload.userId, payload.authVersion))) {
      return next(new Error("socket authentication failed"))
    }

    if (await isSessionTokenRevoked(token)) {
      return next(new Error("socket authentication failed"))
    }

    socket.data.userId = String(payload.userId)
    socket.data.sessionHash = hashSessionToken(token)
    next()
  } catch (err) {
    return next(new Error("socket authentication failed"))
  }
}

export const roomForUser = (userId) => `user:${String(userId)}`
export const roomForSession = (sessionHash) => `session:${String(sessionHash)}`

const disconnectRoomSockets = (io, room) => {
  if (!io || typeof io.in !== "function" || !room) {
    return false
  }
  try {
    const target = io.in(room)
    if (!target || typeof target.disconnectSockets !== "function") {
      return false
    }
    target.disconnectSockets(true)
    return true
  } catch {
    console.error("socket: session revocation failed")
    return false
  }
}

export const disconnectUserSockets = (io, userId) => {
  if (userId === undefined || userId === null) {
    return false
  }
  return disconnectRoomSockets(io, roomForUser(userId))
}

export const disconnectSessionSockets = (io, sessionHash) => {
  if (typeof sessionHash !== "string" || sessionHash === "") {
    return false
  }
  return disconnectRoomSockets(io, roomForSession(sessionHash))
}

// Live socket registry per verified user id. The database socketId/isOnline
// fields are informational only: notification routing always uses the
// authenticated private room derived from the verified JWT identity.
const connectedSocketsByUser = new Map()

const registerConnectedSocket = (userId, socketId) => {
  const sockets = connectedSocketsByUser.get(userId)
  if (sockets) {
    sockets.add(socketId)
  } else {
    connectedSocketsByUser.set(userId, new Set([socketId]))
  }
}

const unregisterConnectedSocket = (userId, socketId) => {
  const sockets = connectedSocketsByUser.get(userId)
  if (!sockets) {
    return true
  }
  sockets.delete(socketId)
  if (sockets.size > 0) {
    return false
  }
  connectedSocketsByUser.delete(userId)
  return true
}

// Location updates are scoped: only the authenticated delivery boy's own
// currently-assigned order's customer (in their private room) receives
// them. There is no global broadcast of private delivery locations.
const broadcastDeliveryLocationToCustomer = async (io, deliveryBoyId, coordinates) => {
  try {
    const assignment = await DeliveryAssignment
      .findOne({ assignedTo: deliveryBoyId, status: "assigned" })
      .populate("order", "user")

    const customerId = assignment?.order?.user
    if (!customerId) {
      return
    }

    io.to(roomForUser(customerId)).emit("updateDeliveryLocation", {
      deliveryBoyId: String(deliveryBoyId),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude
    })
  } catch (err) {
    console.error("socket: failed to deliver location update")
  }
}

export const socketHandler = (io) => {
  io.use(socketAuthMiddleware)

  io.on("connection", (socket) => {
    const userId = socket.data.userId
    const sessionHash = socket.data.sessionHash

    socket.join(roomForUser(userId))
    if (sessionHash) {
      socket.join(roomForSession(sessionHash))
    }
    registerConnectedSocket(userId, socket.id)

    // Identity is established server-side from the verified credential;
    // the client no longer needs to (and cannot) claim an userId.
    ;(async () => {
      try {
        await User.findByIdAndUpdate(userId, {
          socketId: socket.id,
          isOnline: true
        }, { new: true })
      } catch (err) {
        console.error("socket: identity registration failed")
      }
    })()

    socket.on("updateLocation", async (payload) => {
      try {
        const body = payload || {}
        const coordinates = toValidCoordinates(body.latitude, body.longitude)
        if (!coordinates) {
          return
        }

        // Authorization: only delivery boys may broadcast live location.
        const isDeliveryBoy = await User.exists({ _id: userId, role: "deliveryBoy" })
        if (!isDeliveryBoy) {
          return
        }

        // Identity: the record updated is always the authenticated user's,
        // regardless of what the client claims.
        const updated = await User.findByIdAndUpdate(userId, {
          location: {
            type: "Point",
            coordinates: [coordinates.longitude, coordinates.latitude]
          },
          isOnline: true
        }, { new: true })

        if (updated) {
          await broadcastDeliveryLocationToCustomer(io, userId, coordinates)
        }
      } catch (err) {
        console.error("socket: updateLocation failed")
      }
    })

    socket.on("disconnect", async () => {
      try {
        const wasLastSocket = unregisterConnectedSocket(userId, socket.id)
        if (!wasLastSocket) {
          // Another tab or device for the same verified user is still live.
          return
        }
        await User.findByIdAndUpdate(userId, {
          socketId: null,
          isOnline: false
        })
      } catch (err) {
        console.error("socket: disconnect cleanup failed")
      }
    })
  })
}
