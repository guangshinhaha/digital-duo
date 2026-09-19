import { describe, expect, it } from "vitest";
import { pickSeededSample } from "../src/eval/seeded-sample.js";

describe("pickSeededSample — #35 AC3's reproducibility", () => {
  it("returns the whole list, unmodified, when count >= length", () => {
    const items = ["a", "b", "c"];
    expect(pickSeededSample(items, 3, 1)).toEqual(items);
    expect(pickSeededSample(items, 10, 1)).toEqual(items);
  });

  it("returns an empty array for a non-positive count", () => {
    expect(pickSeededSample(["a", "b"], 0, 1)).toEqual([]);
    expect(pickSeededSample(["a", "b"], -1, 1)).toEqual([]);
  });

  it("is deterministic: the same items and seed always produce the same subset, in the same order", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const first = pickSeededSample(items, 5, 7);
    const second = pickSeededSample(items, 5, 7);
    expect(second).toEqual(first);
  });

  it("a different seed can produce a different subset from the same items", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const a = pickSeededSample(items, 5, 1);
    const b = pickSeededSample(items, 5, 2);
    expect(a).not.toEqual(b);
  });

  it("never invents or drops items — the subset is always drawn from the input", () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const sample = pickSeededSample(items, 4, 99);
    expect(sample).toHaveLength(4);
    for (const item of sample) {
      expect(items).toContain(item);
    }
    expect(new Set(sample).size).toBe(4); // no duplicates
  });
});
