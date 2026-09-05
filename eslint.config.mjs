import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import { fixupPluginRules } from "@eslint/compat";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "**/.vscode/**",
      "**/firebase/**",
      "**/public/workbox/**",
      "packages/excalidraw/types/**",
      "examples/**/public/**",
      "**/dev-dist/**",
      "**/coverage/**",
      "package-lock.json",
      "bun.lock",
      "**/*.snap",
    ],
  },
  // Base configuration for JS/TS/JSX/TSX
  {
    files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.commonjs,
        ...globals.es2021,
        Bun: "readonly",
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: fixupPluginRules(reactPlugin),
      "react-hooks": fixupPluginRules(reactHooksPlugin),
      "jsx-a11y": fixupPluginRules(jsxA11yPlugin),
      import: fixupPluginRules(importPlugin),
    },
    rules: {
      "array-callback-return": "warn",
      "default-case": ["warn", { commentPattern: "^no default$" }],
      "dot-location": ["warn", "property"],
      eqeqeq: ["warn", "smart"],
      "new-parens": "warn",
      "no-array-constructor": "warn",
      "no-caller": "warn",
      "no-cond-assign": ["warn", "except-parens"],
      "no-const-assign": "warn",
      "no-control-regex": "warn",
      "no-delete-var": "warn",
      "no-dupe-args": "warn",
      "no-dupe-class-members": "warn",
      "no-dupe-keys": "warn",
      "no-duplicate-case": "warn",
      "no-empty-character-class": "warn",
      "no-empty-pattern": "warn",
      "no-eval": "warn",
      "no-ex-assign": "warn",
      "no-extend-native": "warn",
      "no-extra-bind": "warn",
      "no-extra-label": "warn",
      "no-fallthrough": "warn",
      "no-func-assign": "warn",
      "no-implied-eval": "warn",
      "no-invalid-regexp": "warn",
      "no-iterator": "warn",
      "no-label-var": "warn",
      "no-labels": ["warn", { allowLoop: true, allowSwitch: false }],
      "no-lone-blocks": "warn",
      "no-loop-func": "warn",
      "no-mixed-operators": [
        "warn",
        {
          groups: [
            ["&", "|", "^", "~", "<<", ">>", ">>>"],
            ["==", "!=", "===", "!==", ">", ">=", "<", "<="],
            ["&&", "||"],
            ["in", "instanceof"],
          ],
          allowSamePrecedence: false,
        },
      ],
      "no-multi-str": "warn",
      "no-global-assign": "warn",
      "no-unsafe-negation": "warn",
      "no-new-func": "warn",
      "no-new-object": "warn",
      "no-new-symbol": "warn",
      "no-new-wrappers": "warn",
      "no-obj-calls": "warn",
      "no-octal": "warn",
      "no-octal-escape": "warn",
      "no-redeclare": "warn",
      "no-regex-spaces": "warn",
      "no-restricted-syntax": ["warn", "WithStatement"],
      "no-script-url": "warn",
      "no-self-assign": "warn",
      "no-self-compare": "warn",
      "no-sequences": "warn",
      "no-shadow-restricted-names": "warn",
      "no-sparse-arrays": "warn",
      "no-template-curly-in-string": "warn",
      "no-this-before-super": "warn",
      "no-throw-literal": "warn",
      "no-undef": "error",
      "no-unreachable": "warn",
      "no-unused-expressions": [
        "error",
        {
          allowShortCircuit: true,
          allowTernary: true,
          allowTaggedTemplates: true,
        },
      ],
      "no-unused-labels": "warn",
      "no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "no-use-before-define": [
        "warn",
        {
          functions: false,
          classes: false,
          variables: false,
        },
      ],
      "no-useless-computed-key": "warn",
      "no-useless-concat": "warn",
      "no-useless-constructor": "warn",
      "no-useless-escape": "warn",
      "no-useless-rename": [
        "warn",
        {
          ignoreDestructuring: false,
          ignoreImport: false,
          ignoreExport: false,
        },
      ],
      "no-with": "warn",
      "no-whitespace-before-property": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "require-yield": "warn",
      "rest-spread-spacing": ["warn", "never"],
      strict: ["warn", "never"],
      "unicode-bom": ["warn", "never"],
      "use-isnan": "warn",
      "valid-typeof": "warn",
      "getter-return": "warn",
      "import/first": "error",
      "import/no-amd": "error",
      "import/no-anonymous-default-export": "off",
      "import/no-webpack-loader-syntax": "error",
      "react/forbid-foreign-prop-types": ["warn", { allowInPropTypes: true }],
      "react/jsx-no-comment-textnodes": "warn",
      "react/jsx-no-duplicate-props": "warn",
      "react/jsx-no-target-blank": [
        "error",
        {
          allowReferrer: true,
        },
      ],
      "react/jsx-no-undef": "error",
      "react/jsx-pascal-case": [
        "warn",
        {
          allowAllCaps: true,
          ignore: [],
        },
      ],
      "react/no-danger-with-children": "warn",
      "react/no-direct-mutation-state": "warn",
      "react/no-is-mounted": "warn",
      "react/no-typos": "error",
      "react/require-render-return": "error",
      "react/style-prop-object": "warn",
      "jsx-a11y/alt-text": "warn",
      "jsx-a11y/anchor-has-content": "warn",
      "jsx-a11y/anchor-is-valid": [
        "warn",
        {
          aspects: ["noHref", "invalidHref"],
        },
      ],
      "jsx-a11y/aria-activedescendant-has-tabindex": "warn",
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-role": ["warn", { ignoreNonDOM: true }],
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/heading-has-content": "warn",
      "jsx-a11y/iframe-has-title": "warn",
      "jsx-a11y/img-redundant-alt": "warn",
      "jsx-a11y/no-access-key": "warn",
      "jsx-a11y/no-distracting-elements": "warn",
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "jsx-a11y/scope": "warn",
      "react-hooks/rules-of-hooks": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "require",
          property: "ensure",
          message: "Please use import() instead.",
        },
        {
          object: "System",
          property: "import",
          message: "Please use import() instead.",
        },
      ],
      "no-restricted-globals": "off",
      "no-var": "off",
      "object-shorthand": "off",
      "one-var": "off",
      "prefer-arrow-callback": "off",
      "prefer-const": "off",
      "prefer-template": "off",
      "no-else-return": "off",
      "no-lonely-if": "off",
      "no-unneeded-ternary": "off",
      "no-useless-return": "off",
      curly: "off",
      "dot-notation": "off",
    },
  },
  // TypeScript specific rules
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "default-case": "off",
      "no-dupe-class-members": "off",
      "no-undef": "off",
      "no-redeclare": "off",
      "no-unused-expressions": "off",
      "no-unused-vars": "off",
      "no-use-before-define": "off",
      "no-useless-constructor": "off",
      "@typescript-eslint/consistent-type-assertions": "warn",
      "@typescript-eslint/no-array-constructor": "warn",
      "@typescript-eslint/no-redeclare": "warn",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        {
          allowShortCircuit: true,
          allowTernary: true,
          allowTaggedTemplates: true,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-use-before-define": [
        "warn",
        {
          functions: false,
          classes: false,
          variables: false,
          typedefs: false,
        },
      ],
      "@typescript-eslint/no-useless-constructor": "warn",
      "no-restricted-imports": [
        "error",
        {
          name: "jotai",
          message:
            'Do not import from "jotai" directly. Use our app-specific modules ("editor-jotai" or "app-jotai").',
        },
      ],
    },
  },
  // Specific restrictions for packages/excalidraw
  {
    files: ["packages/excalidraw/**/*.{ts,tsx}"],
    ignores: [
      "packages/excalidraw/**/*.test.{ts,tsx}",
      "packages/excalidraw/**/*.test.*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@excalidraw/excalidraw"],
              message:
                "Do not import from the barrel 'index.tsx' files. Use direct relative imports to the specific module instead.",
              allowTypeImports: true,
            },
          ],
          paths: [
            ".",
            "..",
            "../..",
            "../../..",
            "../../../..",
            "../../../../..",
            "../index",
            "../../index",
            "../../../index",
            "../../../../index",
          ],
        },
      ],
    },
  }
);
