//@category REA Verification

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.SourceType;

/** Run the production seed script against a minimal 32-bit import. */
public final class ReaSeedRegressionProbe extends GhidraScript {
    @Override
    public void run() throws Exception {
        currentProgram.getMemory().createUninitializedBlock(
            ".bss", toAddr(0x1000), 0x20, false
        );
        runScript("ReaGhidraApplySeeds.java", new String[] { getScriptArgs()[0] });
        JsonObject initial = JsonParser.parseString(
            currentProgram.getOptions(Program.PROGRAM_INFO)
                .getString("REA analysis seeds", null)
        ).getAsJsonObject();
        require(initial.get("entries").getAsInt() == 6, "all seeds accounted for");
        require(initial.get("function_created").getAsInt() == 1,
            "out-of-range seed must not disturb descending function order");
        require(initial.get("function_failed").getAsInt() == 0, "no swallowed function entry");
        require(initial.get("function_body_created").getAsInt() == 2,
            "exact function bodies created");
        require(initial.get("function_body_failed").getAsInt() == 0,
            "exact function body accepted");
        require(getFunctionAt(toAddr(0)).getName().equals("seed_low"), "lower function name");
        require(getFunctionAt(toAddr(0)).getBody().getNumAddresses() == 1,
            "lower function exact one-byte body");
        require(getFunctionAt(toAddr(1)).getName().equals("seed_high"), "higher function name");
        require(initial.get("label_applied").getAsInt() == 1, "mapped BSS label applied");
        require(currentProgram.getSymbolTable().getPrimarySymbol(toAddr(0x1000))
            .getName().equals("seed_global"), "BSS label name");
        require(initial.get("unmapped").getAsInt() == 2,
            "only out-of-range function and uninitialized code seed are skipped");
        require(initial.get("code_decoded").getAsInt() == 0, "BSS is not decoded");

        // Model an analyzer splitting an authenticated body at an inferred entry.
        getFunctionAt(toAddr(2)).setBody(new AddressSet(toAddr(2), toAddr(2)));
        require(currentProgram.getFunctionManager().createFunction(
            "inferred_conflict", toAddr(3), new AddressSet(toAddr(3), toAddr(4)),
            SourceType.ANALYSIS
        ) != null, "create inferred conflicting function");
        runScript("ReaGhidraApplySeeds.java", new String[] {
            getScriptArgs()[0], "reconcile"
        });
        JsonObject report = JsonParser.parseString(
            currentProgram.getOptions(Program.PROGRAM_INFO)
                .getString("REA analysis seeds", null)
        ).getAsJsonObject();
        require(report.get("phase").getAsString().equals("post_analysis_reconcile"),
            "reconcile phase reported");
        require(report.get("function_body_conflicts_removed").getAsInt() == 1,
            "inferred conflicting function removed");
        require(getFunctionAt(toAddr(3)) == null, "conflicting entry absent");
        require(getFunctionAt(toAddr(2)).getBody().equals(
            new AddressSet(toAddr(2), toAddr(4))
        ), "authenticated body restored");
        println("REA_SEED_REGRESSION_OK " + report);
    }

    private void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
