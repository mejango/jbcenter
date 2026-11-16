import type { Provider, ProviderRequest, ToolOutcome, TurnEvent } from "../../src/chat/provider.js";

/** A scripted model: each entry is one round's events, or an error that round throws. */
export function fakeProvider(rounds: (TurnEvent[] | Error)[]): Provider & { requests: ProviderRequest[]; outcomes: ToolOutcome[][]; last: boolean[] } {
  const requests: ProviderRequest[] = [];
  const outcomes: ToolOutcome[][] = [];
  const last: boolean[] = [];
  let round = 0;
  return {
    requests,
    outcomes,
    last,
    start(request) {
      requests.push(request);
      return {
        async *next(given, final = false) {
          if (given) outcomes.push(given);
          last.push(final);
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
