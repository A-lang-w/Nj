import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOK_INIT_ROWS,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  book,
  bookClock,
  environmentStateViewOf,
  renamedBook,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { environmentStateViewRequestSchema } from "./environmentStateView.js";

type StateView = ReturnType<typeof environmentStateViewOf>;

/** Rows of consecutive recording sessions, and the ordinals where each later one starts. */
const sessions = (...parts: readonly (readonly TimedCaptureRow[])[]) => {
  const starts: number[] = [];
  let ordinal = 0;
  for (const part of parts.slice(0, -1)) {
    ordinal += part.length;
    starts.push(ordinal);
  }
  return { rows: parts.flat(), starts };
};

/** The state of a capture read as its sessions, or as one session when `asOne`. */
const stateOf = (
  capture: ReturnType<typeof sessions>,
  asOne = false,
): StateView =>
  environmentStateViewOf(
    timedCaptureEvidence(capture.rows),
    [],
    asOne ? undefined : capture.starts,
  );

const planOf = (state: StateView, tool: string) => {
  const plan = state.writes.find((candidate) => candidate.tool === tool);
  if (plan === undefined) throw new Error(`No write plan for ${tool}`);
  return plan;
};

const viewOf = (state: StateView, tool: string) =>
  state.views.find((view) => view.tool === tool);

const CREATE: TimedCaptureRow = [
  "POST",
  "/api/books",
  THIRD_BOOK,
  201,
  { name: "Third Book" },
];

/** A create no later read shows, then the same create after a reset, read back and listed. */
const CREATED_TWICE = sessions(
  [...BOOK_INIT_ROWS, CREATE],
  [
    ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
    [
      "POST",
      "/api/books",
      book(3, "Third Book", bookClock(5)),
      201,
      {
        name: "Third Book",
      },
    ],
    ["GET", "/api/books/3", book(3, "Third Book", bookClock(5))],
    [
      "GET",
      "/api/books",
      [FIRST_BOOK, SECOND_BOOK, book(3, "Third Book", bookClock(5))],
    ],
  ],
);

describe("recording sessions' writes", () => {
  it("replays each session's writes from the initial state, so a create repeated after a reset is confirmed", () => {
    const state = stateOf(CREATED_TWICE);
    expect(planOf(state, "post_books")).toMatchObject({
      served: true,
      reason: null,
      exemplar_ordinal: 3,
      checked_record_ordinals: [6, 7],
    });
    // Read as one session, the second session's list follows the first create and contradicts it.
    expect(planOf(stateOf(CREATED_TWICE, true), "post_books")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
  });

  it("withholds a write that one session contradicts and another confirms", () => {
    const renamed = renamedBook(FIRST_BOOK, "Renamed Book", 3);
    const confirmed: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["PATCH", "/api/books/1", renamed, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", renamed],
    ];
    const capture = sessions(confirmed, [
      ["GET", "/api/books/1", FIRST_BOOK],
      [
        "PATCH",
        "/api/books/1",
        renamedBook(FIRST_BOOK, "Renamed Book", 6),
        200,
        { name: "Renamed Book" },
      ],
      ["GET", "/api/books/1", FIRST_BOOK],
    ]);
    expect(planOf(stateOf(capture), "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 7,
    });
    expect(
      planOf(stateOf(sessions(confirmed)), "patch_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });
});

describe("recording sessions' initial state", () => {
  it("takes each session's reads before its own first related write as the initial state", () => {
    const capture = sessions(
      [["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]], CREATE],
      [
        ["GET", "/api/books/2", SECOND_BOOK],
        ["GET", "/api/books/1", FIRST_BOOK],
      ],
    );
    const state = stateOf(capture);
    expect(viewOf(state, "get_books_by_id")).toMatchObject({
      shape: "item",
      checked_record_ordinals: [2, 3],
    });
    expect(state.types).toEqual([
      expect.objectContaining({
        collection_template: "/api/books",
        init_before_ordinal: 1,
        volatile_fields: [],
      }),
    ]);
    expect(state.limitations).toContain(
      "The capture is read as 2 recording sessions; each is taken to start from the same application state, which the state does not establish.",
    );
    // As one session, the item reads follow the create and show no initial state.
    expect(viewOf(stateOf(capture, true), "get_books_by_id")).toEqual({
      tool: "get_books_by_id",
      shape: "recorded",
      reason: "no-init-recording",
    });
  });

  it("treats a value the sessions' initial reads disagree on as volatile, unless the later session wrote first", () => {
    const touched = { ...FIRST_BOOK, updated_at: bookClock(1) };
    const quiet = sessions(
      [["GET", "/api/books/1", FIRST_BOOK]],
      [["GET", "/api/books/1", touched]],
    );
    expect(stateOf(quiet).types[0]).toMatchObject({
      volatile_fields: ["updated_at"],
    });
    const written = sessions(
      [["GET", "/api/books/1", FIRST_BOOK]],
      [
        ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
        ["GET", "/api/books/1", touched],
      ],
    );
    expect(viewOf(stateOf(written), "get_books_by_id")).toEqual({
      tool: "get_books_by_id",
      shape: "recorded",
      reason: "fields-differ",
    });
  });
});

describe("recording session order", () => {
  it("keeps each session together when sessions overlap in time", () => {
    // Session two's exchanges start between session one's, a second after each.
    const at = (seconds: number) =>
      new Date(Date.parse("2026-10-17T18:00:00.000Z") + seconds * 1000);
    const exchange = (
      [method, path, body, status = 200, sent]: TimedCaptureRow,
      seconds: number,
    ) => ({
      startedDateTime: at(seconds).toISOString(),
      time: 5,
      request: {
        method,
        url: `http://app.example${path}`,
        ...(sent === undefined
          ? {}
          : {
              postData: {
                mimeType: "application/json",
                text: JSON.stringify(sent),
              },
            }),
      },
      response: {
        status,
        content: { mimeType: "application/json", text: JSON.stringify(body) },
      },
    });
    const third = (seconds: number) =>
      book(3, "Third Book", at(seconds).toISOString().replace(".000Z", "Z"));
    const session: (seconds: number) => TimedCaptureRow[] = (seconds) => [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["POST", "/api/books", third(seconds + 2), 201, { name: "Third Book" }],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK, third(seconds + 2)]],
    ];
    const capture = analysisViewCaptureEvidence(
      environmentManifestCaptureFixture([
        ...session(0).map((row, index) => exchange(row, index * 2)),
        ...session(1).map((row, index) => exchange(row, index * 2 + 1)),
      ]),
    );
    const state = environmentStateViewOf(capture, [], [3]);
    expect(planOf(state, "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [2, 5],
    });
  });

  it("accepts strictly ascending positive ordinals only", () => {
    const parse = (session_starts: unknown) =>
      environmentStateViewRequestSchema.safeParse({
        kind: "environment-state",
        session_starts,
      }).success;
    expect(parse([3, 8])).toBe(true);
    expect(parse([])).toBe(true);
    expect(parse([0])).toBe(false);
    expect(parse([8, 3])).toBe(false);
    expect(parse([3, 3])).toBe(false);
    expect(parse([2.5])).toBe(false);
  });
});
