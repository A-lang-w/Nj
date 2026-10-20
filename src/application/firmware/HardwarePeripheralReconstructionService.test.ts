import { describe, expect, it } from "vitest";
import {
  hardwarePeripheralReconstructionSchema,
  reconstructHardwareFromReferences,
  reconstructProcedureHardwareInteractions,
} from "./HardwarePeripheralReconstructionService.js";
import type { AnalyzedInstructionReference } from "../../domain/firmware/hardwarePeripheralAttribution.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../AnalysisProvider.js";
import { err, ok } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../domain/ghidraValues.fixture.js";

describe("Hardware peripheral reconstruction from offline instruction references", () => {
  it("reconstructs peripheral blocks and identifies standard architectural registers", () => {
    const references: AnalyzedInstructionReference[] = [
      // UART1 registers
      {
        target_address: "0x40011000",
        source_address: "0x08000100",
        write: true,
      },
      {
        target_address: "0x40011004",
        source_address: "0x08000104",
        read: true,
      },
      // SysTick Control Register (ARM SCS standard)
      {
        target_address: "0xe000e010",
        source_address: "0x08000108",
        write: true,
      },
      // Internal SRAM (non-MMIO)
      {
        target_address: "0x20000040",
        source_address: "0x0800010c",
        read: true,
      },
    ];

    const report = reconstructHardwareFromReferences(
      references,
      "arm",
      "uart_init",
    );

    expect(report.procedure).toBe("uart_init");
    expect(report.architecture).toBe("arm");
    expect(report.totalReferencesExamined).toBe(4);
    expect(report.mmioAccessCount).toBe(3);
    expect(report.nonMmioAccessCount).toBe(1);
    expect(report.peripheralBlocks).toHaveLength(2);

    // 0x40011000 is GPIOC on STM32F1 and GD32, and USART1 on STM32F4.
    const uartBlock = report.peripheralBlocks[0];
    expect(uartBlock?.blockBase).toBe("0x40011000");
    expect(uartBlock?.totalAccesses).toBe(2);
    expect(uartBlock?.knownRegisters).toEqual([]);
    expect(uartBlock?.regionName).toBe("Peripheral MMIO");
    expect(uartBlock?.socPeripheralName ?? null).toBeNull();
    expect(report.limitations).toEqual([
      "SoC platform is unresolved because stm32f1, stm32f4, gd32f1 share the highest peripheral match count",
    ]);

    // Block 1: SCS (0xe000e000)
    const scsBlock = report.peripheralBlocks[1];
    expect(scsBlock?.blockBase).toBe("0xe000e000");
    expect(scsBlock?.totalAccesses).toBe(1);
    expect(scsBlock?.knownRegisters).toEqual(["SysTick_CTRL"]);

    const parsed = hardwarePeripheralReconstructionSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it("records limitations for malformed target address references", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "malformed_addr" },
    ];

    const report = reconstructHardwareFromReferences(references, "arm");
    expect(report.totalReferencesExamined).toBe(0);
    expect(report.limitations).toHaveLength(1);
    expect(report.limitations[0]).toContain("Failed to attribute reference");
  });

  it("enriches peripheral blocks with STM32F1 and ESP32 SoC peripheral definitions", () => {
    // STM32F1 GPIOA and USART1
    const stm32Refs: AnalyzedInstructionReference[] = [
      { target_address: "0x40010804", write: true }, // GPIOA
      { target_address: "0x40013800", read: true }, // USART1
    ];

    const stm32Report = reconstructHardwareFromReferences(
      stm32Refs,
      "arm",
      "stm32_driver",
      "stm32f1",
    );

    expect(stm32Report.peripheralBlocks).toHaveLength(2);
    const gpioa = stm32Report.peripheralBlocks.find(
      (b) => b.blockBase === "0x40010000" || b.socPeripheralName === "GPIOA",
    );
    expect(gpioa?.socPeripheralName).toBe("GPIOA");
    expect(gpioa?.socPeripheralBus).toBe("APB2");

    // ESP32 UART0 and GPIO
    const esp32Refs: AnalyzedInstructionReference[] = [
      { target_address: "0x3ff40000", write: true }, // UART0
      { target_address: "0x3ff44004", read: true }, // GPIO
    ];

    const esp32Report = reconstructHardwareFromReferences(
      esp32Refs,
      "riscv",
      "esp32_app",
      "esp32",
    );

    expect(esp32Report.peripheralBlocks).toHaveLength(2);
    const uart0 = esp32Report.peripheralBlocks.find(
      (b) => b.socPeripheralName === "UART0",
    );
    expect(uart0?.socPeripheralName).toBe("UART0");
    expect(uart0?.socPeripheralBus).toBe("DPort");
  });

  it("automatically detects candidate SoC platform when unspecified", () => {
    const references: AnalyzedInstructionReference[] = [
      { target_address: "0x40010800", write: true },
      { target_address: "0x40013800", read: true },
      { target_address: "0x40021000", write: true },
    ];

    const report = reconstructHardwareFromReferences(references, "arm");
    expect(report.detectedPlatforms.length).toBeGreaterThanOrEqual(1);
    expect(report.detectedPlatforms[0]?.platform).toBe("stm32f1");
    expect(report.detectedPlatforms[0]?.confidence).toBe(1.0);
    expect(
      report.peripheralBlocks.every((block) => block.socPeripheralName == null),
    ).toBe(true);
    expect(report.limitations[0]).toContain("stm32f1, gd32f1");
  });
});

