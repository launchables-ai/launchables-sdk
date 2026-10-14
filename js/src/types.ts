import type { Question, Questions } from "./questions.js";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type Decision = "yes" | "no" | "person";

export interface DecideThresholds {
  /** Probability at or above which the answer is "yes". Default 0.9. */
  thresholdYes?: number;
  /** Probability at or below which the answer is "no". Default 0.1. */
  thresholdNo?: number;
}

/** Yes/no answer. `noul` (alias `probability`) is the probability of yes, 0 to 1. */
export class NoulAnswer {
  readonly type = "noul" as const;
  constructor(
    readonly noul: number,
    readonly raw: Record<string, unknown> = {},
  ) {}

  get probability(): number {
    return this.noul;
  }

  /** "yes" if p >= thresholdYes, "no" if p <= thresholdNo, otherwise "person" (hand off to a person). */
  decide({ thresholdYes = 0.9, thresholdNo = 0.1 }: DecideThresholds = {}): Decision {
    if (!(thresholdNo >= 0 && thresholdNo <= thresholdYes && thresholdYes <= 1)) {
      throw new RangeError("thresholds must satisfy 0 <= thresholdNo <= thresholdYes <= 1");
    }
    if (this.noul >= thresholdYes) return "yes";
    if (this.noul <= thresholdNo) return "no";
    return "person";
  }
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  raw: Record<string, unknown>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  level: number;
  probabilities: Record<string, number>;
  raw: Record<string, unknown>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerFor<Q extends Question> = Q extends { type: "noul" }
  ? NoulAnswer
  : Q extends { type: "choice" }
    ? ChoiceAnswer
    : Q extends { type: "score" }
      ? ScoreAnswer
      : Answer;

export interface DecisionResponse<Q extends Questions = Questions> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: Usage;
  raw: Record<string, unknown>;
}

export interface Model {
  id: string;
  object: string;
  owned_by: string;
}

type Obj = Record<string, unknown>;

function probs(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries((v ?? {}) as Obj)) out[k] = Number(p);
  return out;
}

export function parseAnswer(data: Obj): Answer {
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

export function parseResponse<Q extends Questions>(data: Obj): DecisionResponse<Q> {
  const answers: Record<string, Answer> = {};
  for (const [name, a] of Object.entries((data.answers ?? {}) as Record<string, Obj>)) {
    answers[name] = parseAnswer(a);
  }
  const u = (data.usage ?? {}) as Obj;
  return {
    model: String(data.model ?? ""),
    answers: answers as DecisionResponse<Q>["answers"],
    usage: { input_tokens: Number(u.input_tokens ?? 0), output_tokens: Number(u.output_tokens ?? 0) },
    raw: data,
  };
}
