// @ts-check
import tseslint from "typescript-eslint";

/**
 * The one rule that matters here: `DuoMessage`'s own doc comment promises
 * that its subtree can never import an owner-identity component. This is
 * that promise, enforced — AR-13 (`client-design.md`) is "a principle
 * with a failing test is a principle; one in a style guide is a hope,"
 * and a lint rule is the same idea applied to what gets *written*, not
 * just what gets *rendered*.
 */
export default tseslint.config(
  { ignores: ["dist/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/components/DuoMessage.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "./OwnerMessage.js",
              message: "DuoMessage must never import OwnerMessage or any owner-identity component — see DuoMessage's own doc comment (AR-13).",
            },
          ],
        },
      ],
    },
  },
);
