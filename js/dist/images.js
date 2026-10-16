import { ValidationError } from "./errors.js";
export const IMAGE_FORMATS = ["png", "jpg", "jpeg"];
export const IMAGE_BUDGETS = [70, 140, 280];
/** The largest image the API accepts, in bytes (16 MiB). */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
function startsWith(data, magic) {
    return data.length >= magic.length && magic.every((b, i) => data[i] === b);
}
/** "png" or "jpeg" from the file's first bytes, or undefined for anything else. */
export function detectImageFormat(data) {
    if (startsWith(data, PNG_MAGIC))
        return "png";
    if (startsWith(data, JPEG_MAGIC))
        return "jpeg";
    return undefined;
}
function toBase64(data) {
    const B = globalThis.Buffer;
    if (B)
        return B.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000)
        s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(s);
}
const isArrayBuffer = (v) => Object.prototype.toString.call(v) === "[object ArrayBuffer]";
const isJpeg = (f) => f === "jpg" || f === "jpeg";
const sameFormat = (a, b) => a === b || (isJpeg(a) && isJpeg(b));
/**
 * An image from its file bytes (a Uint8Array, Buffer or ArrayBuffer). Without `format`, it is detected from the bytes
 * (PNG or JPEG). Anything else is refused. The bytes are sent as they are: never resized or re-encoded.
 */
export function imageFromBytes(bytes, format) {
    // realm-independent checks, so bytes made in another context (node:vm, a worker's realm) are accepted too
    let data;
    if (ArrayBuffer.isView(bytes))
        data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else if (isArrayBuffer(bytes))
        data = new Uint8Array(bytes);
    else
        throw new ValidationError("image data must be a Uint8Array, Buffer or ArrayBuffer");
    if (data.byteLength > MAX_IMAGE_BYTES) {
        throw new ValidationError(`image is ${data.byteLength} bytes; the most the API accepts is ${MAX_IMAGE_BYTES} (16 MiB)`);
    }
    const detected = detectImageFormat(data);
    let fmt;
    if (format === undefined) {
        if (!detected)
            throw new ValidationError("image is not a PNG or JPEG file (the only formats the API reads)");
        fmt = detected;
    }
    else {
        const f = typeof format === "string" ? format.toLowerCase() : format;
        if (!IMAGE_FORMATS.includes(f)) {
            throw new ValidationError(`image format must be one of ${IMAGE_FORMATS.join(", ")}, got ${JSON.stringify(format)}`);
        }
        if (!detected || !sameFormat(f, detected)) {
            throw new ValidationError(`image bytes are not ${f.toUpperCase()}` + (detected ? ` (they look like ${detected.toUpperCase()})` : " (not a PNG or JPEG file)"));
        }
        fmt = f;
    }
    return { type: "image", format: fmt, data_base64: toBase64(data) };
}
/** An image read from a file (Node). Without `format`, it is detected from the bytes (PNG or JPEG), not the file name. */
export async function imageFromPath(path, format) {
    const fs = await import("node:fs");
    const { size } = await fs.promises.stat(path);
    if (size > MAX_IMAGE_BYTES) {
        throw new ValidationError(`${path} is ${size} bytes; the most the API accepts is ${MAX_IMAGE_BYTES} (16 MiB)`);
    }
    // read at most one byte past the limit (`end` is inclusive), so a file that grew, or a device with no size, is still refused
    const chunks = [];
    for await (const chunk of fs.createReadStream(path, { start: 0, end: MAX_IMAGE_BYTES }))
        chunks.push(chunk);
    return imageFromBytes(Buffer.concat(chunks), format);
}
/** Check a { reference: image } object before it is sent. Objects are sent as they are. */
export function validateAssets(assets) {
    if (typeof assets !== "object" || assets === null || Array.isArray(assets)) {
        throw new ValidationError("assets must be an object of { reference: image }");
    }
    for (const [ref, value] of Object.entries(assets)) {
        if (ref === "")
            throw new ValidationError("asset references must be non-empty strings");
        if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || isArrayBuffer(value)) {
            throw new ValidationError(`asset "${ref}" must be an image object (imageFromBytes or imageFromPath, or { type: "image", format, data_base64 })`);
        }
    }
    return assets;
}
export function validateImageBudget(budget) {
    if (!IMAGE_BUDGETS.includes(budget)) {
        throw new ValidationError(`imageBudget must be one of ${IMAGE_BUDGETS.join(", ")}, got ${JSON.stringify(budget)}`);
    }
    return budget;
}
