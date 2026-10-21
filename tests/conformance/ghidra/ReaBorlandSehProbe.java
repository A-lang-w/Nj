//@category REA Verification
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;

/** Verify the production producer on a real, source-owned PE32 Program. */
public class ReaBorlandSehProbe extends GhidraScript {
    private Address at(long value) { return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(value); }
    private void require(boolean value, String message) { if (!value) throw new IllegalStateException(message); }
    @Override public void run() throws Exception {
        var function = currentProgram.getFunctionManager().getFunctionAt(at(0x401000));
        require(function != null, "missing fixture entry");
        var original = new AddressSet(function.getBody());
        require(!original.contains(at(0x401025)), "fixture must contain a real orphan catch gap");
        var owner = currentProgram.getFunctionManager().getFunctionAt(at(0x401080));
        if (owner == null) { disassemble(at(0x401080)); owner = createFunction(at(0x401080), "rea_seh_rtl"); }
        owner.setName("unidentified_shared_handler", ghidra.program.model.symbol.SourceType.USER_DEFINED);
        var unverified = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(!function.getBody().contains(at(0x401025)), "unrelated bytes after a normal JMP were absorbed");
        require(!unverified.get(function.getEntryPoint()).omissions().isEmpty(), "unverified continuation omission lost");
        owner.setName("_HandleAnyException", ghidra.program.model.symbol.SourceType.USER_DEFINED);
        disassemble(at(0x401090));
        if (currentProgram.getFunctionManager().getFunctionAt(at(0x401090)) == null)
            createFunction(at(0x401090), "rea_seh_message");
        disassemble(at(0x4010a0));
        var negative = createFunction(at(0x4010a0), "rea_seh_nonzero");
        // The independently owned RTL lies inside the numeric span, but is
        // not a member of the protected function's disjoint AddressSet.
        var disjoint = new AddressSet(function.getBody());
        disjoint.add(at(0x4010e0));
        function.setBody(disjoint);
        clearListing(at(0x401020), at(0x401024));
        require(currentProgram.getListing().getInstructionAt(at(0x401020)) == null, "entry must begin undecoded");
        String signature = function.getPrototypeString(false, true);
        var observations = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(observations.containsKey(function.getEntryPoint()), "registration not observed");
        require(observations.get(function.getEntryPoint()).omissions().isEmpty(), observations.toString());
        require(function.getBody().contains(at(0x401025)), "catch body not recovered");
        require(function.getBody().contains(at(0x40102a)), "catch call not recovered");
        require(!function.getBody().contains(at(0x401080)), "shared RTL stolen");
        require(observations.get(function.getEntryPoint()).diagnostics().stream().anyMatch(
            text -> text.contains("supplied/imported Borland RTL symbol")), "newly decoded veneer provenance lost");
        require(signature.equals(function.getPrototypeString(false, true)), "signature changed");
        require(!observations.containsKey(at(0x4010a0)), "nonzero FS offset misidentified");
        function.setBody(original);
        verifyInstructionPaths(function, original);
        var immutable = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, false);
        require(!immutable.get(function.getEntryPoint()).omissions().isEmpty(), "read-only omission lost");
        require(!function.getBody().contains(at(0x401025)), "read-only body mutated");
        var independent = createFunction(at(0x401020), "rea_seh_independent");
        require(independent != null, "independent owner fixture unavailable");
        var conflict = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(!conflict.get(function.getEntryPoint()).omissions().isEmpty(), "owner conflict omitted");
        require(currentProgram.getFunctionManager().getFunctionContaining(at(0x401020)).equals(independent), "independent owner changed");
        verifyBudget();
        println("REA_BORLAND_SEH_PROBE_PASSED");
    }

    private void verifyInstructionPaths(ghidra.program.model.listing.Function function, AddressSet original) throws Exception {
        var memory = currentProgram.getMemory();
        byte[] saved = getBytes(at(0x401025), 15);
        byte[] registered = getBytes(at(0x401007), 4);
        clearListing(at(0x401006), at(0x40100a));
        memory.setBytes(at(0x401007), new byte[] {4, 0x10, 0x40, 0});
        var registration = new AddressSet(at(0x401006), at(0x40100a));
        var decodeRegistration = new ghidra.app.cmd.disassemble.DisassembleCommand(registration, registration, false);
        decodeRegistration.enableCodeAnalysis(false);
        decodeRegistration.applyTo(currentProgram, monitor);
        var midEntry = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(midEntry.get(function.getEntryPoint()).omissions().stream().anyMatch(text ->
            text.contains("instruction boundary")), "mid-instruction registered entry was claimed included");
        clearListing(at(0x401006), at(0x40100a));
        memory.setBytes(at(0x401007), registered);
        decodeRegistration.applyTo(currentProgram, monitor);
        byte[][] cases = {
            // Conditional path decodes MOV first; the other path enters its immediate.
            {(byte)0x75, 5, (byte)0xeb, 4, (byte)0x90, (byte)0x90, (byte)0x90,
                (byte)0xb8, (byte)0x90, (byte)0xe8, 0, 0, (byte)0xeb, 0x1d, (byte)0x90},
            // Jump into the original XOR EAX,EAX immediate/second byte.
            {(byte)0xeb, (byte)0xdd}
        };
        for (byte[] code : cases) {
            function.setBody(original);
            clearListing(at(0x401025), at(0x401033));
            memory.setBytes(at(0x401025), code);
            var result = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
            require(result.get(function.getEntryPoint()).omissions().stream().anyMatch(
                text -> text.contains("instruction boundary")), "overlapping path was claimed complete");
            require(function.getBody().equals(original), "overlapping path published a partial body");
        }
        clearListing(at(0x401025), at(0x401033));
        memory.setBytes(at(0x401025), new byte[] {(byte)0xe8, 0x66, 0, 0, 0});
        var terminal = currentProgram.getFunctionManager().getFunctionAt(at(0x401090));
        terminal.setNoReturn(true);
        var extent = new AddressSet(at(0x401025), at(0x401029));
        var command = new ghidra.app.cmd.disassemble.DisassembleCommand(new AddressSet(at(0x401025)), extent, false);
        command.enableCodeAnalysis(false);
        command.applyTo(currentProgram, monitor);
        currentProgram.getListing().getInstructionAt(at(0x401025)).setFlowOverride(
            ghidra.program.model.listing.FlowOverride.CALL_RETURN);
        var result = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(result.get(function.getEntryPoint()).omissions().isEmpty(), "decoded terminal call was rejected");
        require(function.getBody().contains(at(0x401029)), "terminal call was not owned");
        require(!function.getBody().contains(at(0x40102a)), "terminal fallthrough was invented");
        require(result.get(function.getEntryPoint()).diagnostics().stream().anyMatch(
            text -> text.contains("static flow model")), "terminal static caveat lost");
        function.setBody(original);
        terminal.setNoReturn(false);
        clearListing(at(0x401025), at(0x401033));
        memory.setBytes(at(0x401025), saved);
    }

    private void verifyBudget() throws Exception {
        Address start = at(0x500000);
        var memory = currentProgram.getMemory();
        var block = memory.createInitializedBlock("rea_budget", start, 0x20000, (byte) 0x90, monitor, false);
        block.setExecute(true);
        // Registration jumps around the large unowned NOP gap to an owned RET.
        byte[] registration = new byte[] {0x55, (byte)0x8b, (byte)0xec, 0x31, (byte)0xc0, 0x55,
            0x68, 0x20, 0, 0x50, 0, 0x64, (byte)0xff, 0x30, 0x64, (byte)0x89, 0x20,
            (byte)0xe9, (byte)0xda, (byte)0xff, 1, 0};
        memory.setBytes(start, registration);
        memory.setByte(at(0x51fff0), (byte)0xc3);
        var displacement = java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            .putInt((int)(0x401080L - 0x500025L)).array();
        memory.setByte(at(0x500020), (byte)0xe9);
        memory.setBytes(at(0x500021), displacement);
        // Decode only the registration and tail, preserving an undecoded gap.
        var body = new AddressSet(start, at(0x500015));
        body.add(at(0x51fff0));
        var command = new ghidra.app.cmd.disassemble.DisassembleCommand(body, body, false);
        command.enableCodeAnalysis(false);
        command.applyTo(currentProgram, monitor);
        var function = currentProgram.getFunctionManager().createFunction("rea_budget", start, body,
            ghidra.program.model.symbol.SourceType.USER_DEFINED);
        var before = new AddressSet(function.getBody());
        var result = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(result.get(start).omissions().stream().anyMatch(text -> text.contains("resource budget exhausted")),
            "large gap must retain a budget omission");
        require(function.getBody().equals(before), "budget exhaustion published a partial body");
    }
}
