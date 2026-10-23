import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIdent, hasToken } from "../src/tokenize.js";

// hasToken backs chunk localization in recall (attachChunks): it must answer exactly what
// `splitIdent(text).includes(term)` answers, or chunk picking (and the pointer a caller fetches) changes.
test("hasToken agrees with splitIdent on camelCase, snake_case, digits and overlapping matches", () => {
  const texts = [
    "getUserData", "get_user_data", "GetUserData", "HTTPServer parseURL", "aAa", "user2Fa x", "MAX_RETRY_COUNT",
    "retryTimeout.timeout", "foo-bar/baz.qux", "xuser userx", "ABCdef", "abc1Def", "", " ", "İstanbul Kelvin",
  ];
  const terms = ["get", "user", "data", "url", "server", "http", "parse", "retry", "timeout", "aa", "fa", "def", "abc", "1de", "bar", "ist"];
  for (const t of texts) {
    const set = new Set(splitIdent(t));
    for (const w of terms) assert.equal(hasToken(t, w), set.has(w), `${JSON.stringify(t)} / ${w}`);
  }
});

test("hasToken: a substring inside a larger token, or spanning a camel edge, is not a token", () => {
  assert.equal(hasToken("getUser", "getuser"), false);
  assert.equal(hasToken("xuser", "user"), false);
  assert.equal(hasToken("aAa", "aa"), true); // tokens "a", "aa"
});
