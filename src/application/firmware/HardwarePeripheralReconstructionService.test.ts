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

    // Block 0: UART1 (0x40011000)
    const uartBlock = report.peripheralBlocks[0];
    expect(uartBlock?.blockBase).toBe("0x40011000");
    expect(uartBlock?.totalAccesses).toBe(2);
    expect(uartBlock?.knownRegisters).toEqual([]);

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
  });
});

describe("Hardware peripheral reconstruction through analysis operation port", () => {
  it("queries procedure references and reconstructs peripheral interaction profile", async () => {
    const mockExecution: AnalysisExecution = {
      result: {
        reference_kinds_available: true,
        references: [
          {
            source_address: "0x08000200",
            target_address: "0x40020000", // GPIOA MODER
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
