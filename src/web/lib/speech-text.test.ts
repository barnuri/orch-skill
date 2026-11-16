import { describe, expect, test } from "bun:test";
import { cleanInline, questionSpeech, sentencesOf, speakNumbers, speechOf, SpeechStream } from "./speech-text";

describe("speakable text", () => {
  test("English: code blocks are said as 'code block', urls and long paths are skipped, marks are dropped", () => {
    const md = "# Plan\n\nFirst I read **the file** at /Users/me/project/src/app.ts and https://example.com/x now.\n\n```ts\nconst a = 1;\n```\n\nThen I run `bun test` to check it.";
    const s = speechOf(md, "en-US").map((x) => x.text);
    expect(s).toEqual(["Plan", "First I read the file at and now.", "code block", "Then I run bun test to check it."]);
  });

  test("Hebrew: code block in Hebrew, shekel and percent read as words, thousands separators removed", () => {
    expect(speechOf("הנה הקוד:\n```js\nx()\n```\nהמחיר הוא ₪1,200 וההנחה 15%.", "he-IL").map((x) => x.text)).toEqual(["הנה הקוד:", "בלוק קוד", "המחיר הוא 1200 שקלים וההנחה 15 אחוז."]);
    expect(speakNumbers("50₪ and $5 and 3.5%", "he")).toBe("50 שקלים and 5 דולר and 3.5 אחוז");
    expect(speakNumbers("₪30 or $2", "en-US")).toBe("30 shekels or 2 dollars");
  });

  test("a long list is summarised after four items; tables and tool-like noise are skipped", () => {
    const md = "Options:\n- one thing\n- two things\n- three things\n- four things\n- five things\n- six things\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone with all of it.";
    expect(speechOf(md, "en-US").map((x) => x.text)).toEqual(["Options:", "one thing", "two things", "three things", "four things", "and 2 more items", "Done with all of it."]);
  });

  test("each sentence gets its own language: an English sentence inside a Hebrew reply", () => {
    const s = speechOf("זה עובד מצוין עכשיו. This is the English sentence here.", "he-IL");
    expect(s.map((x) => x.lang)).toEqual(["he-IL", "en-US"]);
  });

  test("sentence splitting keeps decimals and short pieces together", () => {
    expect(sentencesOf("Version 3.5 is out. Yes! It works well for everyone.")).toEqual(["Version 3.5 is out.", "Yes! It works well for everyone."]);
    expect(cleanInline("see [docs](http://a.b) and `x`", "en-US")).toBe("see docs and x");
  });

  test("question speech reads the question and its numbered options", () => {
    expect(questionSpeech("Which one?", ["Red", "Blue"], "en-US")).toBe("Which one? The options are: 1, Red. 2, Blue.");
    expect(questionSpeech("איזה?", ["כן"], "he-IL")).toContain("האפשרויות");
  });
});

describe("SpeechStream (sentence by sentence while the reply streams)", () => {
  test("emits each sentence once, as soon as it ends, never a growing one", () => {
    const st = new SpeechStream("en-US");
    const got: string[] = [];
    const feed = (c: string, final = false): void => { got.push(...st.push(c, final).map((s) => s.text)); };
    feed("Hello there, my");
    expect(got).toEqual([]);
    feed("Hello there, my friend. How are");
    expect(got).toEqual(["Hello there, my friend."]);
    feed("Hello there, my friend. How are you doing today? I am");
    expect(got).toEqual(["Hello there, my friend.", "How are you doing today?"]);
    feed("Hello there, my friend. How are you doing today? I am fine, thanks a lot.");
    expect(got).toEqual(["Hello there, my friend.", "How are you doing today?"]);
    feed("Hello there, my friend. How are you doing today? I am fine, thanks a lot.", true);
    expect(got).toEqual(["Hello there, my friend.", "How are you doing today?", "I am fine, thanks a lot."]);
  });

  test("an open code fence is not spoken until it closes; then 'code block' once", () => {
    const st = new SpeechStream("en-US");
    const got: string[] = [];
    for (const c of ["Look at this one now.\n```py\nprint(1)", "Look at this one now.\n```py\nprint(1)\n```\nAnd that is all of it."]) got.push(...st.push(c, false).map((s) => s.text));
    got.push(...st.push("Look at this one now.\n```py\nprint(1)\n```\nAnd that is all of it.", true).map((s) => s.text));
    expect(got).toEqual(["Look at this one now.", "code block", "And that is all of it."]);
  });

  test("indexes are consecutive", () => {
    expect(speechOf("One sentence is here. Two sentences are here.\n\nThree is the last one.", "en-US").map((s) => s.index)).toEqual([0, 1, 2]);
  });
});
