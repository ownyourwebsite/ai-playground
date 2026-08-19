import { test } from "node:test";
import assert from "node:assert";
import { parseReasoning, stripOpenReasoningTag } from "./reasoning";

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

test("parseReasoning: <thinking> block (plural) is extracted and stripped", () => {
  const result = parseReasoning("<thinking>I should check the file first.</thinking>Here is the answer.");
  assert.strictEqual(result.reasoning, "I should check the file first.");
  assert.strictEqual(result.cleanText, "Here is the answer.");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: <reasoning> block is extracted and stripped", () => {
  const result = parseReasoning("A<reasoning>hidden</reasoning>B");
  assert.strictEqual(result.reasoning, "hidden");
  assert.strictEqual(result.cleanText, "AB");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: unclosed <thinking> no longer swallows the final answer via fallback", () => {
  const raw = "<thinking>this looks like reasoning but never closes</thinking>the answer is 42";
  const result = parseReasoning(raw);
  // Properly closed <thinking> is extracted normally:
  assert.strictEqual(result.reasoning, "this looks like reasoning but never closes");
  assert.strictEqual(result.cleanText, "the answer is 42");
  assert.strictEqual(result.isOpen, false);
});

test("parseReasoning: malformed unclosed tag flags isOpen", () => {
  const result = parseReasoning("<thinking>the model never closes this");
  assert.strictEqual(result.reasoning, "the model never closes this");
  assert.strictEqual(result.cleanText, "");
  assert.strictEqual(result.isOpen, true);
});

test("stripOpenReasoningTag removes the opening tag so the answer stays visible", () => {
  assert.strictEqual(stripOpenReasoningTag("<thinking>the model never closes this"), "the model never closes this");
  assert.strictEqual(stripOpenReasoningTag("Answer: <think>partial"), "Answer: partial");
  assert.strictEqual(stripOpenReasoningTag("no tags here"), "no tags here");
});
