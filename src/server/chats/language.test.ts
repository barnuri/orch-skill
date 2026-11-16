import { expect, test } from "bun:test";
import { detectLanguage, withLanguageHint } from "./language";

test("Hebrew, Arabic and Russian messages are detected, English and code are not", () => {
  expect(detectLanguage("חשוב שנוכל להשתמש בכל המקרר")).toBe("Hebrew");
  expect(detectLanguage("مرحبا كيف حالك")).toBe("Arabic");
  expect(detectLanguage("Привет, как дела")).toBe("Russian");
  expect(detectLanguage("How do I fix this test?")).toBeNull();
  expect(detectLanguage("const x = 1; // 123")).toBeNull();
  expect(detectLanguage("")).toBeNull();
});

test("a mostly English message with one Hebrew word is left alone", () => {
  expect(detectLanguage("Please translate the word שלום into English for me")).toBeNull();
});

test("the hint names the language and keeps the original text first", () => {
  const out = withLanguageHint("מה שלומך היום");
  expect(out.startsWith("מה שלומך היום")).toBe(true);
  expect(out).toContain("Reply in Hebrew");
  expect(withLanguageHint("hello")).toBe("hello");
});
