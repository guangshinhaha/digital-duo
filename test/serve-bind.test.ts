import { describe, expect, it } from "vitest";
import { assertServableHost, UnsafeBindHostError } from "../src/serve/bind.js";

describe("assertServableHost (client-design.md AR-12)", () => {
  it("refuses an absent host", () => {
    expect(() => assertServableHost(undefined)).toThrow(UnsafeBindHostError);
  });

  it("refuses an empty host", () => {
    expect(() => assertServableHost("")).toThrow(UnsafeBindHostError);
  });

  it.each(["0.0.0.0", "::", "*"])("refuses the wildcard host %s", (host) => {
    expect(() => assertServableHost(host)).toThrow(UnsafeBindHostError);
  });

  it.each(["127.0.0.1", "100.64.1.5", "::1"])("accepts an explicit host %s", (host) => {
    expect(() => assertServableHost(host)).not.toThrow();
  });
});
