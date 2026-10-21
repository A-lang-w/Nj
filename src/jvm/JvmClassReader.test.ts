import { describe, expect, it } from "vitest";
import { parseJvmClass, resolveJavaRelease } from "./JvmClassReader.js";

const createMockClassFile = (): Uint8Array => {
  const parts: Uint8Array[] = [];

  const u1 = (n: number) => parts.push(new Uint8Array([n & 0xff]));
  const u2 = (n: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, false);
    parts.push(b);
  };
  const u4 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    parts.push(b);
  };
  const utf8 = (str: string) => {
    const raw = new TextEncoder().encode(str);
    u1(1); // tag UTF8
    u2(raw.length);
    parts.push(raw);
  };
  const classRef = (nameIndex: number) => {
    u1(7); // tag Class
    u2(nameIndex);
  };

  // Header
  u4(0xcafebabe); // magic
  u2(0); // minor
  u2(61); // major (Java 17)

  // Constant pool count = 12 (entries 1 to 11)
  u2(12);
  utf8("com/example/UserService"); // 1
  classRef(1); // 2
  utf8("java/lang/Object"); // 3
  classRef(3); // 4
  utf8("userId"); // 5
  utf8("Ljava/lang/String;"); // 6
  utf8("getUserId"); // 7
  utf8("()Ljava/lang/String;"); // 8
  utf8("Code"); // 9
  utf8("SourceFile"); // 10
  utf8("UserService.java"); // 11

  // Class declaration
  u2(0x0021); // public super
  u2(2); // this_class = 2 ("com/example/UserService")
  u2(4); // super_class = 4 ("java/lang/Object")
  u2(0); // 0 interfaces

  // Fields (1 field: private userId)
  u2(1); // 1 field
  u2(0x0002); // private
  u2(5); // name: "userId"
  u2(6); // descriptor: "Ljava/lang/String;"
  u2(0); // 0 attributes

  // Methods (1 method: public getUserId() with Code attribute)
  u2(1); // 1 method
  u2(0x0001); // public
  u2(7); // name: "getUserId"
  u2(8); // descriptor: "()Ljava/lang/String;"
  u2(1); // 1 attribute
  u2(9); // attr name: "Code"
  u4(12); // attr length = 12
  u2(1); // max_stack
  u2(1); // max_locals
  u4(4); // code_length = 4 bytes
  parts.push(new Uint8Array([0x2a, 0xb4, 0x00, 0xb0])); // aload_0, getfield, return

  // Class attributes (SourceFile)
  u2(1); // 1 attribute
  u2(10); // attr name: "SourceFile"
  u4(2); // length = 2
  u2(11); // sourcefile index = 11 ("UserService.java")

  // Combine into single buffer
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
};

describe("JvmClassReader", () => {
  it("resolves standard Java releases from major class versions", () => {
    expect(resolveJavaRelease(52)).toBe("Java 8");
    expect(resolveJavaRelease(55)).toBe("Java 11");
    expect(resolveJavaRelease(61)).toBe("Java 17 (LTS)");
    expect(resolveJavaRelease(65)).toBe("Java 21 (LTS)");
  });

  it("rejects non-class files", () => {
    const invalid = new Uint8Array([1, 2, 3, 4]);
    expect(parseJvmClass(invalid)).toBeNull();
  });

  it("parses Java class declaration, version and superclass", () => {
    const classBytes = createMockClassFile();
    const report = parseJvmClass(classBytes);
    expect(report).not.toBeNull();
    expect(report?.majorVersion).toBe(61);
    expect(report?.javaVersion).toBe("Java 17 (LTS)");
    expect(report?.thisClass).toBe("com/example/UserService");
    expect(report?.superClass).toBe("java/lang/Object");
    expect(report?.accessFlags).toContain("public");
    expect(report?.accessFlags).toContain("super");
    expect(report?.sourceFile).toBe("UserService.java");
  });

  it("parses fields, methods, descriptors and code lengths", () => {
    const classBytes = createMockClassFile();
    const report = parseJvmClass(classBytes);
    expect(report).not.toBeNull();

    // Fields
    expect(report?.fields.length).toBe(1);
    expect(report?.fields[0]?.name).toBe("userId");
    expect(report?.fields[0]?.descriptor).toBe("Ljava/lang/String;");
    expect(report?.fields[0]?.accessFlags).toContain("private");

    // Methods
    expect(report?.methods.length).toBe(1);
    const method = report?.methods[0];
    expect(method?.name).toBe("getUserId");
    expect(method?.descriptor).toBe("()Ljava/lang/String;");
    expect(method?.accessFlags).toContain("public");
    expect(method?.codeLength).toBe(4);
  });
});
