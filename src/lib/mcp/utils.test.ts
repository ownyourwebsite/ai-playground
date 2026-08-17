import { test } from "node:test";
import assert from "node:assert";
import {
  parseGithubRepo,
  extractGithubRepoFromText,
  resolveGithubToolArgs,
  validateToolArgs
} from "./utils";

test("parseGithubRepo", () => {
  // Test owner/repo format
  assert.deepStrictEqual(parseGithubRepo("ownyourwebsite/ai-playground"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test full URL format
  assert.deepStrictEqual(parseGithubRepo("https://github.com/ownyourwebsite/ai-playground"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test full URL with subpath
  assert.deepStrictEqual(parseGithubRepo("https://github.com/ownyourwebsite/ai-playground/blob/main/README.md"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test without protocol but with github.com
  assert.deepStrictEqual(parseGithubRepo("github.com/ownyourwebsite/ai-playground"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test invalid input
  assert.strictEqual(parseGithubRepo("invalid-input"), null);
});

test("extractGithubRepoFromText", () => {
  // Test parsing pasted URL
  assert.deepStrictEqual(extractGithubRepoFromText("Please look at https://github.com/ownyourwebsite/ai-playground for details"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test parsing owner/repo shorthand
  assert.deepStrictEqual(extractGithubRepoFromText("Can you read ownyourwebsite/ai-playground?"), {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });

  // Test filter avoiding matching npm/install or others
  assert.strictEqual(extractGithubRepoFromText("Run npm/install now"), null);
});

test("resolveGithubToolArgs", () => {
  const schema = {
    type: "object" as const,
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string" }
    },
    required: ["owner", "repo", "path"]
  };

  const context = { owner: "ownyourwebsite", repo: "ai-playground" };

  // Test missing owner/repo resolved from context
  const resolved = resolveGithubToolArgs("get_file_contents", { path: "package.json" }, schema, context);
  assert.deepStrictEqual(resolved, {
    owner: "ownyourwebsite",
    repo: "ai-playground",
    path: "package.json"
  });

  // Test explicit values not overwritten
  const resolvedExplicit = resolveGithubToolArgs(
    "get_file_contents",
    { owner: "other-owner", repo: "other-repo", path: "package.json" },
    schema,
    context
  );
  assert.deepStrictEqual(resolvedExplicit, {
    owner: "other-owner",
    repo: "other-repo",
    path: "package.json"
  });

  // Test README path inference
  const resolvedReadme = resolveGithubToolArgs(
    "get_file_contents",
    {},
    schema,
    context,
    "Read the README.md please"
  );
  assert.deepStrictEqual(resolvedReadme, {
    owner: "ownyourwebsite",
    repo: "ai-playground",
    path: "README.md"
  });

  // Test README path not inferred for ambiguous prompt
  const resolvedAmbiguous = resolveGithubToolArgs(
    "get_file_contents",
    {},
    schema,
    context,
    "Read the config please"
  );
  assert.deepStrictEqual(resolvedAmbiguous, {
    owner: "ownyourwebsite",
    repo: "ai-playground"
  });
});

test("validateToolArgs", () => {
  const schema = {
    type: "object" as const,
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string" }
    },
    required: ["owner", "repo", "path"]
  };

  // Valid args
  assert.deepStrictEqual(
    validateToolArgs({ owner: "o", repo: "r", path: "p" }, schema),
    { valid: true, missingFields: [] }
  );

  // Missing path
  assert.deepStrictEqual(
    validateToolArgs({ owner: "o", repo: "r" }, schema),
    { valid: false, missingFields: ["path"] }
  );

  // Missing all
  assert.deepStrictEqual(
    validateToolArgs({}, schema),
    { valid: false, missingFields: ["owner", "repo", "path"] }
  );
});
