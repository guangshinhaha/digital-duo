// @ts-check
import tseslint from "typescript-eslint";

/**
 * The one rule that matters here: `DuoMessage`'s own doc comment promises
 * that its subtree can never render `OwnerMessage`. AR-13
 * (`client-design.md`) is "a principle with a failing test is a
 * principle; one in a style guide is a hope," and a lint rule is the same
 * idea applied to what gets *written*.
 *
 * `no-restricted-syntax` with a JSX-descendant selector, not
 * `no-restricted-imports`: the real invariant is about *composition*
 * (`<OwnerMessage>` must never render inside `<DuoMessage>`'s children),
 * not about which files are allowed to import which module. This
 * selector matches ancestor/descendant JSX nodes *within one syntax
 * tree*, at any depth — so it catches `<DuoMessage><OwnerMessage/>
 * </DuoMessage>` the moment it's typed, in any file, even through an
 * inline wrapper written in the same expression.
 *
 * It cannot catch composition *across* a component boundary, though: a
 * `Bubble` whose own source is `<DuoMessage>{children}</DuoMessage>` (no
 * literal `<OwnerMessage>` in sight) used elsewhere as
 * `<Bubble><OwnerMessage/></Bubble>` (no literal `<DuoMessage>` in sight
 * either) gives this rule nothing to match at either call site, though
 * React still mounts one inside the other at runtime.
 * `DuoMessage.tsx`'s `InsideDuoMessage` context is the runtime half that
 * closes that gap regardless of indirection — this rule is the fast,
 * dev-time layer; that one is the complete guarantee.
 */
export default tseslint.config(
  { ignores: ["dist/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXElement[openingElement.name.name='DuoMessage'] JSXElement[openingElement.name.name='OwnerMessage']",
          message: "OwnerMessage must never render inside DuoMessage's subtree — see DuoMessage's own doc comment (AR-13).",
        },
      ],
    },
  },
);
