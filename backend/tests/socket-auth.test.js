import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { Server } from "socket.io"
import { MongoMemoryServer } from "mongodb-memory-server"

process.env.JWT_SECRET = "test_socket_auth_secret"
process.env.ALLOWED_ORIGIN = "http://localhost:5173"

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, "..", "..")

// Resolve the already-installed client package from frontend/node_modules
// without installing anything in the backend.
const requireFromFrontend = createRequire(
  path.join(projectRoot, "frontend", "socket-client-resolver.js")
)
const { io } = requireFromFrontend("socket.io-client")

import { socketHandler, socketAuthMiddleware, toValidCoordinates, roomForUser, roomForSession, createSocketOriginValidator, disconnectUserSockets, disconnectSessionSockets } from "../socket.js"
import { hashSessionToken, revokeSessionToken } from "../utils/sessionRevocation.js"
import User from "../models/user.model.js"
import Order from "../models/order.model.js"
import DeliveryAssignment from "../models/deliveryAssignment.model.js"

const SECRET = process.env.JWT_SECRET
const TRUSTED_ORIGIN = process.env.ALLOWED_ORIGIN
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (fn, timeoutMs = 4000, intervalMs = 50) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) {
      return value
    }
    await sleep(intervalMs)
  }
  return null
}

describe("Socket.IO strictly authenticated identity, authorization, and scoped events", () => {
  let ms
  let httpServer
  let ioServer

  const openSockets = new Set()
  let base

  const connectSocket = (token, { origin = TRUSTED_ORIGIN, cookie, auth } = {}) => new Promise((resolve, reject) => {
    const headers = {}
    if (origin !== null) {
      headers.origin = origin
    }
    const cookieHeader = cookie !== undefined ? cookie : (token ? `token=${token}` : null)
    if (cookieHeader) {
      headers.cookie = cookieHeader
    }
    const options = {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: headers
    }
    if (auth) {
      options.auth = auth
    }
    const client = io(base, options)
    openSockets.add(client)
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000)
    client.on("connect", () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.on("connect_error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  const closeEventually = async () => {
    for (const s of openSockets) {
      s.close()
    }
    openSockets.clear()
    await sleep(150)
  }

  const collect = (socket, event) => {
    const received = []
    socket.on(event, (data) => received.push(data))
    return received
  }

  const createUser = (role, suffix) => User.create({
    fullName: `${role}-${suffix}`,
    email: `${role}-${suffix}@test.local`,
    mobile: `90000${String(suffix).padStart(5, "0")}`,
    role
  })

  const tokenFor = (userId, authVersion) => jwt.sign(
    {
      userId: String(userId),
      jti: crypto.randomUUID(),
      ...(authVersion === undefined ? {} : { authVersion })
    },
    SECRET
  )

  before(async () => {
    ms = await MongoMemoryServer.create()
    await mongoose.connect(ms.getUri())

    httpServer = http.createServer()
    ioServer = new Server(httpServer, {
      allowRequest: createSocketOriginValidator([TRUSTED_ORIGIN]),
      cors: { origin: [TRUSTED_ORIGIN], credentials: true }
    })
    socketHandler(ioServer)
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${httpServer.address().port}`
  })

  after(async () => {
    await closeEventually()
    ioServer.close()
    httpServer.close()
    await mongoose.disconnect()
    await ms.stop()
  })

  test("unauthenticated connections are rejected without any listener running", async () => {
    await assert.rejects(
      () => connectSocket(null),
      (err) => /authentication required/i.test(String(err.message))
    )
  })

  test("invalid tokens are rejected", async () => {
    await assert.rejects(
      () => connectSocket("not-a-valid-firebase-jwt.not.a.token"),
      (err) => /authentication failed/i.test(String(err.message))
    )
  })

  test("server derives identity from the verified credential only (no client claim needed)", async () => {
    const boy = await createUser("deliveryBoy", "identity")
    const client = await connectSocket(tokenFor(boy._id))
    try {
      const updated = await waitFor(() => User.findById(boy._id).select("+socketId +isOnline").then((u) => u && u.socketId && u))
      assert.ok(updated, "socketId was registered server-side")
      assert.equal(String(updated._id), String(boy._id))
      assert.equal(updated.isOnline, true)
    } finally {
      client.close()
    }
  })

  test("a spoofed identity claim never updates another user's socketId", async () => {
    const boy = await createUser("deliveryBoy", "spoofv")
    const attacker = await createUser("user", "spoofat")
    const client = await connectSocket(tokenFor(attacker._id))
    try {
      // Attacker may attempt any claim; server ignores client userId entirely.
      const registered = await waitFor(() => User.findById(attacker._id).select("+socketId +isOnline").then(
        (u) => u && u.socketId && u
      ))
      assert.ok(registered)
      const fresh = await User.findById(boy._id)
      assert.ok(!fresh.socketId, "delivery boy's socketId must remain unset")
      assert.equal(String(fresh._id), String(boy._id))
    } finally {
      client.close()
    }
  })

  test("unauthorized location update targeting another user is ignored", async () => {
    const boy = await createUser("deliveryBoy", "spoofloc")
    const attacker = await createUser("user", "locatkr")
    const client = await connectSocket(tokenFor(attacker._id))
    try {
      const seenOnAttacker = collect(client, "updateDeliveryLocation")
      client.emit("updateLocation", {
        userId: String(boy._id),
        latitude: 18.5204,
        longitude: 73.8567
      })
      await sleep(700)
      const freshBoy = await User.findById(boy._id)
      assert.equal(freshBoy.isOnline, false)
      assert.deepEqual([...freshBoy.location.coordinates], [0, 0])
      assert.equal(seenOnAttacker.length, 0)
    } finally {
      client.close()
    }
  })

  test("role authorization: only deliveryBoy role may broadcast location", async () => {
    const customer = await createUser("user", "rolecst")
    const client = await connectSocket(tokenFor(customer._id))
    try {
      client.emit("updateLocation", { latitude: 19.0728, longitude: 72.8826 })
      await sleep(700)
      const fresh = await User.findById(customer._id)
      assert.deepEqual([...fresh.location.coordinates], [0, 0])
    } finally {
      client.close()
    }
  })

  test("authorized deliveryBoy update reaches only its assigned order's customer", async () => {
    const customer = await createUser("user", "cscust")
    const boy = await createUser("deliveryBoy", "csboy")
    const randomUser = await createUser("user", "csjmpc")
    const order = await Order.create({
      user: customer._id,
      paymentMethod: "cod",
      deliveryAddress: { text: "test address", latitude: 18.5, longitude: 73.8 },
      totalAmount: 100,
      shopOrders: []
    })
    await DeliveryAssignment.create({
      order: order._id,
      shopOrderId: new mongoose.Types.ObjectId(),
      brodcastedTo: [boy._id],
      assignedTo: boy._id,
      status: "assigned"
    })

    const customerClient = await connectSocket(tokenFor(customer._id))
    const boyClient = await connectSocket(tokenFor(boy._id))
    const randomClient = await connectSocket(tokenFor(randomUser._id))
    try {
      const customerSeen = collect(customerClient, "updateDeliveryLocation")
      const randomSeen = collect(randomClient, "updateDeliveryLocation")
      const boySeen = collect(boyClient, "updateDeliveryLocation")

      boyClient.emit("updateLocation", { latitude: 18.5204, longitude: 73.8567 })

      const received = await waitFor(() => customerSeen.length > 0 && customerSeen)
      assert.ok(received, "customer should receive exactly one scoped event")

      const payload = customerSeen[0]
      assert.equal(String(payload.deliveryBoyId), String(boy._id))
      assert.equal(payload.latitude, 18.5204)
      assert.equal(payload.longitude, 73.8567)

      const freshBoy = await User.findById(boy._id).select("+socketId +isOnline")
      assert.deepEqual([...freshBoy.location.coordinates], [73.8567, 18.5204])

      await sleep(400)
      assert.equal(randomSeen.length, 0, "unauthorized users must not receive the broadcast")
      assert.equal(boySeen.length, 0, "the delivery boy himself must not receive his own broadcast")
    } finally {
      customerClient.close()
      boyClient.close()
      randomClient.close()
    }
  })

  test("invalid coordinates are rejected without side effects", async () => {
    const customer = await createUser("user", "badcst")
    const boy = await createUser("deliveryBoy", "badboy")
    const order = await Order.create({
      user: customer._id,
      paymentMethod: "cod",
      deliveryAddress: { text: "addr", latitude: 18.5, longitude: 73.8 },
      totalAmount: 100,
      shopOrders: []
    })
    await DeliveryAssignment.create({
      order: order._id,
      shopOrderId: new mongoose.Types.ObjectId(),
      brodcastedTo: [boy._id],
      assignedTo: boy._id,
      status: "assigned"
    })

    const boyClient = await connectSocket(tokenFor(boy._id))
    const customerClient = await connectSocket(tokenFor(customer._id))
    try {
      const seenOnCustomer = collect(customerClient, "updateDeliveryLocation")
      const invalidPayloads = [
        { latitude: Number.NaN, longitude: 10 },
        { latitude: 10, longitude: Number.NaN },
        { latitude: 95, longitude: 10 },
        { latitude: 10, longitude: 190 },
        { latitude: "18.5204", longitude: 10 },
        { latitude: Infinity, longitude: 10 },
        {},
        undefined
      ]
      for (const payload of invalidPayloads) {
        boyClient.emit("updateLocation", payload)
      }

      await waitFor(() => false, 600)
      const fresh = await User.findById(boy._id).select("+socketId +isOnline")
      assert.deepEqual([...fresh.location.coordinates], [0, 0])
      assert.equal(seenOnCustomer.length, 0)
      assert.equal(boyClient.connected, true, "malformed events must not disconnect the client")
    } finally {
      boyClient.close()
      customerClient.close()
    }
  })

  // D1: multi-tab / multi-device delivery uses per-user private rooms instead
  // of one mutable stored socketId. These tests exercise the live registry.
  test("two authenticated sockets for the same user both receive a private-room notification", async () => {
    const boy = await createUser("deliveryBoy", "multipane")
    const first = await connectSocket(tokenFor(boy._id))
    const second = await connectSocket(tokenFor(boy._id))
    try {
      const firstSeen = collect(first, "newAssignment")
      const secondSeen = collect(second, "newAssignment")

      const room = roomForUser(boy._id)
      const joined = await waitFor(() =>
        ioServer.in(room).allSockets().then((set) => set.size === 2)
      )
      assert.ok(joined, "both sockets must have joined the user's private room")

      ioServer.to(room).emit("newAssignment", {
        sentTo: String(boy._id),
        assignmentId: String(new mongoose.Types.ObjectId()),
        orderId: String(new mongoose.Types.ObjectId()),
        shopName: "Multi-tab shop",
        deliveryAddress: { text: "somewhere" },
        items: [],
        subtotal: 100
      })

      const firstDelivery = await waitFor(() => firstSeen.length > 0)
      const secondDelivery = await waitFor(() => secondSeen.length > 0)
      assert.ok(firstDelivery, "first tab received the notification")
      assert.ok(secondDelivery, "second tab received the notification")
      assert.equal(firstSeen[0].assignmentId, secondSeen[0].assignmentId)
      assert.equal(firstSeen[0].sentTo, String(boy._id))
    } finally {
      second.close()
      first.close()
    }
  })

  test("disconnecting one socket keeps the user online and the remaining socket delivers", async () => {
    const boy = await createUser("deliveryBoy", "hasplusone")
    const first = await connectSocket(tokenFor(boy._id))
    const second = await connectSocket(tokenFor(boy._id))
    try {
      const secondSeen = collect(second, "newAssignment")
      const room = roomForUser(boy._id)
      await waitFor(() => ioServer.in(room).allSockets().then((set) => set.size === 2))

      first.close()
      await waitFor(() => ioServer.in(room).allSockets().then((set) => set.size === 1))

      await sleep(400)
      const afterFirstClose = await User.findById(boy._id).select("+socketId +isOnline")
      assert.equal(afterFirstClose.isOnline, true, "user must stay online while another socket remains")

      ioServer.to(room).emit("newAssignment", {
        sentTo: String(boy._id),
        assignmentId: String(new mongoose.Types.ObjectId())
      })
      const delivered = await waitFor(() => secondSeen.length > 0)
      assert.ok(delivered, "remaining socket still receives private-room notifications")

      second.close()
      const afterLastClose = await waitFor(() =>
        User.findById(boy._id).select("+socketId +isOnline").then((u) => u && u.isOnline === false && u.socketId === null && u)
      )
      assert.ok(afterLastClose, "last socket down: user is marked offline once")
      assert.equal((await ioServer.in(room).allSockets()).size, 0)
    } finally {
      first.close()
      second.close()
    }
  })

  test("a user in another private room never receives someone else's notification", async () => {
    const boy = await createUser("deliveryBoy", "targeted")
    const outsider = await createUser("user", "outside")
    const outsiderClient = await connectSocket(tokenFor(outsider._id))
    const boyClient = await connectSocket(tokenFor(boy._id))
    try {
      const outsiderSeen = collect(outsiderClient, "newAssignment")
      const boySeen = collect(boyClient, "newAssignment")
      await waitFor(() => ioServer.in(roomForUser(boy._id)).allSockets().then((set) => set.size === 1))

      ioServer.to(roomForUser(boy._id)).emit("newAssignment", {
        sentTo: String(boy._id),
        assignmentId: String(new mongoose.Types.ObjectId())
      })

      const delivered = await waitFor(() => boySeen.length > 0)
      assert.ok(delivered, "the intended user receives the notification")
      await sleep(300)
      assert.equal(outsiderSeen.length, 0, "another private room must not receive it")
    } finally {
      boyClient.close()
      outsiderClient.close()
    }
  })

  describe("WebSocket handshake origin validation", () => {
    test("trusted-origin browser-style cookie connections establish and join the verified private room", async () => {
      const user = await createUser("user", "origin-trusted")
      const client = await connectSocket(tokenFor(user._id))
      try {
        assert.equal(client.connected, true)
        const joined = await waitFor(async () => {
          const sockets = await ioServer.in(roomForUser(user._id)).allSockets()
          return sockets.has(client.id)
        })
        assert.ok(joined, "a trusted-origin cookie client joins its verified private room")
      } finally {
        client.close()
        openSockets.delete(client)
      }
    })

    test("untrusted origins are rejected before the socket connection is established", async () => {
      const user = await createUser("user", "origin-untrusted")
      await assert.rejects(
        () => connectSocket(tokenFor(user._id), { origin: "https://evil.example" })
      )
    })

    test("missing Origin is rejected for cookie-authenticated connections", async () => {
      const user = await createUser("user", "origin-missing-cookie")
      await assert.rejects(
        () => connectSocket(null, {
          origin: null,
          cookie: `token=${tokenFor(user._id)}`
        })
      )
    })

    test("non-browser token clients may omit Origin and authenticate from the handshake token", async () => {
      const user = await createUser("user", "origin-token-client")
      const client = await connectSocket(null, {
        origin: null,
        auth: { token: tokenFor(user._id) }
      })
      try {
        assert.equal(client.connected, true)
        const joined = await waitFor(async () => {
          const sockets = await ioServer.in(roomForUser(user._id)).allSockets()
          return sockets.has(client.id)
        })
        assert.ok(joined, "a token-authenticated non-browser client joins its verified private room")
      } finally {
        client.close()
        openSockets.delete(client)
      }
    })

    test("expired JWTs remain rejected on trusted origins", async () => {
      const user = await createUser("user", "origin-expired")
      const expired = jwt.sign({ userId: String(user._id) }, SECRET, { expiresIn: -1 })
      await assert.rejects(
        () => connectSocket(expired),
        (err) => /authentication failed/i.test(String(err.message))
      )
    })
  })

  test("session logout disconnects only its own socket and rejects its reconnect", async () => {
    const user = await createUser("user", "sessionrev")
    const revokedToken = tokenFor(user._id, 0)
    const otherSessionToken = tokenFor(user._id, 0)
    assert.notEqual(revokedToken, otherSessionToken)

    const revokedClient = await connectSocket(revokedToken)
    const otherClient = await connectSocket(otherSessionToken)
    try {
      const revokedHash = hashSessionToken(revokedToken)
      assert.equal(await revokeSessionToken(revokedToken, jwt.decode(revokedToken)), revokedHash)
      assert.equal(disconnectSessionSockets(ioServer, revokedHash), true)

      const disconnected = await waitFor(() => revokedClient.connected === false)
      assert.ok(disconnected, "the logged-out session's socket must be disconnected")
      assert.equal(otherClient.connected, true, "another session for the same user must stay connected")

      await assert.rejects(
        () => connectSocket(revokedToken),
        (err) => /authentication failed/i.test(String(err.message))
      )

      const replacement = await connectSocket(otherSessionToken)
      try {
        assert.equal(replacement.connected, true)
        const joined = await waitFor(async () => {
          const sockets = await ioServer.in(roomForSession(hashSessionToken(otherSessionToken))).allSockets()
          return sockets.has(replacement.id)
        })
        assert.ok(joined, "the unaffected session joins its own session room")
      } finally {
        replacement.close()
        openSockets.delete(replacement)
      }
    } finally {
      revokedClient.close()
      otherClient.close()
      openSockets.delete(revokedClient)
      openSockets.delete(otherClient)
    }
  })

  test("a version change disconnects active sockets and rejects the old credential", async () => {
    const user = await createUser("user", "revoked")
    const oldToken = tokenFor(user._id, 0)
    const oldClient = await connectSocket(oldToken)
    try {
      assert.equal(oldClient.connected, true)

      await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1 } })
      assert.equal(disconnectUserSockets(ioServer, user._id), true)
      const disconnected = await waitFor(() => oldClient.connected === false)
      assert.ok(disconnected, "the active socket must be disconnected")

      await assert.rejects(
        () => connectSocket(oldToken),
        (err) => /authentication failed/i.test(String(err.message))
      )

      const freshClient = await connectSocket(tokenFor(user._id, 1))
      try {
        assert.equal(freshClient.connected, true)
        const joined = await waitFor(async () => {
          const sockets = await ioServer.in(roomForUser(user._id)).allSockets()
          return sockets.has(freshClient.id)
        })
        assert.ok(joined, "the post-reset credential joins the private room")
      } finally {
        freshClient.close()
        openSockets.delete(freshClient)
      }
    } finally {
      oldClient.close()
      openSockets.delete(oldClient)
    }
  })
})

describe("socket auth middleware and coordinate validation (unit)", () => {
  let unitMs

  before(async () => {
    unitMs = await MongoMemoryServer.create()
    await mongoose.connect(unitMs.getUri())
  })

  after(async () => {
    await mongoose.disconnect()
    await unitMs.stop()
  })

  const runMiddleware = (socket) => new Promise((resolve) => {
    socketAuthMiddleware(socket, (error) => resolve(error))
  })

  test("socketAuthMiddleware rejects requests without a credential", async () => {
    const socket = { handshake: { auth: {}, headers: {} }, data: {} }
    const error = await runMiddleware(socket)
    assert.ok(error)
    assert.match(String(error.message), /authentication required/i)
    assert.equal(socket.data.userId, undefined)
  })

  test("socketAuthMiddleware validates the cookie JWT and derives userId purely from the verified payload", async () => {
    const user = await User.create({
      fullName: "Socket Unit",
      email: `socket-unit-${Date.now()}@t.com`,
      mobile: "9000000088",
      role: "user",
      authVersion: 1
    })
    const validToken = jwt.sign({ userId: String(user._id), authVersion: 1 }, SECRET)
    const socket = {
      handshake: {
        auth: { userId: "spoofed-client-claim" },
        headers: { cookie: `token=${validToken}; other=1` }
      },
      data: {}
    }
    const error = await runMiddleware(socket)
    assert.ifError(error)
    assert.equal(socket.data.userId, String(user._id))
  })

  test("socketAuthMiddleware rejects a tampered JWT", async () => {
    const socket = { handshake: { auth: {}, headers: { cookie: "x=1; tampered=2; token=abc.def.ghi" } }, data: {} }
    const error = await runMiddleware(socket)
    assert.ok(error)
    assert.match(String(error.message), /authentication failed/i)
  })

  test("socketAuthMiddleware rejects a stale auth version", async () => {
    const user = await User.create({
      fullName: "Socket Stale",
      email: `socket-stale-${Date.now()}@t.com`,
      mobile: "9000000087",
      role: "user",
      authVersion: 2
    })
    const staleToken = jwt.sign({ userId: String(user._id), authVersion: 1 }, SECRET)
    const socket = {
      handshake: { auth: { token: staleToken }, headers: {} },
      data: {}
    }
    const error = await runMiddleware(socket)
    assert.ok(error)
    assert.match(String(error.message), /authentication failed/i)
    assert.equal(socket.data.userId, undefined)
  })

  test("toValidCoordinates enforces numeric types and range bounds", () => {
    assert.deepEqual(toValidCoordinates(0, 0), { latitude: 0, longitude: 0 })
    assert.deepEqual(toValidCoordinates(-90, -180), { latitude: -90, longitude: -180 })
    assert.deepEqual(toValidCoordinates(90, 180), { latitude: 90, longitude: 180 })
    assert.equal(toValidCoordinates(Number.NaN, 10), null)
    assert.equal(toValidCoordinates(10, Number.NaN), null)
    assert.equal(toValidCoordinates(95, 10), null)
    assert.equal(toValidCoordinates(10, 200), null)
    assert.equal(toValidCoordinates("10", 10), null)
    assert.equal(toValidCoordinates(undefined, 10), null)
    assert.equal(toValidCoordinates(Infinity, 10), null)
    assert.equal(toValidCoordinates(10, Infinity), null)
  })
})

// D1: producers must resolve their emit target from the verified identity
// (roomForUser), never from the mutable per-user socketId field.
describe("notification producers route through the authenticated private room", () => {
  test("all four producers emit to a roomForUser room and no socketId-based routing remains", async () => {
    const source = await readFile(path.resolve(here, "..", "controllers", "order.controllers.js"), "utf8")

    assert.match(source, /import \{ roomForUser \} from "\.\.\/socket\.js"/)

    const roomEmits = (source.match(/io\.to\(roomForUser\(/g) || []).length
    assert.equal(roomEmits, 4, "newOrder x2, newAssignment and update-status must target private rooms")

    assert.ok(!source.includes("ownerSocketId"), "order owners must not be routed via a stored socketId")
    assert.ok(!source.includes("boySocketId"), "assignment broadcasts must not be routed via a stored socketId")
    assert.ok(!source.includes("userSocketId"), "customer status must not be routed via a stored socketId")

    const newOrderEmits = (source.match(/\.emit\('newOrder'/g) || []).length
    const newAssignmentEmits = (source.match(/\.emit\('newAssignment'/g) || []).length
    const updateStatusEmits = (source.match(/\.emit\('update-status'/g) || []).length
    assert.equal(newOrderEmits, 2, "placeOrder and verifyPayment both emit newOrder")
    assert.equal(newAssignmentEmits, 1)
    assert.equal(updateStatusEmits, 1)
  })
})

describe("Socket.IO handshake origin validator (unit)", () => {
  const validate = (headers) => new Promise((resolve) => {
    createSocketOriginValidator([TRUSTED_ORIGIN])({ headers }, (message, success) => {
      resolve({ message, success })
    })
  })

  test("allows an explicitly trusted Origin", async () => {
    assert.deepEqual(await validate({ origin: TRUSTED_ORIGIN }), { message: null, success: true })
  })

  test("rejects an untrusted Origin without echoing it", async () => {
    const result = await validate({ origin: "https://evil.example" })
    assert.equal(result.success, false)
    assert.equal(result.message, "Origin not allowed")
  })

  test("requires an Origin when an auth cookie is present", async () => {
    const result = await validate({ cookie: "token=opaque" })
    assert.equal(result.success, false)
    assert.match(result.message, /origin required/i)
  })

  test("allows a missing Origin only when no auth cookie is present", async () => {
    assert.deepEqual(await validate({}), { message: null, success: true })
    assert.deepEqual(await validate({ cookie: "other=1" }), { message: null, success: true })
  })

  test("the production server wires the validator into Engine.IO before accepting connections", async () => {
    const source = await readFile(path.resolve(here, "..", "index.js"), "utf8")
    assert.match(source, /import \{ socketHandler, createSocketOriginValidator \} from "\.\/socket\.js"/)
    assert.match(source, /allowRequest:\s*createSocketOriginValidator\(allowedOrigins\)/)
  })
})
