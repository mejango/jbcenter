import type { Provider, ProviderRequest, ToolOutcome, TurnEvent } from "../../src/chat/provider.js";

/** A scripted model: each entry is one round's events, or an error that round throws. */
export function fakeProvider(rounds: (TurnEvent[] | Error)[]): Provider & { requests: ProviderRequest[]; outcomes: ToolOutcome[][] } {
  const requests: ProviderRequest[] = [];
  const outcomes: ToolOutcome[][] = [];
  let round = 0;
  return {
    requests,
    outcomes,
    start(request) {
      requests.push(request);
      return {
        async *next(given) {
          if (given) outcomes.push(given);
          const script = rounds[round++] ?? [{ type: "stop", reason: "end" }];
          if (script instanceof Error) throw script;
          for (const event of script) {
            if (request.signal.aborted) return;
            yield event;
          }
        },
      };
    },
  };
}
