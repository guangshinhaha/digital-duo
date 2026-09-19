import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the current render is inside a `DuoMessage`'s subtree. This is
 * the runtime half of the AR-13 labelling contract — the ESLint
 * `no-restricted-syntax` rule (`eslint.config.js`) is a static, JSX-AST
 * check: it matches `<DuoMessage>` and `<OwnerMessage>` appearing as
 * ancestor/descendant JSX nodes *in the same syntax tree*, however deep
 * — so it catches `<DuoMessage><OwnerMessage/></DuoMessage>` even through
 * an inline wrapper written in the same expression. What it cannot catch
 * is composition *across* a component boundary: a `Bubble` component
 * whose own source is `<DuoMessage>{children}</DuoMessage>` (no literal
 * `<OwnerMessage>` node in sight), used elsewhere as
 * `<Bubble><OwnerMessage/></Bubble>` (no literal `<DuoMessage>` node in
 * sight either) — neither call site gives the static rule anything to
 * match, though React still mounts `OwnerMessage` inside `DuoMessage`'s
 * tree at runtime. Context propagates through the actual component tree
 * regardless of which file wrote which half, so `OwnerMessage` checking
 * this at render time closes exactly that gap.
 */
const InsideDuoMessage = createContext(false);

/**
 * Renders duo-generated text. `concept.md`: "always labelled … it never
 * poses as you." `client-tech-design.md` §3.4 promotes that from a
 * guideline to a structural rule: this component has no `avatar` prop —
 * there is nothing to pass — so a Slack-shaped chat bubble that puts the
 * owner's own avatar on generated text is impossible to build with it, not
 * merely discouraged.
 *
 * `OwnerMessage` (or any owner-identity component) must never render
 * inside this component's children, anywhere in the codebase — enforced
 * two ways: statically by `eslint.config.js`'s lint rule for the direct
 * case, and at runtime by `InsideDuoMessage` (above) for every case,
 * including through a wrapper component the lint rule can't see through.
 */
export function DuoMessage({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="duo-message"
      className="rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 text-[var(--text)]"
    >
      <div className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)]" data-testid="duo-message-attribution">
        Your duo
      </div>
      <div>
        <InsideDuoMessage.Provider value={true}>{children}</InsideDuoMessage.Provider>
      </div>
    </div>
  );
}

/** `OwnerMessage`'s own runtime half of the guard — see `InsideDuoMessage`'s doc comment above. */
export function useAssertNotInsideDuoMessage(componentName: string): void {
  if (useContext(InsideDuoMessage)) {
    throw new Error(`${componentName} must never render inside DuoMessage's subtree (AR-13: a duo never poses as its owner)`);
  }
}
