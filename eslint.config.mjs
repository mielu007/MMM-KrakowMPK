import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    rules: {
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { ignoreRestSiblings: true }]
    }
  },
  {
    // Runs in the browser; Log and Module are provided by MagicMirror².
    files: ["MMM-KrakowMPK.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, Log: "readonly", Module: "readonly" }
    }
  },
  {
    // Runs in Node.js, loaded by MagicMirror².
    files: ["node_helper.js", "lib/**/*.js", "tools/**/*.js", "test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  }
];
