import assert from "node:assert/strict";
import test from "node:test";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
} from "../app/matrixStartup.ts";

test("allows a cold mobile connection enough time to load Matrix crypto", () => {
  assert.equal(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS, 120_000);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /downloads several megabytes/u);
  assert.match(MATRIX_CRYPTO_LOADING_DETAIL, /two minutes/u);
  assert.match(MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL, /two minutes/u);
});
