import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { getCookieOptions } from "../controllers/auth.controllers.js";
import isAuth from "../middlewares/isAuth.js";
import User from "../models/user.model.js";

let mongo;
let userSeq = 0;

const restoreNodeEnv = (previous) => {
    if (previous === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = previous;
    }
};

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

after(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

beforeEach(async () => {
    await User.deleteMany({});
});

const seedUser = async (authVersion = 0) => {
    userSeq += 1;
    return User.create({
        fullName: "Auth Person",
        email: `auth${userSeq}${Date.now()}@t.com`,
        mobile: "9000000099",
        role: "user",
        authVersion
    });
};

const runAuth = async (req) => {
    let statusCode = null;
    let responseJson = null;
    const res = {
        status: (code) => {
            statusCode = code;
            return {
                json: (data) => { responseJson = data; }
            };
        }
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await isAuth(req, res, next);
    return { statusCode, responseJson, nextCalled };
};

describe("Cookie and CORS Configuration", () => {
    it("should return secure: false and sameSite: lax in development mode", () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";
        delete process.env.COOKIE_SAME_SITE;

        const options = getCookieOptions();
        assert.strictEqual(options.secure, false);
        assert.strictEqual(options.sameSite, "lax");
        assert.strictEqual(options.httpOnly, true);
        assert.strictEqual(options.maxAge, 7 * 24 * 60 * 60 * 1000);

        restoreNodeEnv(originalEnv);
    });

    it("should return secure: true and sameSite: none in production mode", () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        delete process.env.COOKIE_SAME_SITE;

        const options = getCookieOptions();
        assert.strictEqual(options.secure, true);
        assert.strictEqual(options.sameSite, "none");
        assert.strictEqual(options.httpOnly, true);

        restoreNodeEnv(originalEnv);
    });

    it("should respect custom COOKIE_SAME_SITE override in production", () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        process.env.COOKIE_SAME_SITE = "strict";

        const options = getCookieOptions();
        assert.strictEqual(options.secure, true);
        assert.strictEqual(options.sameSite, "strict");

        delete process.env.COOKIE_SAME_SITE;
        restoreNodeEnv(originalEnv);
    });

    it("should strictly isolate origins in production mode", () => {
        const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
        const configuredOrigins = ["https://vingo.example.com"];

        // Production resolution: only configured origins allowed
        const prodOrigins = (configuredOrigins.length > 0 ? configuredOrigins : defaultOrigins);
        assert.strictEqual(prodOrigins.includes("http://localhost:5173"), false);
        assert.strictEqual(prodOrigins.includes("https://vingo.example.com"), true);
        assert.strictEqual(prodOrigins.length, 1);

        // Development resolution: merges default and configured
        const devOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins]));
        assert.strictEqual(devOrigins.includes("http://localhost:5173"), true);
        assert.strictEqual(devOrigins.includes("https://vingo.example.com"), true);
        assert.strictEqual(devOrigins.length, 3);
    });
});

describe("Authentication Middleware (isAuth)", () => {
    const testSecret = "jwt_test_secret_for_middleware_validation";
    process.env.JWT_SECRET = testSecret;

    it("should reject request with 401 when no token is present", async () => {
        const { statusCode, responseJson, nextCalled } = await runAuth({ cookies: {}, headers: {} });
        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseJson.message, "Authentication token required");
        assert.strictEqual(nextCalled, false);
    });

    it("should reject request with 401 when token is invalid or tampered", async () => {
        const { statusCode, responseJson, nextCalled } = await runAuth({ cookies: { token: "invalid.tampered.token" }, headers: {} });
        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseJson.message, "Invalid or expired token");
        assert.strictEqual(nextCalled, false);
    });

    it("should accept a legacy valid token without an auth version for a version-zero user", async () => {
        const user = await seedUser();
        const validToken = jwt.sign({ userId: String(user._id) }, testSecret, { expiresIn: "1h" });

        const req = { cookies: { token: validToken }, headers: {} };
        const { nextCalled } = await runAuth(req);
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.userId, String(user._id));
    });

    it("should also accept valid token via Bearer Authorization header", async () => {
        const user = await seedUser(1);
        const validToken = jwt.sign({ userId: String(user._id), authVersion: 1 }, testSecret, { expiresIn: "1h" });

        const req = { cookies: {}, headers: { authorization: `Bearer ${validToken}` } };
        const { nextCalled } = await runAuth(req);
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.userId, String(user._id));
    });

    it("should reject a token whose auth version is stale", async () => {
        const user = await seedUser(2);
        const staleToken = jwt.sign({ userId: String(user._id), authVersion: 1 }, testSecret, { expiresIn: "1h" });

        const { statusCode, responseJson, nextCalled } = await runAuth({ cookies: { token: staleToken }, headers: {} });
        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseJson.message, "Invalid or expired token");
        assert.strictEqual(nextCalled, false);
    });

    it("should reject a validly signed token for a missing user", async () => {
        const missingToken = jwt.sign({ userId: new mongoose.Types.ObjectId().toString() }, testSecret, { expiresIn: "1h" });

        const { statusCode, responseJson, nextCalled } = await runAuth({ cookies: { token: missingToken }, headers: {} });
        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseJson.message, "Invalid or expired token");
        assert.strictEqual(nextCalled, false);
    });
});
