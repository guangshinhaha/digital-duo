import { describe, expect, it } from "vitest";
import type { GateLabelExample } from "../src/eval/gate-labels.js";
import type { JevMultiwayTask, JevTrace } from "../src/eval/jev-fixtures.js";
import {
  BINARY_GATE_INSTRUCTIONS,
  MULTIWAY_INSTRUCTIONS,
  TRACE_STEP_INSTRUCTIONS,
  binaryVerdict,
  choiceOutcome,
  gateLabelRequest,
  multiwayTaskRequest,
  traceStepRequest,
} from "../src/eval/jev-encoding.js";
import {
  binaryResult,
  choiceResult,
  createFakeJevProvider,
  createFailingJevProvider,
} from "./fixtures/fake-jev-provider.js";
import { ProviderError } from "../src/provider/types.js";

const LABEL: GateLabelExample = {
  id: "g001",
  text: "Hey, can you review the Q3 budget doc before EOD?",
  mentionType: "genuine_question",
  expected: "answerable",
};

const TASK: JevMultiwayTask = {
  id: "mw01",
  scenario: "Search results for \"Q3 budget\" on the team wiki. Five results are shown.",
  goal: "Open the document the team actually uses as the Q3 budget.",
  candidates: [
    { id: "q3-budget-2026-final", description: "Q3 2026 Budget — FINAL (finance/team-budgets)" },
    { id: "q3-budget-2026-draft", description: "Q3 2026 Budget — DRAFT v3 (personal sandbox)" },
    { id: "q2-budget-2026", description: "Q2 2026 Budget — archived (finance/team-budgets)" },
    { id: "budget-template", description: "Blank budget template (finance/templates)" },
    { "id": "q3-budget-2025", "description": "Q3 2025 Budget — last year's numbers (finance/archive)" },
  ],
  correct: "q3-budget-2026-final",
};

const TRACE: JevTrace = {
  id: "tr01",
  goal: "Find the renewal date of the Northwind Traders contract in the vendor portal.",
  steps: [
    {
      page: "Vendor portal home — tiles: Dashboard, Contracts, Invoices, Support, Profile",
      candidates: [
        { id: "open-contracts", description: "Open the Contracts section" },
        { id: "open-invoices", description: "Open the Invoices section" },
        { id: "open-support", description: "Open the Support section" },
        { id: "open-profile", description: "Open account profile settings" },
      ],
      correct: "open-contracts",
    },
  ],
};

describe("encoding — fixture fields and string constants only (KTD4/KTD10)", () => {
  it("encodes a gate label to one binary question whose state deep-equals { mention } — only the mention text", () => {
    const { state, question } = gateLabelRequest(LABEL);
    expect(state).toEqual({ mention: "Hey, can you review the Q3 budget doc before EOD?" });
    expect(question).toEqual({ kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS });
  });

  it("encodes a multi-way item to a choice question whose criteria keys are exactly the candidate ids", () => {
    const { state, question } = multiwayTaskRequest(TASK);
    expect(state).toEqual({ scenario: TASK.scenario, goal: TASK.goal });
    expect(question.kind).toBe("choice");
    if (question.kind === "choice") {
      expect(Object.keys(question.criteria)).toEqual(TASK.candidates.map((c) => c.id));
      expect(question.criteria["q3-budget-2026-final"]).toBe("Q3 2026 Budget — FINAL (finance/team-budgets)");
      expect(question.instructions).toBe(MULTIWAY_INSTRUCTIONS);
    }
  });

  it("encodes a trace step to a choice question over that step's candidates, with the trace goal and page as state", () => {
    const step = TRACE.steps[0];
    const { state, question } = traceStepRequest(TRACE, step);
    expect(state).toEqual({ goal: TRACE.goal, page: step.page });
    expect(question.kind).toBe("choice");
    if (question.kind === "choice") {
      expect(Object.keys(question.criteria)).toEqual(step.candidates.map((c) => c.id));
      expect(question.instructions).toBe(TRACE_STEP_INSTRUCTIONS);
    }
  });

  it("canary: a DUO_OWNER_NAME marker set in the environment appears in no constructed request (constants-only rule)", () => {
    const previous = process.env.DUO_OWNER_NAME;
    process.env.DUO_OWNER_NAME = "CANARY-OWNER-7f3a";
    try {
      for (const request of [
        gateLabelRequest(LABEL),
        multiwayTaskRequest(TASK),
        traceStepRequest(TRACE, TRACE.steps[0]),
      ]) {
        const serialized = JSON.stringify({ state: request.state, questions: [request.question] });
        expect(serialized).not.toContain("CANARY-OWNER-7f3a");
      }
    } finally {
      if (previous === undefined) {
        delete process.env.DUO_OWNER_NAME;
      } else {
        process.env.DUO_OWNER_NAME = previous;
      }
    }
  });
});

