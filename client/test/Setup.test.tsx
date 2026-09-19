import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Setup } from "../src/routes/Setup.js";

describe("Setup — daemon address validation", () => {
  it("normalizes a bare host:port (no scheme) rather than treating it as a relative path", () => {
    const onConnect = vi.fn();
    render(<Setup onConnect={onConnect} />);
    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "100.64.1.5:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Connect"));

    expect(onConnect).toHaveBeenCalledWith({ baseUrl: "http://100.64.1.5:7717", token: "tok" });
  });

  it("accepts an address with an explicit scheme unchanged", () => {
    const onConnect = vi.fn();
    render(<Setup onConnect={onConnect} />);
    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "https://100.64.1.5:7717/" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Connect"));

    expect(onConnect).toHaveBeenCalledWith({ baseUrl: "https://100.64.1.5:7717", token: "tok" });
  });

  it("shows an inline error for a structurally invalid address instead of silently connecting to nothing", () => {
    const onConnect = vi.fn();
    render(<Setup onConnect={onConnect} />);
    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "http://" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Connect"));

    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("setup-error")).toBeInTheDocument();
  });
});
