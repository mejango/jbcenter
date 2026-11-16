import type { ChatEvent } from "../loop.js";

/** The events of a `/chat` response, in order. A cut stream simply ends, without a `done`. */
export async function* readEvents(response: Response): AsyncIterable<ChatEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
      const block = buffer.slice(0, end);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (type && data) yield { type, ...JSON.parse(data) };
    }
  }
}
