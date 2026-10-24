import { expect, it } from "vitest";
import { buildCapabilityInventory } from "../../../../src/application/CapabilityInventory.js";
import { providerCapabilitySets } from "../../../../src/application/binary/BinarySessionStatus.js";
import { idaCapabilities } from "../../../../src/ida/IdaProviderCapabilities.js";
import { IDA_OPERATIONS } from "../../../../src/ida/IdaProviderCapabilities.js";
import {
  TOOL_EFFECTS,
  toolSessionEffects,
} from "../../../../src/contracts/toolEffects.js";

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  browserObservationEnabled: true,
  browserScenarioEnabled: true,
  electronObservationEnabled: true,
  v8InspectorObservationEnabled: true,
};

it("audits every IDA operation's network transport without adding it to the session base", () => {
  for (const name of IDA_OPERATIONS) {
    expect(TOOL_EFFECTS[name]?.accessesNetwork, name).toBe(true);
    expect(toolSessionEffects(name).accessesNetwork, name).toBe(false);
  }
});

it.each([
  ["attached", false, false],
  ["attached", true, true],
  ["headless", true, false],
] as const)(
  "covers IDA provider effects in the global audit (%s, stdio=%s, native=%s)",
  (mode, stdio, native) => {
    for (const descriptor of idaCapabilities(mode, stdio, native)) {
      const audited = TOOL_EFFECTS[descriptor.operation];
      expect(audited, descriptor.operation).toBeDefined();
      if (descriptor.effects.mayAccessNetwork)
        expect(audited?.accessesNetwork, descriptor.operation).toBe(true);
      if (descriptor.effects.mayShowUi)
        expect(audited?.changesUiState, descriptor.operation).toBe(true);
      if (descriptor.effects.launchesProcess)
        expect(audited?.launchesProcess, descriptor.operation).toBe(true);
      if (descriptor.effects.mayWriteFilesystem)
        expect(audited?.writesFilesystem, descriptor.operation).toBe(true);
    }
  },
);

it.each([false, true])(
  "retains selected provider UI/process/network effects in direct and composed discovery (UI=%s)",
  (showUi) => {
    const input = {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(
        idaCapabilities(showUi ? "attached" : "headless", false),
      ),
    };
    const entries = buildCapabilityInventory(input, enabledPolicy);
    for (const name of [
      "procedure_pseudo_code",
      "procedure_assembly",
      "read_function_instructions",
      "analyze_function",
      "batch_decompile",
      "decompile_all",
      "trace_native_values",
      "inspect_native_api",
    ]) {
      expect(entries.find((entry) => entry.name === name)).toMatchObject({
        effects: {
          changesUiState: showUi,
          accessesNetwork: true,
        },
        annotations: { open_world: true },
      });
    }
    for (const name of ["list_procedures", "search_strings", "trace_feature"]) {
      expect(entries.find((entry) => entry.name === name)).toMatchObject({
        effects: { changesUiState: false, accessesNetwork: true },
        annotations: { open_world: true },
      });
    }
  },
);

it("omits effects of IDA calls hidden behind unavailable workflow prerequisites", () => {
  const entries = buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(idaCapabilities("attached", false)),
    },
    enabledPolicy,
  );
  for (const name of ["find_xrefs_to_name", "get_navigation_context"]) {
    expect(TOOL_EFFECTS[name], name).toMatchObject({
      accessesNetwork: false,
      launchesProcess: false,
      writesFilesystem: false,
    });
    expect(
      entries.find((entry) => entry.name === name),
      name,
    ).toMatchObject({
      available: false,
      effects: {
        accessesNetwork: false,
        launchesProcess: false,
        writesFilesystem: false,
      },
      annotations: { open_world: false },
    });
  }
});

it("keeps native attached UI effects limited to the operations that show them", () => {
  const input = {
    open: true,
    kind: "executable",
    capabilities: providerCapabilitySets(
      idaCapabilities("attached", true, true),
    ),
  };
  const entries = buildCapabilityInventory(input, enabledPolicy);
  for (const [name, showUi] of [
    ["procedure_pseudo_code", true],
    ["analyze_function", true],
    ["procedure_assembly", false],
    ["read_function_instructions", false],
  ] as const) {
    expect(
      entries.find((entry) => entry.name === name),
      name,
    ).toMatchObject({
      effects: { changesUiState: showUi, accessesNetwork: true },
      annotations: { open_world: true },
    });
  }
});
