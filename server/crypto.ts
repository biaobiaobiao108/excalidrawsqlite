const getRandomBytes = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const randomHex = (byteLength: number) =>
  Array.from(getRandomBytes(byteLength), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const randomBase64Url = (byteLength: number) =>
  getRandomBytes(byteLength).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });

export const sha256Hex = (input: string | Uint8Array) => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
};

export const hmacSha256Hex = (key: string, input: string) => {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(input);
  return hasher.digest("hex");
};

export const timingSafeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};
