import {
  readGuidanceSection,
  searchGuidance,
} from "../application/GuidanceAccess.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register provider-free search and retrieval over the installed guide bundle. */
export const registerGuidanceTools = (server: EvidenceMcpServer): void => {
  const search = toolContract("search_guidance");
  server.registerTool(
    search.name,
    toolRegistrationOptions(search),
    async (input) =>
      server.delivery.toCallToolResult(await searchGuidance(input), search),
  );

  const read = toolContract("read_guidance_section");
  server.registerTool(read.name, toolRegistrationOptions(read), async (input) =>
    server.delivery.toCallToolResult(await readGuidanceSection(input), read),
  );
};
