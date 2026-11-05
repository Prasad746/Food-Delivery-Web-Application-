import { describe, it } from "node:test";
import assert from "node:assert";
import mongoose from "mongoose";

describe("Item Deletion and ObjectId Comparison", () => {
    it("should demonstrate why reference equality fails for distinct ObjectId instances", () => {
        const idString = "507f1f77bcf86cd799439011";
        const instanceA = new mongoose.Types.ObjectId(idString);
        const instanceB = new mongoose.Types.ObjectId(idString);

        // JavaScript reference inequality between two separate objects
        assert.strictEqual(instanceA !== instanceB, true); // this is why the old bug failed!
        // But string comparison correctly identifies them
        assert.strictEqual(instanceA.toString() === instanceB.toString(), true);
    });

    it("should correctly remove the target item from an array of ObjectId instances", () => {
        const item1 = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
        const item2 = new mongoose.Types.ObjectId("507f1f77bcf86cd799439022");
        const item3 = new mongoose.Types.ObjectId("507f1f77bcf86cd799439033");

        const shopItems = [item1, item2, item3];

        // We want to delete item2, given as a string
        const targetIdString = "507f1f77bcf86cd799439022";

        // Old broken implementation (reference equality)
        const oldFilterResult = shopItems.filter(i => i !== targetIdString);
        // Old filter does NOT remove item2 because ObjectId !== string
        assert.strictEqual(oldFilterResult.length, 3);

        // Repaired implementation:
        const repairedFilterResult = shopItems.filter(i => i && i.toString() !== targetIdString.toString());
        assert.strictEqual(repairedFilterResult.length, 2);
        assert.strictEqual(repairedFilterResult.map(i => i.toString()).includes(targetIdString), false);
        // Unrelated items preserved
        assert.strictEqual(repairedFilterResult[0].toString(), item1.toString());
        assert.strictEqual(repairedFilterResult[1].toString(), item3.toString());
    });

    it("should validate ObjectId format", () => {
        assert.strictEqual(mongoose.Types.ObjectId.isValid("507f1f77bcf86cd799439011"), true);
        assert.strictEqual(mongoose.Types.ObjectId.isValid("invalid_id"), false);
        assert.strictEqual(mongoose.Types.ObjectId.isValid("12345"), false);
        assert.strictEqual(mongoose.Types.ObjectId.isValid(""), false);
        assert.strictEqual(mongoose.Types.ObjectId.isValid(null), false);
        assert.strictEqual(mongoose.Types.ObjectId.isValid(undefined), false);
    });

    it("should verify ownership authorization logic", () => {
        const ownerShopId = new mongoose.Types.ObjectId("607f1f77bcf86cd799439001");
        const anotherShopId = new mongoose.Types.ObjectId("607f1f77bcf86cd799439002");

        const item = {
            _id: new mongoose.Types.ObjectId(),
            name: "Burger",
            shop: ownerShopId
        };

        // Item belongs to shop:
        const isAuthorized = item.shop.toString() === ownerShopId.toString();
        assert.strictEqual(isAuthorized, true);

        // Attacker trying to delete item from another shop:
        const isUnauthorized = item.shop.toString() === anotherShopId.toString();
        assert.strictEqual(isUnauthorized, false);
    });
});
