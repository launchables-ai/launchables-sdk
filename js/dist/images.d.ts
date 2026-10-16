/** The formats the API reads. "jpg" and "jpeg" are the same format. */
export type ImageFormat = "png" | "jpg" | "jpeg";
export declare const IMAGE_FORMATS: readonly ImageFormat[];
/** The `imageBudget` values the API accepts: the most visual tokens one image may use. */
export type ImageBudget = 70 | 140 | 280;
export declare const IMAGE_BUDGETS: readonly ImageBudget[];
/** The largest image the API accepts, in bytes (16 MiB). */
export declare const MAX_IMAGE_BYTES: number;
/** An image as sent in `assets`. Build one with `imageFromBytes` or `imageFromPath`, or pass this shape yourself. */
export interface ImageAsset {
    type?: "image";
    format: ImageFormat;
    /** Standard base64 of the file's bytes. */
    data_base64: string;
}
export type Assets = Record<string, ImageAsset>;
/** "png" or "jpeg" from the file's first bytes, or undefined for anything else. */
export declare function detectImageFormat(data: Uint8Array): "png" | "jpeg" | undefined;
/**
 * An image from its file bytes (a Uint8Array, Buffer or ArrayBuffer). Without `format`, it is detected from the bytes
 * (PNG or JPEG). Anything else is refused. The bytes are sent as they are: never resized or re-encoded.
 */
export declare function imageFromBytes(bytes: Uint8Array | ArrayBuffer, format?: ImageFormat): ImageAsset;
/** An image read from a file (Node). Without `format`, it is detected from the bytes (PNG or JPEG), not the file name. */
export declare function imageFromPath(path: string, format?: ImageFormat): Promise<ImageAsset>;
/** Check a { reference: image } object before it is sent. Objects are sent as they are. */
export declare function validateAssets(assets: unknown): Assets;
export declare function validateImageBudget(budget: unknown): ImageBudget;