describe("SoC catalog selection", () => {
  it("names a peripheral only when one catalog leads", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x40023800", read: true }],
      "arm",
    );

    expect(report.detectedPlatforms).toEqual([
      {
        platform: "stm32f4",
        matchedCount: 1,
        totalAddresses: 1,
        confidence: 1,
        matchedPeripherals: ["RCC"],
      },
    ]);
    expect(report.peripheralBlocks[0]?.socPeripheralName).toBe("RCC");
    expect(report.peripheralBlocks[0]?.regionKind).toBe("peripheral_mmio");
    expect(report.limitations).toEqual([]);
  });

  it("keeps an ESP32-C UART when unrelated references are present", () => {
    const report = reconstructHardwareFromReferences(
      [
        { target_address: "0x60000000", read: true },
        { target_address: "0x20000040", read: true },
        { target_address: "0x80001000", read: true },
      ],
      "riscv",
    );

    expect(report.detectedPlatforms[0]).toMatchObject({
      platform: "esp32",
      matchedCount: 1,
      totalAddresses: 1,
      confidence: 1,
    });
    const uart = report.peripheralBlocks.find(
      (block) => block.socPeripheralName === "UART0",
    );
    expect(uart?.regionKind).toBe("peripheral_mmio");
    expect(uart?.socPeripheralBus).toBe("System");
  });

  it("does not rename an x86 data read to an ESP32 UART", () => {
    const report = reconstructHardwareFromReferences(
      [{ target_address: "0x3ff40000", read: true }],
      "x86",
    );

    expect(report.detectedPlatforms).toEqual([]);
    expect(
      report.peripheralBlocks.some((block) =>
        (block.socPeripheralName ?? "").includes("UART0"),
      ),
    ).toBe(false);
    expect(report.attributions[0]?.regionName).toBe("System RAM");
    expect(report.attributions[0]?.isMmio).toBe(false);
  });
});

