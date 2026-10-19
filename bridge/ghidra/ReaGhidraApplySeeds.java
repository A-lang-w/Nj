import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRangeImpl;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.SourceType;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

/**
 * Apply caller-declared analysis seeds before default auto-analysis, or
 * reconcile exact function bodies after analysis when passed {@code reconcile}.
 *
 * The single argument is REA's canonical seed snapshot: one
 * {@code 0x<hex>\t(function|code|label)[\tname]} line per ordinary seed, an
 * exact {@code entry\tfunction_body\tstart-end[,start-end...][\tname]} seed,
 * or {@code source\tcomputed_target\ttarget\t(call|jump)}.
 * Exact bodies are applied before inferred functions, then code and labels. The
 * outcome is stored as a program property that the bridge reports during its handshake.
 */
public final class ReaGhidraApplySeeds extends GhidraScript {
    static final String REPORT_OPTION = "REA analysis seeds";

    private record Seed(
        Address address,
        String kind,
        String name,
        AddressSet body,
        Address target,
        String transferKind
    ) {}

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1 || args.length > 2 ||
            (args.length == 2 && !args[1].equals("reconcile"))) {
            throw new IllegalArgumentException(
                "REA seed script requires one seed file and optional reconcile mode"
            );
        }
        boolean reconcile = args.length == 2;
        Path path = Path.of(args[0]);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("REA seed file is not a regular file");
        }
        byte[] bytes = Files.readAllBytes(path);
        String sha256 = HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(bytes)
        );
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        List<Seed> seeds = new ArrayList<>();
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            if (line.isEmpty()) continue;
            String[] fields = line.split("\t", -1);
            if (fields.length < 2 || fields.length > 4 || !fields[0].startsWith("0x")) {
                throw new IllegalArgumentException("REA seed snapshot is malformed");
            }
            Address address;
            try {
                address = space.getAddress(Long.parseUnsignedLong(fields[0].substring(2), 16));
            } catch (ghidra.program.model.address.AddressOutOfBoundsException e) {
                address = null;
            }
            String kind = fields[1];
            AddressSet body = null;
            String name = null;
            Address target = null;
            String transferKind = null;
            if (kind.equals("function_body")) {
                if (fields.length < 3) {
                    throw new IllegalArgumentException("REA function_body seed has no ranges");
                }
                body = new AddressSet();
                for (String range : fields[2].split(",")) {
                    String[] bounds = range.split("-", -1);
                    if (bounds.length != 2 || !bounds[0].startsWith("0x") || !bounds[1].startsWith("0x")) {
                        throw new IllegalArgumentException("REA function_body range is malformed");
                    }
                    Address start = space.getAddress(Long.parseUnsignedLong(bounds[0].substring(2), 16));
                    Address end = space.getAddress(Long.parseUnsignedLong(bounds[1].substring(2), 16));
                    body.add(new AddressRangeImpl(start, end));
                }
                name = fields.length == 4 ? fields[3] : null;
            } else if (kind.equals("computed_target")) {
                if (fields.length != 4 || !fields[2].startsWith("0x") ||
                    !(fields[3].equals("call") || fields[3].equals("jump"))) {
                    throw new IllegalArgumentException("REA computed_target seed is malformed");
                }
                try {
                    target = space.getAddress(Long.parseUnsignedLong(fields[2].substring(2), 16));
                } catch (ghidra.program.model.address.AddressOutOfBoundsException e) {
                    target = null;
                }
                transferKind = fields[3];
            } else {
                if (fields.length > 3) {
                    throw new IllegalArgumentException("REA ordinary seed has too many fields");
                }
                name = fields.length == 3 ? fields[2] : null;
            }
            seeds.add(new Seed(address, kind, name, body, target, transferKind));
        }

        // Highest address first: a function body computed before analysis stops at
        // an existing function entry, so later creations cannot swallow earlier ones.
        seeds.sort((left, right) -> {
            if (left.address() == null) return right.address() == null ? 0 : 1;
            if (right.address() == null) return -1;
            return right.address().compareTo(left.address());
        });
        int unmapped = 0;
        int logged = 0;
        int codeDecoded = 0, codeFailed = 0;
        int functionCreated = 0, functionExisting = 0, functionFailed = 0;
        int functionBodyCreated = 0, functionBodyExisting = 0;
        int functionBodyUpdated = 0, functionBodyFailed = 0;
        int functionBodyConflictsRemoved = 0;
        int labelApplied = 0, labelFailed = 0;
        int computedTargetApplied = 0, computedTargetExisting = 0, computedTargetFailed = 0;
        Set<Address> declaredFunctionEntries = new HashSet<>();
        for (Seed seed : seeds) {
            if (seed.address() != null &&
                (seed.kind().equals("function") || seed.kind().equals("function_body"))) {
                declaredFunctionEntries.add(seed.address());
            }
        }
        for (String pass : new String[] {
            "function_body", "function", "code", "computed_target", "label"
        }) {
            for (Seed seed : seeds) {
                if (!seed.kind().equals(pass)) continue;
                monitor.checkCancelled();
                MemoryBlock block = seed.address() == null
                    ? null
                    : currentProgram.getMemory().getBlock(seed.address());
                MemoryBlock targetBlock = seed.target() == null
                    ? null
                    : currentProgram.getMemory().getBlock(seed.target());
                if (block == null || (!pass.equals("label") && !block.isInitialized()) ||
                    (pass.equals("computed_target") &&
                        (targetBlock == null || !targetBlock.isInitialized()))) {
                    unmapped++;
                    continue;
                }
                switch (pass) {
                    case "code" -> {
                        if (decoded(seed.address())) codeDecoded++;
                        else {
                            codeFailed++;
                            if (logged++ < 20) println("REA seed failed: code " + seed.address() + " " + why(seed.address()));
                        }
                    }
                    case "function_body" -> {
                        try {
                            if (reconcile) {
                                List<Address> conflicts = new ArrayList<>();
                                var overlapping = currentProgram.getFunctionManager().getFunctions(
                                    seed.body(), true
                                );
                                while (overlapping.hasNext()) {
                                    Address entry = overlapping.next().getEntryPoint();
                                    if (!entry.equals(seed.address()) &&
                                        !declaredFunctionEntries.contains(entry)) {
                                        conflicts.add(entry);
                                    }
                                }
                                for (Address entry : conflicts) {
                                    if (currentProgram.getFunctionManager().removeFunction(entry)) {
                                        functionBodyConflictsRemoved++;
                                    }
                                }
                            }
                            Function existing = getFunctionAt(seed.address());
                            if (existing == null) {
                                if (decoded(seed.address()) && currentProgram.getFunctionManager().createFunction(
                                    seed.name(), seed.address(), seed.body(), SourceType.USER_DEFINED
                                ) != null) {
                                    functionBodyCreated++;
                                } else {
                                    functionBodyFailed++;
                                    if (logged++ < 20) println("REA seed failed: function_body " + seed.address() + " " + why(seed.address()));
                                }
                            } else {
                                if (seed.name() != null) {
                                    existing.setName(seed.name(), SourceType.USER_DEFINED);
                                }
                                if (new AddressSet(existing.getBody()).equals(seed.body())) {
                                    functionBodyExisting++;
                                } else {
                                    existing.setBody(seed.body());
                                    functionBodyUpdated++;
                                }
                            }
                        } catch (Exception e) {
                            functionBodyFailed++;
                            if (logged++ < 20) println("REA seed failed: function_body " + seed.address() + " " + e.getMessage());
                        }
                    }
                    case "function" -> {
                        Function existing = getFunctionAt(seed.address());
                        if (existing != null) {
                            functionExisting++;
                            if (seed.name() != null) {
                                existing.setName(seed.name(), SourceType.USER_DEFINED);
                            }
                        } else if (decoded(seed.address()) &&
                            createFunction(seed.address(), seed.name()) != null) {
                            functionCreated++;
                        } else {
                            functionFailed++;
                            if (logged++ < 20) println("REA seed failed: function " + seed.address() + " " + why(seed.address()));
                        }
                    }
                    case "computed_target" -> {
                        try {
                            if (!decoded(seed.address())) {
                                computedTargetFailed++;
                                if (logged++ < 20) println(
                                    "REA seed failed: computed_target " + seed.address() + " " +
                                    why(seed.address())
                                );
                                break;
                            }
                            RefType type = seed.transferKind().equals("call")
                                ? RefType.COMPUTED_CALL
                                : RefType.COMPUTED_JUMP;
                            boolean existing = false;
                            for (Reference reference :
                                    currentProgram.getReferenceManager().getReferencesFrom(seed.address())) {
                                if (reference.getToAddress().equals(seed.target()) &&
                                    reference.getReferenceType().equals(type)) {
                                    existing = true;
                                    break;
                                }
                            }
                            if (existing) computedTargetExisting++;
                            else {
                                currentProgram.getReferenceManager().addMemoryReference(
                                    seed.address(), seed.target(), type, SourceType.USER_DEFINED, 0
                                );
                                computedTargetApplied++;
                            }
                        } catch (Exception e) {
                            computedTargetFailed++;
                            if (logged++ < 20) println(
                                "REA seed failed: computed_target " + seed.address() + " " +
                                e.getMessage()
                            );
                        }
                    }
                    default -> {
                        try {
                            createLabel(seed.address(), seed.name(), true, SourceType.USER_DEFINED);
                            labelApplied++;
                        } catch (Exception e) {
                            labelFailed++;
                        }
                    }
                }
            }
        }
        String report = "{\"format\":\"rea-ghidra-seeds-v2\",\"sha256\":\"" + sha256 + "\"" +
            ",\"phase\":\"" + (reconcile ? "post_analysis_reconcile" : "pre_analysis") + "\"" +
            ",\"entries\":" + seeds.size() +
            ",\"function_created\":" + functionCreated +
            ",\"function_existing\":" + functionExisting +
            ",\"function_failed\":" + functionFailed +
            ",\"function_body_created\":" + functionBodyCreated +
            ",\"function_body_existing\":" + functionBodyExisting +
            ",\"function_body_updated\":" + functionBodyUpdated +
            ",\"function_body_failed\":" + functionBodyFailed +
            ",\"function_body_conflicts_removed\":" + functionBodyConflictsRemoved +
            ",\"code_decoded\":" + codeDecoded +
            ",\"code_failed\":" + codeFailed +
            ",\"label_applied\":" + labelApplied +
            ",\"label_failed\":" + labelFailed +
            ",\"computed_target_applied\":" + computedTargetApplied +
            ",\"computed_target_existing\":" + computedTargetExisting +
            ",\"computed_target_failed\":" + computedTargetFailed +
            ",\"unmapped\":" + unmapped + "}";
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_OPTION, report);
        println("REA seeds applied: " + report);
    }

    private String why(Address address) {
        if (getDataAt(address) != null) return "defined data " + getDataAt(address).getDataType().getName();
        var containing = getInstructionContaining(address);
        if (containing != null && !containing.getAddress().equals(address))
            return "inside instruction at " + containing.getAddress();
        Function owner = getFunctionContaining(address);
        if (owner != null) return "inside function " + owner.getEntryPoint();
        return getInstructionAt(address) == null ? "undecodable" : "function creation refused";
    }

    /** Decode one instruction flow at an address, keeping an existing decode. */
    private boolean decoded(Address address) {
        if (getInstructionAt(address) != null) return true;
        if (getDataAt(address) != null || getInstructionContaining(address) != null) {
            return false;
        }
        disassemble(address);
        return getInstructionAt(address) != null;
    }
}
