// The breaker panel's state machine. No DOM here, so it can be tested on its own.
// Each circuit names a guard the harness really has; the text says what the guard does when it trips.

export const CIRCUITS = [
  {
    id: "spend",
    label: "Spend cap",
    rating: "$3 per day",
    stops: "A runaway loop, or a provider with no hard limit.",
    event: "Call refused before it was made. Its worst case would have crossed the daily cap. Spent so far: $0.00.",
    how: "The worst case is reserved against the daily and total caps before every call. A model with no known price is refused.",
  },
  {
    id: "coverage",
    label: "Coverage gate",
    rating: "every test",
    stops: "Writing a test that already exists.",
    event: "Run refused. An existing test already imports this module and the issue does not mention it.",
    how: "Every test file is searched for imports of the module. The issue has to name each one it finds.",
  },
  {
    id: "scope",
    label: "One file",
    rating: "1 path",
    stops: "Edits outside the task.",
    event: "Change refused. It touches a file other than the single path the issue names. Nothing was written.",
    how: "The result must be exactly the path in the issue. The harness writes the file itself, not the model.",
  },
  {
    id: "secrets",
    label: "Secret scan",
    rating: "reply + file",
    stops: "Keys and tokens leaking into output.",
    event: "Output refused. A secret-shaped string was found. The run stopped and the kill switch was set.",
    how: "The reply and the written file are scanned for known secret shapes. The sandbox environment is an allowlist.",
  },
  {
    id: "egress",
    label: "Egress allowlist",
    rating: "model + git",
    stops: "The agent reaching anywhere else.",
    event: "Network call refused. The host is not on the allowlist. The run stopped.",
    how: "Only the model endpoint and git are reachable. Documentation hosts such as example.com count as fixtures, not calls.",
  },
  {
    id: "branch",
    label: "Branch rule",
    rating: "agent/* only",
    stops: "Anything landing on main.",
    event: "Publish refused. Only agent/* branches can be published. main is never reachable.",
    how: "The publish gate rejects any other branch name, including look-alikes and anything containing '..'.",
  },
];

export const MAIN_EVENT = "Kill switch set. Every circuit is open and nothing further runs. Only a person resets it.";
export const LOCKED_EVENT = "The main kill switch is open. Reset it first.";

export function createPanel(circuits = CIRCUITS) {
  const ids = new Set(circuits.map((c) => c.id));
  const tripped = new Set();
  let main = false;
  let last = null;

  const note = (kind, id, text) => (last = { kind, id, text });
  const byId = (id) => {
    if (!ids.has(id)) throw new Error(`unknown circuit "${id}"`);
    return circuits.find((c) => c.id === id);
  };

  return {
    circuits,
    isTripped: (id) => (byId(id), tripped.has(id)),
    isMainTripped: () => main,
    trippedCount: () => tripped.size,
    lastEvent: () => last,

    /** Click on a circuit: trips it if closed, resets it if open. Locked while the main switch is open. */
    toggle(id) {
      const c = byId(id);
      if (main) return note("locked", id, LOCKED_EVENT);
      if (tripped.has(id)) {
        tripped.delete(id);
        return note("reset", id, `${c.label} reset by a person.`);
      }
      tripped.add(id);
      return note("trip", id, c.event);
    },

    killAll() {
      for (const c of circuits) tripped.add(c.id);
      main = true;
      return note("main", "main", MAIN_EVENT);
    },

    resetAll() {
      tripped.clear();
      main = false;
      return note("resetAll", "main", "Everything reset by a person.");
    },
  };
}
