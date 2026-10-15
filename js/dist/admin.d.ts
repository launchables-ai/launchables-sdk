/** One of the organisation's API keys, as the key management API lists it. It never includes the secret. */
export interface ManagedKey {
    id: string;
    name: string;
    /** The start of the key, e.g. "launchables_AbCd1234". */
    prefix: string;
    workspace: {
        id: string;
        name: string | null;
    } | null;
    created_at: string;
    /** YYYY-MM-DD. */
    expires_on: string | null;
    /** YYYY-MM-DD, or null if the key has not been used. */
    last_used_on: string | null;
    status: "active" | "expired" | "revoked";
    revoked_at: string | null;
}
/** One page of keys. When `has_more` is true, pass `next_before` as `before` to get the next page. */
export interface KeyPage {
    data: ManagedKey[];
    has_more: boolean;
    next_before: string | null;
}
/** A key just made. `key` is the full secret: it is shown only this once. */
export interface CreatedKey {
    id: string;
    name: string;
    key: string;
    prefix: string;
    workspace: {
        id: string;
        name: string;
    };
    expires_on: string;
}
/** A key just rolled: the new key, and the old one with the date it stops working (the end of tomorrow). */
export interface RolledKey extends CreatedKey {
    replaces: {
        id: string;
        expires_on: string;
    };
}
export interface RevokedKey {
    id: string;
    status: "revoked";
    revoked_at: string | null;
}
export interface CreateKeyParams {
    name: string;
    /** Defaults to the organisation's default workspace. */
    workspace_id?: string;
    /** 30, 90, 180 or 365, no longer than the organisation allows. Defaults to 90 (or the organisation's limit if lower). */
    expires_in_days?: 30 | 90 | 180 | 365;
}
export interface ListKeysParams {
    /** Keys per page, 1 to 500. Default 100. */
    limit?: number;
    /** The `next_before` value of the previous page. */
    before?: string;
}
type Send = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<Record<string, unknown>>;
/** The organisation's API keys, through the key management API. Needs an admin key. */
export declare class AdminKeys {
    private readonly send;
    constructor(send: Send);
    /** One page of the organisation's keys, newest first. */
    list(params?: ListKeysParams): Promise<KeyPage>;
    /** Every key, newest first, fetching pages as needed. */
    listAll(params?: Omit<ListKeysParams, "before">): AsyncGenerator<ManagedKey>;
    /** Make a new key. The response holds the full key, once. */
    create(params: CreateKeyParams): Promise<CreatedKey>;
    /** Replace a key with a new one (same name, workspace and limits). The old key keeps working until the end of tomorrow. */
    roll(id: string): Promise<RolledKey>;
    /** Revoke a key. It stops working within a minute. Revoking a revoked key is not an error. */
    revoke(id: string): Promise<RevokedKey>;
}
export {};
