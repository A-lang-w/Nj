import { describe, expect, it } from "vitest";

import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";
import type { TimedCaptureRow } from "../../../tests/fixtures/analysisView.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { servedCatalog } from "./environmentState.js";

const BULK_DELETE_ROWS: readonly TimedCaptureRow[] = [
  ...BOOK_INIT_ROWS,
  ["DELETE", "/api/books", [{ id: 2 }], 200, [{ id: 2 }]],
  ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
  ["GET", "/api/books", [FIRST_BOOK]],
];

/** A book with an `archived` flag, which an item action sets. */
const shelved = (entity: Book, archived: boolean) => ({ ...entity, archived });

describe("served bulk writes", () => {
  it("deletes every row a call names, answering one element per row", () => {
    const books = servedFrom(BULK_DELETE_ROWS);
    expect(
      books.answer("delete_books", { body: [{ id: 1 }, { id: 2 }] }),
    ).toMatchObject({
      status: 200,
      body: [{ id: 1 }, { id: 2 }],
      state: {
        source: "state",
        view: "delete",
        type: "/api/books",
        ids: ["1", "2"],
      },
    });
    expect(books.store.ofType("/api/books")).toEqual([]);
  });

  it("refuses a call naming a row the state does not hold, leaving the state unchanged", () => {
    const books = servedFrom(BULK_DELETE_ROWS);
    const before = books.snapshot();
    expect(
      books.refusal("delete_books", { body: [{ id: 1 }, { id: 9 }] }),
    ).toMatchObject({
      message: expect.stringContaining("holds no /api/books entity 9"),
    });
    expect(books.snapshot()).toBe(before);
  });

  it("advertises the body a bulk delete takes as the array its recording sent", () => {
    const books = servedFrom(BULK_DELETE_ROWS);
    const catalog = servedCatalog(books.source, books.state, "books");
    if (!catalog.ok) throw catalog.error;
    const tool = catalog.value.tools.find(
      (definition) => definition.name === "delete_books",
    );
    expect(tool?.inputSchema.properties["body"]).toMatchObject({
      type: "array",
      items: { type: "object" },
    });
  });
});

describe("served item actions", () => {
  it("sets what the action changed on the entity the path names", () => {
    const books = servedFrom([
      [
        "GET",
        "/api/books",
        [shelved(FIRST_BOOK, false), shelved(SECOND_BOOK, false)],
      ],
      ["GET", "/api/books/1", shelved(FIRST_BOOK, false)],
      ["GET", "/api/books/2", shelved(SECOND_BOOK, false)],
      ["POST", "/api/books/1/archive", shelved(FIRST_BOOK, true)],
      ["GET", "/api/books/1", shelved(FIRST_BOOK, true)],
      ["POST", "/api/books/1/archive", shelved(FIRST_BOOK, true)],
      ["GET", "/api/books/1", shelved(FIRST_BOOK, true)],
    ]);
    expect(books.answer("post_books_archive_by_id", { id: "2" })).toMatchObject(
      {
        status: 200,
        body: shelved(SECOND_BOOK, true),
        state: { source: "state", view: "update", id: "2" },
      },
    );
    expect(books.answer("get_books_by_id", { id: "2" })).toMatchObject({
      body: shelved(SECOND_BOOK, true),
      state: { source: "state" },
    });
  });
});
