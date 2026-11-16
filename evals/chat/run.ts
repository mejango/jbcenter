// Asks the configured model every question once, in-process, against the real tools.
// Spends model money: run it only with a provider and budget jango approved.
//   npm run eval:chat [-- --only <id or id prefix>]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTools } from "@juicebox/mcp/host";
import { loadChatConfig } from "../../src/chat/config.js";
import { runChat } from "../../src/chat/loop.js";
import { createProvider } from "../../src/chat/provider.js";
import type { Source } from "../../src/chat/sources.js";
import { chatTools } from "../../src/chat/tools.js";
import { createCenterMcp } from "../../src/mcp.js";
import { createRpcGateway, dwellirRpcUpstreams } from "../../src/rpc.js";
import { MemoryStore } from "../../test/support/memoryStore.js";
import { grade, type Question } from "./grade.js";

const config = loadChatConfig(process.env);
if (!config) throw new Error("Set CHAT_PROVIDER, CHAT_MODEL and the provider's key first.");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const questions = (JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")) as Question[])
  .filter(({ id }) => !only || id.startsWith(only));

// Reads only: an empty store, the real chains and the real indexer.
const mcp = createCenterMcp(new MemoryStore(), { rpc: createRpcGateway(dwellirRpcUpstreams(process.env.DWELLIR_API_KEY)) });
const deps = { config, provider: createProvider(config), tools: chatTools(createTools(mcp.services)), origin: mcp.config.publicOrigin };

const rows: ({ id: string; group: string; pass: boolean; reasons: string[]; in: number; out: number; tools: number; calls: string[]; text: string; sources: Source[] })[] = [];
for (const question of questions) {
  let text = "", done: { reason: string; inputTokens: number; outputTokens: number; toolCalls: number } | undefined;
  const sources: Source[] = [], calls: string[] = [];
  for await (const event of runChat({ ...deps, messages: [{ role: "user", text: question.ask }], signal: new AbortController().signal })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "source") sources.push(event.source);
    else if (event.type === "tool") calls.push(event.name);
    else if (event.type === "done") done = event;
  }
  const result = done?.reason === "end" ? grade(question, { text, sources }) : { pass: false, reasons: [`ended: ${done?.reason ?? "cut"}`] };
  rows.push({ id: question.id, group: question.group, ...result, in: done?.inputTokens ?? 0, out: done?.outputTokens ?? 0, tools: done?.toolCalls ?? 0, calls, text, sources });
  console.log(`${result.pass ? "pass" : "FAIL"}  ${question.id.padEnd(28)} in ${String(done?.inputTokens ?? 0).padStart(7)}  out ${String(done?.outputTokens ?? 0).padStart(5)}  ${result.reasons.join("; ")}`);
}

for (const group of new Set(rows.map((row) => row.group))) {
  const mine = rows.filter((row) => row.group === group);
  console.log(`${group}: ${mine.filter((row) => row.pass).length}/${mine.length}`);
}
const sum = (key: "in" | "out") => rows.reduce((total, row) => total + row[key], 0);
console.log(`total: ${rows.filter((row) => row.pass).length}/${rows.length}, tokens in ${sum("in")}, out ${sum("out")}`);
const out = new URL(`./out/${config.provider}-${config.model.replace(/[^\w.-]/g, "_")}.json`, import.meta.url);
await mkdir(new URL("./", out), { recursive: true });
await writeFile(out, JSON.stringify(rows, null, 1));