describe("Hardware peripheral reconstruction through analysis operation port", () => {
  it("queries procedure references and reconstructs peripheral interaction profile", async () => {
    const mockExecution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          {
            source_address: "0x08000200",
            target_address: "0x40020000", // GPIOA MODER
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "WRITE",
              flow: false,
              call: false,
              jump: false,
              data: true,
              read: false,
              write: true,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
          {
            source_address: "0x08000204",
            target_address: "0xe000e100", // NVIC_ISER0
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "WRITE",
              flow: false,
              call: false,
              jump: false,
              data: true,
              read: false,
              write: true,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
          {
            // Pure function call (should be filtered out of MMIO attribution)
            source_address: "0x08000208",
            target_address: "0x08000500",
            source_procedure: ghidraFunctionIdentity(),
            target_procedure: null,
            kind: {
              available: true,
              provenance: "test",
              type: "CALL",
              flow: true,
              call: true,
              jump: false,
              data: false,
              read: false,
              write: false,
              indirect: false,
              computed: false,
              conditional: false,
              terminal: false,
              primary: true,
              operand_index: 0,
              external: false,
            },
          },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "a".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [],
    };

    const mockPort: AnalysisOperationPort = {
      execute: (operation, parameters) => {
        expect(operation).toBe("procedure_references");
        expect(parameters).toEqual({
          procedure: "gpio_setup",
          direction: "outgoing",
        });
        return Promise.resolve(ok(mockExecution));
      },
    };

    const result = await reconstructProcedureHardwareInteractions(mockPort, {
      procedure: "gpio_setup",
      architecture: "arm",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.procedure).toBe("gpio_setup");
    expect(result.value.totalReferencesExamined).toBe(2);
    expect(result.value.mmioAccessCount).toBe(2);
    expect(result.value.peripheralBlocks).toHaveLength(2);

    const nvicBlock = result.value.peripheralBlocks.find(
      (b) => b.blockBase === "0xe000e000",
    );
    expect(nvicBlock?.knownRegisters).toContain("NVIC_ISER0");
  });

  it("propagates cancellation and input validation errors", async () => {
    const mockPort: AnalysisOperationPort = {
      execute: () =>
        Promise.resolve(err(new AnalysisOutputError("test", "fail"))),
    };

    const controller = new AbortController();
    controller.abort();

    const cancelled = await reconstructProcedureHardwareInteractions(
      mockPort,
      { procedure: "test_fn", architecture: "arm" },
      { signal: controller.signal },
    );
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");

    const invalidInput = await reconstructProcedureHardwareInteractions(
      mockPort,
      { procedure: "", architecture: "arm" },
    );
    expect(invalidInput.ok).toBe(false);
    if (invalidInput.ok) return;
    expect(invalidInput.error._tag).toBe("AnalysisInputError");
  });
});

describe("Ghidra procedure reference shape", () => {
  it("keeps classification, body, direction, and source_procedure", async () => {
    const edge = { ...ghidraReferenceEdge(), target_address: "0x40011000" };
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [edge],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "b".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [],
    };
    const result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      { procedure: "fixture_main", architecture: "arm", platform: "stm32f4" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalReferencesExamined).toBe(1);
    expect(result.value.attributions[0]?.targetAddress).toBe("0x40011000");
  });

  it("keeps provider limitations ahead of local address errors", async () => {
    const providerLimitation = "Ghidra omitted operand kinds for one edge";
    const execution: AnalysisExecution = {
      result: {
        procedure: ghidraFunctionIdentity(),
        direction: "outgoing",
        reference_kinds_available: true,
        references: [
          ghidraReferenceEdge(),
          { ...ghidraReferenceEdge(), target_address: "not-an-address" },
        ],
        unresolved_calls: [],
      },
      rawResult: null,
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      locations: [],
      subject: {
        sha256: "c".repeat(64),
        path: "/tmp/firmware.bin",
        format: "raw-binary",
        architecture: "arm",
      },
      limitations: [providerLimitation],
    };

    const result = await reconstructProcedureHardwareInteractions(
      { execute: () => Promise.resolve(ok(execution)) },
      { procedure: "fixture_main", architecture: "arm" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitations[0]).toBe(providerLimitation);
    expect(result.value.limitations.at(-1)).toContain(
      "Failed to attribute reference to not-an-address",
    );
  });
});
