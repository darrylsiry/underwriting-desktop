import assert from "node:assert/strict";
import { test } from "node:test";
import { factorText, money, moneyCents, moneyExact, moneyShort, moneySigned } from "./format.ts";

test("whole dollars, from a number or a database string", () => {
  assert.equal(money(1_250_000), "$1,250,000");
  assert.equal(money("89725.15"), "$89,725");
  assert.equal(money(0), "$0");
  assert.equal(money(-500), "-$500");
});

test("exact keeps the cents an amount has; referral details rely on this staying put", () => {
  assert.equal(moneyExact("89725.15"), "$89,725.15");
  assert.equal(moneyExact(100000), "$100,000");
});

test("the ledger always shows two decimals", () => {
  assert.equal(moneyCents(1250), "$1,250.00");
  assert.equal(moneyCents("1250.5"), "$1,250.50");
});

test("signed differences and short tiles", () => {
  assert.equal(moneySigned(500), "+$500");
  assert.equal(moneySigned(0), "+$0");
  assert.equal(moneySigned(-500), "-$500");
  assert.equal(moneyShort(1_280_000), "$1.28M");
  assert.equal(moneyShort(243_000), "$243K");
  assert.equal(moneyShort(9_500), "$9,500");
});

test("a factor shows every decimal it has, so the premium column can be reproduced from the screen (CR-163)", () => {
  assert.equal(factorText(1), "1.00");
  assert.equal(factorText("1.1"), "1.10");
  assert.equal(factorText("1.1250"), "1.125");
  assert.equal(factorText(0.9875), "0.9875");
});
