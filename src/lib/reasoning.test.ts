import { test } from "node:test";
import assert from "node:assert";
import { parseReasoning } from "./reasoning";

test("parseReasoning: no tags returns null reasoning", () => {
  const result = parseReasoning("Hello world");
  assert.strictEqual(result.reasoning, null);
  assert.strictEqual(result.cleanText, "Hello world");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: <think> block is extracted and stripped", () => {
  const result = parseReasoning("Let me think<think>I need to be careful here.</think> Final answer.");
  assert.strictEqual(result.reasoning, "I need to be careful here.");
  assert.strictEqual(result.cleanText, "Let me think Final answer.");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: <thought> block is extracted and stripped", () => {
  const result = parseReasoning("Answer<thought>hidden chain</thought>! Finished");
  assert.strictEqual(result.reasoning, "hidden chain");
  assert.strictEqual(result.cleanText, "Answer! Finished");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: unclosed <think> during streaming flags isOpen", () => {
  // Closing tag hasn't arrived yet — partial reasoning is returned and isOpen.
  const result = parseReasoning("Hello<think>I am thinking about");
  assert.strictEqual(result.reasoning, "I am thinking about");
  assert.strictEqual(result.cleanText, "Hello");
  assert.strictEqual(result.isOpen, true);
});

test("parseReasoning: empty unclosed tag yields null reasoning but stays open", () => {
  const result = parseReasoning("Hello<think>");
  assert.strictEqual(result.reasoning, null);
  assert.strictEqual(result.cleanText, "Hello");
  assert.strictEqual(result.isOpen, true);
});

test("parseReasoning: earliest opening tag wins across tag names", () => {
  const result = parseReasoning("A<thought>first</thought>B<think>second</think>C");
  assert.strictEqual(result.reasoning, "first");
  assert.strictEqual(result.cleanText, "AB<think>second</think>C");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: dedicated reasoning field takes precedence", () => {
  const result = parseReasoning("Final answer text", "api-provided reasoning");
  assert.strictEqual(result.reasoning, "api-provided reasoning");
  assert.strictEqual(result.cleanText, "Final answer text");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: empty provided reasoning falls back to tags", () => {
  const result = parseReasoning("X<think>t</think>Y", "   ");
  assert.strictEqual(result.reasoning, "t");
  assert.strictEqual(result.cleanText, "XY");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: opening tag without '>' still captured as reasoning", () => {
  const result = parseReasoning("Text<thinkI am mid-tag");
  assert.strictEqual(result.reasoning, "I am mid-tag");
  assert.strictEqual(result.cleanText, "Text");
  assert.strictEqual(result.isOpen, true);
});
