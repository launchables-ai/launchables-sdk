import { ValidationError } from "./errors.js";
// The API's largest limits (Myles-G 12B since 24 Oct 2026); a model on lower limits answers 422.
export const MAX_QUESTIONS = 256;
export const MAX_OPTIONS = 256;
export const MAX_OPTIONS_TOTAL = 4096; // options over all questions in one request
function checkInstructions(instructions, where = "") {
    if (typeof instructions !== "string" || instructions.trim() === "") {
        throw new ValidationError(`${where}instructions must be a non-empty string`);
    }
    return instructions;
}
/** A yes/no question. The answer is the probability of yes. */
export function noul(instructions, criteria) {
    const q = { type: "noul", instructions: checkInstructions(instructions) };
    if (criteria && (criteria.true !== undefined || criteria.false !== undefined)) {
        q.criteria = {};
        if (criteria.true !== undefined)
            q.criteria.true = criteria.true;
        if (criteria.false !== undefined)
            q.criteria.false = criteria.false;
    }
    return q;
}
/** Pick one label. `options` is a list of labels or a { label: description } object. */
export function choice(instructions, options) {
    if (typeof options !== "object" || options === null) {
        throw new ValidationError("options must be an array of labels or a { label: description } object");
    }
    const labels = Array.isArray(options) ? options : Object.keys(options);
    if (labels.length === 0)
        throw new ValidationError("choice needs at least one option");
    if (labels.length > MAX_OPTIONS) {
        throw new ValidationError(`choice supports at most ${MAX_OPTIONS} options, got ${labels.length}`);
    }
    if (!labels.every((l) => typeof l === "string" && l !== "")) {
        throw new ValidationError("choice labels must be non-empty strings");
    }
    if (new Set(labels).size !== labels.length)
        throw new ValidationError("choice labels must be unique");
    return {
        type: "choice",
        instructions: checkInstructions(instructions),
        criteria: Array.isArray(options) ? [...options] : { ...options },
    };
}
/** Rate on a scale. `levels` describes each level, lowest first (numbered from 0). */
export function score(instructions, levels) {
    if (!Array.isArray(levels))
        throw new ValidationError("levels must be an array of descriptions, lowest first");
    if (levels.length < 2)
        throw new ValidationError("score needs at least two levels");
    if (!levels.every((l) => typeof l === "string" && l !== "")) {
        throw new ValidationError("score levels must be non-empty strings");
    }
    return { type: "score", instructions: checkInstructions(instructions), criteria: [...levels] };
}
/** Check a { name: question } object before it is sent. */
export function validateQuestions(questions) {
    if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
        throw new ValidationError("questions must be a non-empty object of { name: question }");
    }
    const entries = Object.entries(questions);
    if (entries.length === 0)
        throw new ValidationError("questions must be a non-empty object of { name: question }");
    if (entries.length > MAX_QUESTIONS) {
        throw new ValidationError(`at most ${MAX_QUESTIONS} questions per request, got ${entries.length}`);
    }
    let total = 0;
    for (const [name, raw] of entries) {
        const where = `question "${name}": `;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new ValidationError(`${where}must be an object (build it with noul/choice/score)`);
        }
        const q = raw;
        if (q.type !== "noul" && q.type !== "choice" && q.type !== "score") {
            throw new ValidationError(`${where}type must be one of noul, choice, score; got ${JSON.stringify(q.type)}`);
        }
        checkInstructions(q.instructions, where);
        const crit = q.criteria;
        if (q.type === "choice") {
            if (typeof crit !== "object" || crit === null)
                throw new ValidationError(`${where}choice needs criteria (options)`);
            const n = Array.isArray(crit) ? crit.length : Object.keys(crit).length;
            if (n === 0)
                throw new ValidationError(`${where}choice needs criteria (options)`);
            if (n > MAX_OPTIONS)
                throw new ValidationError(`${where}at most ${MAX_OPTIONS} options, got ${n}`);
            total += n;
            if (total > MAX_OPTIONS_TOTAL)
                throw new ValidationError(`at most ${MAX_OPTIONS_TOTAL} options over all questions in one request`);
        }
        else if (q.type === "score") {
            if (!Array.isArray(crit) || crit.length === 0) {
                throw new ValidationError(`${where}score needs criteria (an array of level descriptions)`);
            }
        }
    }
    return questions;
}
