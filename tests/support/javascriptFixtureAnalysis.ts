import { parseJavaScriptSource } from "../../src/domain/javascript/javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "../../src/domain/javascript/javascriptStaticAnalysis.js";
import { analyzeParsedJavaScriptSemantics } from "../../src/domain/javascript/javascriptSemanticAnalysis.js";

/** Inert mixed-syntax fixtures select wrapper authority explicitly, not from ESM syntax. */
export const parseCommonJsFixture = (source: string) => {
  const file = parseJavaScriptSource(source, "fixture.cts");
  if (file === null) throw new Error("Expected parsed CommonJS fixture");
  return file;
};

export const analyzeCommonJsStaticFixture = (source: string) =>
  analyzeParsedJavaScriptStaticSource(source, parseCommonJsFixture(source));

export const analyzeCommonJsSemanticFixture = (source: string) =>
  analyzeParsedJavaScriptSemantics(parseCommonJsFixture(source));
