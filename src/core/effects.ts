/**
 * Effects are data. A step returns Effect[]; the runner executes them and feeds
 * typed results back into state. `outcome` is a decision value: a branch routes
 * on it. A lease conflict is an edge to a rebase-and-retry node, never an
 * exception. `infra-failed` is distinct from `rejected` so a flaky harness does
 * not burn the retry budget on a change that was fine.
 *
 * Notably absent from the union: create-issue, send-message, or anything else
 * that is a shared, outward-facing action. The only way to defer is a
 * needs-human terminal with a typed reason.
 */

export type Effect =
  | { type: "replace-symbol"; symbolId: string; expectedVersion: number; body: string }
  | { type: "upsert-artifact"; table: string; id: string; expectedVersion: number; row: unknown }
  | { type: "run-tests"; impacted: string[] }
  | { type: "append-trail"; line: string };

/**
 * `by` names the gate that refused the write. Five members, covering the three
 * failure categories the agent-native VCS distinguishes (`src/vcs`, ai-vcs.md
 * § 5.4): `contract` is "you declared one thing and did another",
 * `structural` is "the edit does not parse", and `typecheck` / `tests` /
 * `schema` are quality signals from a check that ran. An infrastructure
 * failure is not in here at all; it is `infra-failed`, so a flaky harness
 * cannot be mistaken for a bad change.
 */
export type RejectedBy = "typecheck" | "tests" | "schema" | "contract" | "structural";

export type EffectResult =
  | { effect: Effect; outcome: "committed"; version: number }
  | { effect: Effect; outcome: "conflict"; currentVersion: number }
  | { effect: Effect; outcome: "rejected"; by: RejectedBy }
  | { effect: Effect; outcome: "infra-failed" };

export type Artifact = { version: number; row: unknown };

/**
 * In-memory effect executor. Artifacts live in a Map under an optimistic
 * version check; the trail is an array. `replace-symbol` and `run-tests` come
 * back `infra-failed` because there is no VCS and no test runner behind this
 * executor yet — that is the honest outcome, not `rejected`.
 */
export const memoryEffects = () => {
  const artifacts = new Map<string, Artifact>();
  const trail: string[] = [];

  const upsert = (e: Extract<Effect, { type: "upsert-artifact" }>): EffectResult => {
    const key = `${e.table}/${e.id}`;
    const current = artifacts.get(key);
    const currentVersion = current?.version ?? 0;
    if (e.expectedVersion !== currentVersion) return { effect: e, outcome: "conflict", currentVersion };
    const version = currentVersion + 1;
    artifacts.set(key, { version, row: e.row });
    return { effect: e, outcome: "committed", version };
  };

  const execute = async (effects: Effect[]): Promise<EffectResult[]> =>
    effects.map((effect): EffectResult => {
      switch (effect.type) {
        case "upsert-artifact":
          return upsert(effect);
        case "append-trail":
          trail.push(effect.line);
          return { effect, outcome: "committed", version: trail.length };
        case "replace-symbol":
        case "run-tests":
          return { effect, outcome: "infra-failed" };
      }
    });

  return { execute, artifacts, trail };
};
