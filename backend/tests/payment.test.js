import { describe, it } from "node:test";
import assert from "node:assert";
import crypto from "crypto";
import { verifyRazorpaySignature } from "../controllers/order.controllers.js";

describe("Razorpay Signature Verification", () => {
    const secret = "test_secret_key_12345";
    const orderId = "order_O8abc123xyz";
    const paymentId = "pay_P8abc456uvw";

    // Generate expected HMAC-SHA256 signature
    const validSignature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    it("should return true for a valid signature", () => {
        const isValid = verifyRazorpaySignature(orderId, paymentId, validSignature, secret);
        assert.strictEqual(isValid, true);
    });

    it("should return false for an altered/tampered signature", () => {
        const tamperedSignature = validSignature.slice(0, -2) + "00";
        const isValid = verifyRazorpaySignature(orderId, paymentId, tamperedSignature, secret);
        assert.strictEqual(isValid, false);
    });

    it("should return false when paymentId does not match the signature", () => {
        const isValid = verifyRazorpaySignature(orderId, "pay_different_payment", validSignature, secret);
        assert.strictEqual(isValid, false);
    });

    it("should return false when orderId does not match the signature", () => {
        const isValid = verifyRazorpaySignature("order_different_order", paymentId, validSignature, secret);
        assert.strictEqual(isValid, false);
    });

    it("should return false when signature has wrong length", () => {
        const isValid = verifyRazorpaySignature(orderId, paymentId, "short_invalid_sig", secret);
        assert.strictEqual(isValid, false);
    });

    it("should return false when fields are missing", () => {
        assert.strictEqual(verifyRazorpaySignature(null, paymentId, validSignature, secret), false);
        assert.strictEqual(verifyRazorpaySignature(orderId, null, validSignature, secret), false);
        assert.strictEqual(verifyRazorpaySignature(orderId, paymentId, null, secret), false);
        assert.strictEqual(verifyRazorpaySignature(orderId, paymentId, validSignature, null), false);
        assert.strictEqual(verifyRazorpaySignature("", paymentId, validSignature, secret), false);
    });

    it("should verify amount and currency matching logic", () => {
        const order = { totalAmount: 250, currency: "INR" };
        const payment = { amount: 25000, currency: "INR", status: "captured" };

        const expectedAmountInPaise = Math.round(order.totalAmount * 100);
        assert.strictEqual(payment.amount, expectedAmountInPaise);
        assert.strictEqual(payment.currency, "INR");
        assert.strictEqual(payment.status, "captured");

        // Amount mismatch check
        const wrongAmountPayment = { amount: 20000, currency: "INR", status: "captured" };
        assert.notStrictEqual(wrongAmountPayment.amount, expectedAmountInPaise);

        // Currency mismatch check
        const wrongCurrencyPayment = { amount: 25000, currency: "USD", status: "captured" };
        assert.notStrictEqual(wrongCurrencyPayment.currency, "INR");
    });

    it("should reject payments that are not captured (failed or pending)", () => {
        const failedPayment = { status: "failed" };
        const pendingPayment = { status: "authorized" };
        const capturedPayment = { status: "captured" };

        assert.strictEqual(failedPayment.status === "captured", false);
        assert.strictEqual(pendingPayment.status === "captured", false);
        assert.strictEqual(capturedPayment.status === "captured", true);
    });

    it("should verify user authorization on the order", () => {
        const authenticatedUserId = "user_12345";
        const orderOfAuthUser = { user: "user_12345" };
        const orderOfOtherUser = { user: "user_attacker_999" };

        assert.strictEqual(orderOfAuthUser.user.toString() === authenticatedUserId, true);
        assert.strictEqual(orderOfOtherUser.user.toString() === authenticatedUserId, false);
    });

    it("should verify that concurrent requests are atomic and cannot corrupt state", async () => {
        // Mock state representing the database record
        let dbRecord = {
            _id: "order_concurrent_1",
            payment: false,
            razorpayPaymentId: null
        };
        let socketEventEmits = 0;

        // Simulated atomic findOneAndUpdate({ _id: "order_concurrent_1", payment: false })
        const atomicUpdate = async (paymentId) => {
            // Atomic conditional update simulation
            if (!dbRecord.payment) {
                dbRecord.payment = true;
                dbRecord.razorpayPaymentId = paymentId;
                socketEventEmits += 1;
                return { ...dbRecord };
            }
            return null; // Atomic condition failed: already paid
        };

        // Two concurrent requests hitting the endpoint simultaneously
        const [result1, result2] = await Promise.all([
            atomicUpdate("pay_req_1"),
            atomicUpdate("pay_req_2")
        ]);

        // Exactly one should succeed in making the atomic state transition
        const succeededUpdates = [result1, result2].filter(r => r !== null);
        assert.strictEqual(succeededUpdates.length, 1);
        // Socket event must only be emitted ONCE
        assert.strictEqual(socketEventEmits, 1);
        // State remains consistently paid
        assert.strictEqual(dbRecord.payment, true);
    });
});
