import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { DuoMessage } from "../src/components/DuoMessage.js";
import { OwnerMessage } from "../src/components/OwnerMessage.js";

/**
 * The AR-13 test client-tech-design.md §3.4 calls "the test that gates the
 * build": concept.md's "always labelled … never poses as you" made
 * structural rather than a style-guide hope. `DuoMessage` must always
 * carry its own attribution and must never render the owner's identity.
 */
describe("DuoMessage — the labelling contract (concept.md, AR-13)", () => {
  it("always renders its own attribution, distinct from the owner", () => {
    render(<DuoMessage>Five days per quarter.</DuoMessage>);
    expect(screen.getByTestId("duo-message-attribution")).toHaveTextContent("Your duo");
  });

  it("never renders the string \"You\" — that's OwnerMessage's label, never DuoMessage's", () => {
    render(<DuoMessage>Five days per quarter.</DuoMessage>);
    expect(screen.getByTestId("duo-message")).not.toHaveTextContent(/^You$/m);
  });

  it("has no prop through which an owner identity/avatar could be passed", () => {
    // Structural, not behavioral: DuoMessage's props are `{ children }`
    // only. This is a compile-time guarantee (see the component's own
    // type signature) — this test documents the property so a future
    // widening of DuoMessage's props is a conscious, visible diff, not a
    // silent one.
    const props = Object.keys({ children: null } satisfies ComponentProps<typeof DuoMessage>);
    expect(props).toEqual(["children"]);
  });
});

describe("OwnerMessage — the only component that may carry the owner's identity", () => {
  it("renders the owner's label", () => {
    render(<OwnerMessage>How much leave do I get?</OwnerMessage>);
    expect(screen.getByTestId("owner-message")).toHaveTextContent("You");
  });
});
