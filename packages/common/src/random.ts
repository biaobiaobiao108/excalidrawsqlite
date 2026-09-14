import { Random } from "roughjs/bin/math";

import { isTestEnv } from "./utils";

let random = new Random(Date.now());
let testIdBase = 0;

export const randomInteger = () => Math.floor(random.next() * 2 ** 31);

export const reseed = (seed: number) => {
  random = new Random(seed);
  testIdBase = 0;
};

const RANDOM_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";

export const randomId = (length = 21) => {
  if (isTestEnv()) {
    return `id${testIdBase++}`;
  }

  let result = "";
  const bytes = new Uint8Array(Math.max(1, length * 2));
  const limit = 256 - (256 % RANDOM_ID_ALPHABET.length);
  while (result.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) {
        continue;
      }
      result += RANDOM_ID_ALPHABET[byte % RANDOM_ID_ALPHABET.length];
      if (result.length === length) {
        break;
      }
    }
  }
  return result;
};
