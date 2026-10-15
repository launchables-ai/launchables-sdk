import { ValidationError } from "./errors.js";
const keyPath = (id) => {
    if (typeof id !== "string" || !id)
        throw new ValidationError("id must be a key id, e.g. \"c_1a2b3c4d\"");
    return `/api/v1/admin/keys/${encodeURIComponent(id)}`;
};
/** The organisation's API keys, through the key management API. Needs an admin key. */
export class AdminKeys {
    send;
    constructor(send) {
        this.send = send;
    }
    /** One page of the organisation's keys, newest first. */
    async list(params = {}) {
        const q = new URLSearchParams();
        if (params.limit !== undefined)
            q.set("limit", String(params.limit));
        if (params.before !== undefined)
            q.set("before", params.before);
        const query = q.toString();
        return (await this.send("GET", `/api/v1/admin/keys${query ? `?${query}` : ""}`));
    }
    /** Every key, newest first, fetching pages as needed. */
    async *listAll(params = {}) {
        let before;
        for (;;) {
            const page = await this.list({ ...params, before });
            yield* page.data;
            if (!page.has_more || !page.next_before)
                return;
            before = page.next_before;
        }
    }
    /** Make a new key. The response holds the full key, once. */
    async create(params) {
        if (!params || typeof params.name !== "string" || !params.name.trim())
            throw new ValidationError("name is required");
        return (await this.send("POST", "/api/v1/admin/keys", params));
    }
    /** Replace a key with a new one (same name, workspace and limits). The old key keeps working until the end of tomorrow. */
    async roll(id) {
        return (await this.send("POST", `${keyPath(id)}/roll`));
    }
    /** Revoke a key. It stops working within a minute. Revoking a revoked key is not an error. */
    async revoke(id) {
        return (await this.send("DELETE", keyPath(id)));
    }
}
