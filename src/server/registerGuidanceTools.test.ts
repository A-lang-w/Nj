import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { toolContract } from "../contracts/toolContracts.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { registerGuidanceTools } from "./registerGuidanceTools.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

const open: { client: Client; server: EvidenceMcpServer }[] = [];
afterEach(async () => {
  await Promise.all(
    open
      .splice(0)
      .flatMap(({ client, server }) => [client.close(), server.close()]),
  );
});

it("advertises strict provider-free search and retrieval contracts over MCP", async () => {
  const server = new EvidenceMcpServer(
    { name: "guidance-test", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
    undefined,
    new ToolResultDelivery(1024 * 1024),
  );
  registerGuidanceTools(server);
  const client = new Client({ name: "guidance-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });

  const listed = await client.listTools();
  expect(listed.tools.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["search_guidance", "read_guidance_section"]),
  );
  expect(
    toolContract("search_guidance").inputSchema.safeParse({
      query: "module",
      unexpected: true,
    }).success,
  ).toBe(false);
  const invalidLocator = await client.callTool({
    name: "read_guidance_section",
    arguments: { locator: "../../outside.md" },
  });
  expect(invalidLocator.isError).toBe(true);
  const response = await client.callTool({
    name: "search_guidance",
    arguments: { query: "exact JavaScript module" },
  });
  expect(response.isError).not.toBe(true);
  const payload = (response.structuredContent as { result: unknown }).result;
  const parsed = toolContract("search_guidance").outputSchema.parse(payload);
  expect(parsed).toMatchObject({
    status: "matches",
    source: "installed_rea_guidance",
  });
  if (parsed.status !== "matches") throw new Error("Expected guidance matches");
  const selected = parsed.matches.find(
    ({ heading }) => heading === "Read a module without repeating analysis",
  );
  expect(selected).toBeDefined();
  const section = await client.callTool({
    name: "read_guidance_section",
    arguments: { locator: selected?.locator },
  });
  expect(section.isError).not.toBe(true);
  expect(
    toolContract("read_guidance_section").outputSchema.parse(
      (section.structuredContent as { result: unknown }).result,
    ),
  ).toMatchObject({
    status: "section",
    heading: selected?.heading,
    source: "installed_rea_guidance",
  });
  const firstPage = await client.callTool({
    name: "search_guidance",
    arguments: { query: "module", limit: 1 },
  });
  const firstResult = toolContract("search_guidance").outputSchema.parse(
    (firstPage.structuredContent as { result: unknown }).result,
  );
  if (firstResult.status !== "matches" || firstResult.next_cursor === undefined)
    throw new Error("Expected a guidance continuation token");
  const nextPage = await client.callTool({
    name: "search_guidance",
    arguments: {
      query: "module",
      limit: 1,
      cursor: firstResult.next_cursor,
    },
  });
  expect(
    toolContract("search_guidance").outputSchema.parse(
      (nextPage.structuredContent as { result: unknown }).result,
    ),
  ).toMatchObject({ status: "matches", offset: 1 });
});
