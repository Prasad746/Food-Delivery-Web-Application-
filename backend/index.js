import express from "express"
import helmet from "helmet"
import path from "node:path"
import { pathToFileURL } from "node:url"
import mongoose from "mongoose"
import connectDb from "./config/db.js"
import { assertRateLimitConfig, getRateLimitConfig } from "./config/rateLimit.js"
import { SecurityConfigError, createTrustedProxyChecker, loadSecurityConfig } from "./config/security.js"
import { initializeRateLimitStore as initializeDefaultRateLimitStore } from "./middlewares/mongoRateLimitStore.js"
import cookieParser from "cookie-parser"
import authRouter from "./routes/auth.routes.js"
import cors from "cors"
import userRouter from "./routes/user.routes.js"
import itemRouter from "./routes/item.routes.js"
import shopRouter from "./routes/shop.routes.js"
import orderRouter from "./routes/order.routes.js"
import adminRouter from "./routes/admin.routes.js"
import supportRouter from "./routes/support.routes.js"
import { createHealthRouter } from "./routes/health.routes.js"
import { createCsrfHandlers } from "./middlewares/csrf.js"
import { errorHandler } from "./middlewares/errorHandler.js"
import http from "http"
import { Server } from "socket.io"
import { socketHandler, createSocketOriginValidator } from "./socket.js"

const DEFAULT_PORT = 5000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000

export const createApplication = (securityConfig, {
    getDatabaseConnectionState = () => mongoose.connection.readyState
} = {}) => {
    const { allowedOrigins, trustedProxyCidrs = [] } = securityConfig
    const { csrfBootstrap, csrfMiddleware } = createCsrfHandlers(securityConfig)
    const app=express()
    const server=http.createServer(app)

    app.set("trust proxy", createTrustedProxyChecker(trustedProxyCidrs))

    const io=new Server(server,{
       // CORS does not protect WebSocket upgrades; validate the handshake Origin
       // before Engine.IO establishes a connection.
       allowRequest: createSocketOriginValidator(allowedOrigins),
       cors:{
        origin: allowedOrigins,
        credentials: true,
        methods: ['POST', 'GET']
    }
    })

    app.set("io",io)

    app.use(helmet())
    app.use(cors({
        origin: allowedOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
     }))
    app.use(express.json())
    app.use(cookieParser())
    app.use(createHealthRouter({ getConnectionState: getDatabaseConnectionState }))
    // CSRF middleware: OPTIONS handled by CORS; bootstrap + token validation on state-changing routes
    app.use("/api/csrf-token", csrfBootstrap)
    // State-changing API routes: Origin validation + CSRF token verification
    app.use("/api/auth", csrfMiddleware, authRouter)
    app.use("/api/user", csrfMiddleware, userRouter)
    app.use("/api/shop", csrfMiddleware, shopRouter)
    app.use("/api/item", csrfMiddleware, itemRouter)
    app.use("/api/order", csrfMiddleware, orderRouter)
    app.use("/api/admin", csrfMiddleware, adminRouter)
    app.use("/api/support", csrfMiddleware, supportRouter)
    // Global error handling middleware: must stay last so every route error is caught.
    app.use(errorHandler)
    socketHandler(io)

    return { app, server, io }
}

export const startServer = async ({
    securityConfig,
    configLoader,
    rateLimitConfig,
    connectDatabase = connectDb,
    initializeRateLimitStore = initializeDefaultRateLimitStore,
    buildApplication = createApplication,
    startListening = listenServer,
    port = process.env.PORT || DEFAULT_PORT,
    logger = console
} = {}) => {
    const resolvedSecurityConfig = securityConfig || (configLoader ? configLoader() : loadSecurityConfig())
    const resolvedRateLimitConfig = assertRateLimitConfig(rateLimitConfig || getRateLimitConfig())
    await connectDatabase()
    await initializeRateLimitStore(resolvedRateLimitConfig)
    const components = buildApplication(resolvedSecurityConfig)
    await startListening(components.server, port)
    logger.log(`server started at ${port}`)
    return { ...components, securityConfig: resolvedSecurityConfig }
}

const listenServer = (server, port) => new Promise((resolve, reject) => {
    const onError = (error) => {
        server.off("listening", onListening)
        reject(error)
    }
    const onListening = () => {
        server.off("error", onError)
        resolve()
    }

    server.once("error", onError)
    server.once("listening", onListening)
    try {
        server.listen(port)
    } catch (error) {
        server.off("error", onError)
        server.off("listening", onListening)
        reject(error)
    }
})

const closeHttpServer = (server) => new Promise((resolve) => {
    if (!server || typeof server.close !== "function" || server.listening === false) {
        return resolve()
    }
    try {
        server.close(() => resolve())
    } catch {
        resolve()
    }
})

const closeSocketServer = (io) => new Promise((resolve) => {
    if (!io || typeof io.close !== "function") {
        return resolve()
    }
    try {
        io.close(() => resolve())
    } catch {
        resolve()
    }
})

export const createShutdownHandler = ({
    server,
    io,
    disconnectDatabase = () => mongoose.disconnect(),
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    logger = console,
    exit = process.exit
} = {}) => {
    let shutdownStarted = false

    return async () => {
        if (shutdownStarted) {
            return
        }
        shutdownStarted = true

        let timeoutId
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("shutdown timeout")), timeoutMs)
        })
        const cleanup = (async () => {
            await Promise.all([closeHttpServer(server), closeSocketServer(io)])
            await disconnectDatabase()
        })()

        try {
            await Promise.race([cleanup, timeout])
            clearTimeout(timeoutId)
            logger.log("Server shut down")
            exit(0)
        } catch {
            clearTimeout(timeoutId)
            logger.error("Server shutdown failed or timed out")
            exit(1)
        }
    }
}

const registerShutdownHandlers = (resources, options = {}) => {
    const shutdown = createShutdownHandler({ ...resources, ...options })
    const onSignal = () => {
        void shutdown()
    }
    process.once("SIGTERM", onSignal)
    process.once("SIGINT", onSignal)
    return shutdown
}

export const runServer = async ({
    exit = process.exit,
    logger = console,
    registerShutdown = registerShutdownHandlers,
    ...startupOptions
} = {}) => {
    try {
        const resources = await startServer({ ...startupOptions, logger })
        registerShutdown(resources)
        return resources
    } catch (error) {
        if (error instanceof SecurityConfigError) {
            logger.error(`Security configuration error: ${error.message}`)
        } else {
            logger.error("Server startup failed")
        }
        exit(1)
        return null
    }
}

const isMainModule = () => {
    if (!process.argv[1]) {
        return false
    }
    try {
        return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    } catch {
        return false
    }
}

if (isMainModule()) {
    void runServer().catch(() => {
        console.error("Server startup failed")
        process.exit(1)
    })
}
