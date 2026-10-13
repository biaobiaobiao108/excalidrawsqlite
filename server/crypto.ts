const getRandomBytes = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const randomHex = (byteLength: number) =>
  Array.from(getRandomBytes(byteLength), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const randomBase64Url = (byteLength: number) => {
  const bytes = getRandomBytes(byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (input: string | Uint8Array) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
};

export const hmacSha256Hex = async (key: string, input: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(input),
  );
  return toHex(new Uint8Array(signature));
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
