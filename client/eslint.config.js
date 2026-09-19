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
 * (`<OwnerMessage>` must never render inside `<DuoMessage>`'s children,
 * anywhere in the codebase), not about which files are allowed to import
 * which module. An import-based rule scoped to DuoMessage.tsx alone only
 * catches DuoMessage importing OwnerMessage directly — it does nothing
 * to stop a *caller* elsewhere from writing
 * `<DuoMessage><OwnerMessage>…</OwnerMessage></DuoMessage>`, which is
 * the actual AR-13 violation. This rule applies to every `.tsx` file for
 * exactly that reason.
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