describe("decoding — threshold and out-of-menu rules (KTD4/AE3)", () => {
  it("maps binary probabilities by the strict > 0.5 threshold: 0.51 answerable, 0.5 and 0.49 not", () => {
    expect(binaryVerdict({ kind: "binary", probability: 0.51 })).toBe("answerable");
    expect(binaryVerdict({ kind: "binary", probability: 0.5 })).toBe("not_answerable");
    expect(binaryVerdict({ kind: "binary", probability: 0.49 })).toBe("not_answerable");
  });

  it("marks a pick outside the criteria map as out-of-menu — a wrong pick, never an error", () => {
    const outcome = choiceOutcome(
      { kind: "choice", pick: "no-such-candidate", probabilities: { "no-such-candidate": 0.9 }, confidence: 0.8 },
      TASK.candidates.map((c) => c.id),
    );
    expect(outcome.outOfMenu).toBe(true);
    expect(outcome.pick).toBe("no-such-candidate");
    expect(outcome.probabilities).toEqual({ "no-such-candidate": 0.9 });
    expect(outcome.confidence).toBe(0.8);
  });

  it("keeps an in-menu pick as an ordinary outcome with its full ranking recorded", () => {
    const outcome = choiceOutcome(
      {
        kind: "choice",
        pick: "open-contracts",
        probabilities: { "open-contracts": 0.7, "open-invoices": 0.2, "open-support": 0.1 },
        confidence: 0.9,
      },
      TRACE.steps[0].candidates.map((c) => c.id),
    );
    expect(outcome.outOfMenu).toBe(false);
    expect(outcome.probabilities).toEqual({ "open-contracts": 0.7, "open-invoices": 0.2, "open-support": 0.1 });
  });
});

describe("fake Jev provider — the stand-in everything downstream tests through", () => {
  it("scripts a full answer sequence, records every call, and carries model + usage forward", async () => {
    const fake = createFakeJevProvider([binaryResult(0.83), choiceResult("q3-budget-2026-final")]);
    const first = await fake.decide({ mention: "hi" }, [
      { kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS },
    ]);
    expect(first.answers[0]).toEqual({ kind: "binary", probability: 0.83 });
    expect(first.model).toBe("fake-jev-1");
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 0 });

    const second = await fake.decide({ scenario: "s", goal: "g" }, [
      { kind: "choice", instructions: MULTIWAY_INSTRUCTIONS, criteria: { a: "A", b: "B" } },
    ]);
    expect(second.answers[0]).toEqual({ kind: "choice", pick: "q3-budget-2026-final" });

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].state).toEqual({ mention: "hi" });
    expect(fake.calls[1].questions[0].kind).toBe("choice");
  });

  it("fails mid-sequence with ProviderError once the script is exhausted, and the failing variant always does", async () => {
    const exhausted = createFakeJevProvider([binaryResult(0.9)]);
    await exhausted.decide({ mention: "x" }, [{ kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS }]);
    await expect(
      exhausted.decide({ mention: "y" }, [{ kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS }]),
    ).rejects.toThrow(ProviderError);

    const failing = createFailingJevProvider();
    await expect(
      failing.decide({ mention: "z" }, [{ kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS }]),
    ).rejects.toThrow(ProviderError);
    await expect(
      failing.decide({ mention: "z" }, [{ kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS }]),
    ).rejects.toThrow(/unreachable/i);
  });
});
