// Rule-based choices, used for the Standard run and whenever the AI is not available.
// Staff first show the people in their room the way out; everyone else takes the fastest exit they know about,
// and shelters only when no exit can be reached.
import type { Decision, DecisionRequest, Policy } from "./types";

export const standardPolicy: Policy = {
  name: "standard",
  async decide(reqs: DecisionRequest[]): Promise<Decision[]> {
    return reqs.map((r) => {
      const pick = (kind: string) => r.options.find((o) => o.action.kind === kind);
      const exits = r.options.filter((o) => o.action.kind === "go_exit"); // listed best first (time, smoke, fire)
      let o = undefined as (typeof r.options)[number] | undefined;
      let reason = "";
      if (r.persona === "staff" && r.trigger === "alarm" && pick("guide")) { o = pick("guide"); reason = "Staff show the people around them the way out first."; }
      else if (exits[0]) { o = exits[0]; reason = "Best exit this person knows about: quickest, away from smoke and fire."; }
      else if (pick("follow")) { o = pick("follow"); reason = "No known exit can be reached; following others."; }
      else { o = pick("shelter") ?? r.options[0]; reason = "No exit can be reached."; }
      return { agentId: r.agentId, optionId: o?.id ?? "A", reason, source: "standard" as const };
    });
  },
};
