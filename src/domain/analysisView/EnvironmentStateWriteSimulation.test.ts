import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  bookClock,
  environmentStateViewOf,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { ok } from "../result.js";
import { updatedFields } from "./environmentStateWriteApply.js";

/** The plan the gate gives `tool` over a capture of `rows`. */
const gated = (rows: readonly TimedCaptureRow[], tool: string) => {
  const { writes } = environmentStateViewOf(timedCaptureEvidence(rows));
  const plan = writes.find((candidate) => candidate.tool === tool);
  if (plan === undefined) throw new Error(`The gate planned no ${tool}`);
  return plan;
};

const RENAMED = renamedBook(FIRST_BOOK, "Renamed Book", 3);

describe("reads compared as the served environment answers them", () => {
  /** Item reads in a `{data, revision}` envelope, a rename, then a read recorded at `revision`. */
  const renamedInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
    ["GET", "/api/books/1", { data: FIRST_BOOK, revision: "r1" }],
    ["GET", "/api/books/2", { data: SECOND_BOOK, revision: "r1" }],
    ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", { data: RENAMED, revision }],
  ];

  it("contradicts a write when an item read's envelope differs from the one served", () => {
    expect(gated(renamedInEnvelope("r2"), "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(renamedInEnvelope("r1"), "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A list in a `{items, revision}` envelope, a create, then the list recorded at `revision`. */
  const createdInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", { items: [FIRST_BOOK, SECOND_BOOK], revision: "r1" }],
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
    [
      "GET",
      "/api/books",
      { items: [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK], revision },
    ],
  ];

  it("contradicts a write when a list's envelope differs from its served line", () => {
    expect(gated(createdInEnvelope("r2"), "post_books")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(createdInEnvelope("r1"), "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A filtered list of both books, a delete of the second, then the filtered list recorded with `listed`. */
  const deletedFromFiltered = (listed: readonly Book[]): TimedCaptureRow[] => [
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["GET", "/api/books?shelf=a", [FIRST_BOOK, SECOND_BOOK]],
    ["DELETE", "/api/books/2", "", 204],
    ["GET", "/api/books?shelf=a", [...listed]],
  ];

  it("contradicts a delete that a filtered list still shows, and confirms one it drops", () => {
    expect(
      gated(
        deletedFromFiltered([FIRST_BOOK, SECOND_BOOK]),
        "delete_books_by_id",
      ),
    ).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(
      gated(deletedFromFiltered([FIRST_BOOK]), "delete_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });
});

describe("update constants", () => {
  const paper = (entry: Book, format = "PAPER"): Book => ({ ...entry, format });
  const RENAMED_PAPER = paper(RENAMED);
  const HARDCOVER = paper(
    { ...SECOND_BOOK, updated_at: bookClock(5) },
    "HARDCOVER",
  );
  /** A rename that keeps the format, then a format change the application stores in capitals. */
  const ROWS: TimedCaptureRow[] = [
    ["GET", "/api/books", [paper(FIRST_BOOK), paper(SECOND_BOOK)]],
    ["GET", "/api/books/1", paper(FIRST_BOOK)],
    ["GET", "/api/books/2", paper(SECOND_BOOK)],
    ["PATCH", "/api/books/1", RENAMED_PAPER, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", RENAMED_PAPER],
    ["PATCH", "/api/books/2", HARDCOVER, 200, { format: "hardcover" }],
    ["GET", "/api/books/2", HARDCOVER],
  ];

  it("stores the value the call that showed a constant recorded, as serving applies the plan", () => {
    const plan = gated(ROWS, "patch_books_by_id");
    expect(plan).toMatchObject({
      served: true,
      observation: { ordinal: 3, pointer: "" },
      body: { fixed: [{ member: "format", sent: "hardcover" }] },
      checked_record_ordinals: [4, 6],
    });
    // Serving reads the plan's observation, the first update's answer, which still shows PAPER.
    const served = updatedFields(
      plan,
      { before: paper(SECOND_BOOK), observed: RENAMED_PAPER },
      {
        path: "/api/books/2",
        pathValues: new Map([["id", "2"]]),
        body: { format: "hardcover" },
        id: "2",
      },
      () => bookClock(9),
    );
    expect(served).toEqual(
      ok(paper({ ...SECOND_BOOK, updated_at: bookClock(9) }, "HARDCOVER")),
    );
  });
});

describe("write examples", () => {
  it("takes no modelled effect or exemplar from a redirected write", () => {
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", "", 302],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["DELETE", "/api/books/2", "", 204],
      ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ];
    expect(gated(rows, "delete_books_by_id")).toMatchObject({
      served: true,
      exemplar_ordinal: 5,
      checked_record_ordinals: [6],
      contradicted_by: null,
    });
  });
});
