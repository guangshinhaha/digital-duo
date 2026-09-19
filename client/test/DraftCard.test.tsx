import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftCard } from "../src/components/DraftCard.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const draftRecord: DraftRecord = {
  id: "d1",
  question: "How much leave do I get?",
  threadContext: null,
  draftText: "Five days per quarter.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [{ kind: "rule", id: "r1", label: "standing order: five days" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
};

const escalatedRecord: DraftRecord = {
  ...draftRecord,
  id: "d2",
  draftText: null,
  escalated: true,
  escalationReason: "no supporting evidence",
  refused: false,
};

const refusedRecord: DraftRecord = {
  ...draftRecord,
  id: "d3",
  draftText: null,
  escalated: true,
  escalationReason: "this topic is on your refused list",
  refused: true,
};

describe("DraftCard — Send / Edit / Ignore (the correction loop's only input)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the question as OwnerMessage and the draft as DuoMessage", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    expect(screen.getByTestId("owner-message")).toHaveTextContent("How much leave do I get?");
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Five days per quarter.");
  });

  it("Send posts the outcome as \"sent\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/d1/outcome", expect.objectContaining({ method: "POST" })));
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "sent" });
  });

  it("Edit reveals a textarea, and Send edited posts the edited text", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Actually, ten days." } });
    fireEvent.click(screen.getByText("Send edited"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "edited", sentText: "Actually, ten days." });
  });

  it("Ignore posts the outcome as \"discarded\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Ignore"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "discarded" });
  });

  it("an escalated draft shows the reason and an answer box, not Send/Edit/Ignore", () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    expect(screen.getByTestId("escalation-reason")).toHaveTextContent("no supporting evidence");
    expect(screen.queryByText("Send")).toBeNull();
    expect(screen.getByPlaceholderText(/Answer it yourself/)).toBeInTheDocument();
  });

  it("a refused escalation hides the answer box — based on the real `refused` field, not the reason text", () => {
    renderWithClient(<DraftCard api={api} draft={refusedRecord} />);
    expect(screen.getByTestId("escalation-reason")).toHaveTextContent("this topic is on your refused list");
    expect(screen.queryByPlaceholderText(/Answer it yourself/)).toBeNull();
  });

  it("a non-refused escalation whose reason text happens to mention \"refus\" still shows the answer box", () => {
    // The regression case for the substring-matching bug this field
    // replaced: wording alone must never flip whether the box shows.
    renderWithClient(<DraftCard api={api} draft={{ ...escalatedRecord, escalationReason: "I refuse to guess with this little evidence", refused: false }} />);
    expect(screen.getByPlaceholderText(/Answer it yourself/)).toBeInTheDocument();
  });

  it("answering an escalation shows a confirmation instead of leaving the box open to a duplicate submission", async () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/Answer it yourself/), { target: { value: "Ten days." } });
    fireEvent.click(screen.getByText("Answer"));

    await waitFor(() => expect(screen.getByTestId("answer-confirmation")).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/Answer it yourself/)).toBeNull();
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "http://test/drafts/d2/answer")).toHaveLength(1);
  });

  it("answering an escalation posts to /drafts/:id/answer", async () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/Answer it yourself/), { target: { value: "Ten days." } });
    fireEvent.click(screen.getByText("Answer"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/d2/answer", expect.objectContaining({ method: "POST" })));
  });
});
