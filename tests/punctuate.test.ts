import { it, expect } from "vitest";
import { attachPunctuation } from "../src/transcribe/punctuate.js";

const w = (word: string, i: number) => ({ word, start: i, end: i + 0.5 });
const words = (...list: string[]) => list.map(w);

it("hands each bare word the punctuation that follows it in the text", () => {
  const got = attachPunctuation(words(" Okay", " so", " I'm", " going", " to", " add", " a", " title"), "Okay, so I'm going to add a title.");
  expect(got.map(x => x.word)).toEqual(["Okay,", "so", "I'm", "going", "to", "add", "a", "title."]);
  expect(got[0]).toEqual({ word: "Okay,", start: 0, end: 0.5 });   // times untouched
});

it("a word the text does not have keeps its bare form, and the rest still attach", () => {
  expect(attachPunctuation(words("Click", "New", "Comic"), "Click Comic.").map(x => x.word)).toEqual(["Click", "New", "Comic."]);
});

it("never matches inside another word", () => {
  expect(attachPunctuation(words("the", "at"), "theatre at.").map(x => x.word)).toEqual(["the", "at."]);
});

it("matches regardless of case, and does not double punctuation a word already carries", () => {
  expect(attachPunctuation(words("okay", "Hi,"), "Okay. Hi, there").map(x => x.word)).toEqual(["okay.", "Hi,"]);
});

it("an empty text leaves every word bare and trimmed; an empty word is left alone", () => {
  expect(attachPunctuation(words(" a", "", " b"), "").map(x => x.word)).toEqual(["a", "", "b"]);
});

it("closing quotes and brackets travel with the word", () => {
  expect(attachPunctuation(words("said", "done"), 'said "done").').map(x => x.word)).toEqual(["said", 'done").']);
});

it("curly quotes travel with the word, not straight quotes", () => {
  // U+201D is right double quotation mark, U+2018/U+2019 are left/right single, U+201C is left double
  const text = 'He said \u201cdone\u201d.';  // "done".
  const got = attachPunctuation(words("said", "done"), text).map(x => x.word);
  expect(got).toEqual(["said", 'done\u201d.']);  // done".
});

it("straight single quotes travel with the word", () => {
  const got = attachPunctuation(words("said", "done"), "said 'done'.").map(x => x.word);
  expect(got).toEqual(["said", "done'."]);
});

it("contractions with curly quotes in the text stay bare without stray punctuation", () => {
  const text = 'it\u2019s fine,';  // it's fine,
  const got = attachPunctuation(words("it's"), text).map(x => x.word);
  expect(got).toEqual(["it's"]);  // no punctuation added; word already contains the apostrophe
});
