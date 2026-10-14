/** Yes/no answer. `noul` (alias `probability`) is the probability of yes, 0 to 1. */
export class NoulAnswer {
    noul;
    raw;
    type = "noul";
    constructor(noul, raw = {}) {
        this.noul = noul;
        this.raw = raw;
    }
    get probability() {
        return this.noul;
    }
    /** "yes" if p >= thresholdYes, "no" if p <= thresholdNo, otherwise "person" (hand off to a person). */
    decide({ thresholdYes = 0.9, thresholdNo = 0.1 } = {}) {
        if (!(thresholdNo >= 0 && thresholdNo <= thresholdYes && thresholdYes <= 1)) {
            throw new RangeError("thresholds must satisfy 0 <= thresholdNo <= thresholdYes <= 1");
        }
        if (this.noul >= thresholdYes)
            return "yes";
        if (this.noul <= thresholdNo)
            return "no";
        return "person";
    }
}
function probs(v) {
    const out = {};
    for (const [k, p] of Object.entries((v ?? {})))
        out[k] = Number(p);
    return out;
}
export function parseAnswer(data) {
    switch (data.type) {
        case "noul":
            return new NoulAnswer(Number(data.noul), data);
        case "choice":
            return { type: "choice", choice: String(data.choice), probabilities: probs(data.probabilities), raw: data };
        case "score":
            return {
                type: "score",
                score: Number(data.score),
                level: Number(data.level),
                probabilities: probs(data.probabilities),
                raw: data,
            };
        default:
            throw new TypeError(`unknown answer type: ${JSON.stringify(data.type)}`);
    }
}
export function parseResponse(data) {
    const answers = {};
    for (const [name, a] of Object.entries((data.answers ?? {}))) {
        answers[name] = parseAnswer(a);
    }
    const u = (data.usage ?? {});
    return {
        model: String(data.model ?? ""),
        answers: answers,
        usage: { input_tokens: Number(u.input_tokens ?? 0), output_tokens: Number(u.output_tokens ?? 0) },
        raw: data,
    };
}
