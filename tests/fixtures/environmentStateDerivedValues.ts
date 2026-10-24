import type { JsonValue } from "../../src/domain/jsonValue.js";
import type { TimedCaptureRow } from "./analysisView.js";
import { bookClock, numberedUuid } from "./environmentStateWrites.js";

type Entity = { [field: string]: JsonValue };

/** The instant `seconds` after the first exchange with nanosecond digits, trailing zeros trimmed as Go spells them. */
export const goClock = (seconds: number, nanos: string): string =>
  bookClock(seconds).replace("Z", `.${nanos}`.replace(/\.?0+$/u, "") + "Z");

const tag = (n: number, name: string, created: string, updated: string) => ({
  id: numberedUuid(n),
  name,
  createdAt: created,
  updatedAt: updated,
});

const FIRST_TAG = tag(
  1,
  "Fragile",
  "2026-10-01T09:00:00.123456789Z",
  "2026-10-01T09:00:00.123456791Z",
);
const SECOND_TAG = tag(
  2,
  "Outdoor",
  "2026-10-01T10:00:00.223456789Z",
  "2026-10-01T10:00:00.223456791Z",
);
/** The first created tag's clocks show nine digits; the second's update clock ends in a zero Go drops. */
const HEAVY_TAG = tag(
  3,
  "Heavy",
  goClock(3, "374763655"),
  goClock(3, "374763767"),
);
const BORROWED_TAG = tag(
  4,
  "Borrowed",
  goClock(5, "388122047"),
  goClock(5, "388122180"),
);

/** Two tag creates whose clocks Go spells with trailing fraction zeros trimmed, confirmed by later reads. */
export const TAG_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/tags", [FIRST_TAG, SECOND_TAG]],
  ["GET", `/api/tags/${numberedUuid(1)}`, FIRST_TAG],
  ["GET", `/api/tags/${numberedUuid(2)}`, SECOND_TAG],
  ["POST", "/api/tags", HEAVY_TAG, 201, { name: "Heavy" }],
  ["GET", `/api/tags/${numberedUuid(3)}`, HEAVY_TAG],
  ["POST", "/api/tags", BORROWED_TAG, 201, { name: "Borrowed" }],
  ["GET", `/api/tags/${numberedUuid(4)}`, BORROWED_TAG],
  ["GET", "/api/tags", [FIRST_TAG, SECOND_TAG, HEAVY_TAG, BORROWED_TAG]],
];

/** A clock's UTC date and time digits, as the Wayback Machine names a snapshot. */
const archiveDigits = (clock: string): string =>
  clock.replace(/\D/gu, "").slice(0, 14);

/** A bookmark whose snapshot address names its creation time and its URL. */
export const bookmark = (
  id: number,
  url: string,
  title: string,
  added: string,
): Entity => ({
  id,
  url,
  title,
  web_archive_snapshot_url: `https://web.archive.org/web/${archiveDigits(added)}/${url}`,
  date_added: added,
  date_modified: added,
});

const FIRST_BOOKMARK = bookmark(
  1,
  "https://ferries.example.test/timetable",
  "Ferry timetable",
  "2026-10-01T09:00:00Z",
);
const SECOND_BOOKMARK = bookmark(
  2,
  "https://harbour.example.test/tides",
  "Harbour tides",
  "2026-10-01T10:00:00Z",
);
const THIRD_BOOKMARK = bookmark(
  3,
  "https://quarry.example.test/ledger",
  "Quarry ledger",
  bookClock(3),
);
const FOURTH_BOOKMARK = bookmark(
  4,
  "https://kitchen.example.test/menus",
  "Kitchen menus",
  bookClock(5),
);

/** Two bookmark creates whose snapshot addresses the application composes, confirmed by later reads. */
export const BOOKMARK_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/bookmarks", [FIRST_BOOKMARK, SECOND_BOOKMARK]],
  ["GET", "/api/bookmarks/1", FIRST_BOOKMARK],
  ["GET", "/api/bookmarks/2", SECOND_BOOKMARK],
  [
    "POST",
    "/api/bookmarks",
    THIRD_BOOKMARK,
    201,
    { url: "https://quarry.example.test/ledger", title: "Quarry ledger" },
  ],
  ["GET", "/api/bookmarks/3", THIRD_BOOKMARK],
  [
    "POST",
    "/api/bookmarks",
    FOURTH_BOOKMARK,
    201,
    { url: "https://kitchen.example.test/menus", title: "Kitchen menus" },
  ],
  ["GET", "/api/bookmarks/4", FOURTH_BOOKMARK],
  [
    "GET",
    "/api/bookmarks",
    [FIRST_BOOKMARK, SECOND_BOOKMARK, THIRD_BOOKMARK, FOURTH_BOOKMARK],
  ],
];

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");

/** A folder named by the uid its creator chose, with an address from that uid and its title, and a time-based numeric id. */
export const folder = (
  uid: string,
  title: string,
  id: number,
  created: string,
  updated = created,
): Entity => ({
  id,
  uid,
  title,
  url: `/dashboards/f/${uid}/${slugOf(title)}`,
  created,
  updated,
});

const SEED_FOLDER = folder(
  numberedUuid(101),
  "Lighthouse Rota",
  1655476044521472,
  "2026-10-01T09:00:00Z",
);
const ALPHA = folder(
  numberedUuid(102),
  "Scratch Alpha Harbor",
  1656166527623168,
  bookClock(2),
);
const BRAVO = folder(
  numberedUuid(103),
  "Scratch Bravo Meadow",
  1656166745726976,
  bookClock(4),
);
/** The first created folder after the recorded rename at exchange 6. */
const RENAMED_ALPHA = folder(
  numberedUuid(102),
  "Renamed Alpha Lantern",
  1656166527623168,
  bookClock(2),
  bookClock(6),
);

/** Two folder creates and a rename, whose addresses follow uid and title, confirmed by later reads. */
export const FOLDER_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/folders", [SEED_FOLDER]],
  ["GET", `/api/folders/${numberedUuid(101)}`, SEED_FOLDER],
  [
    "POST",
    "/api/folders",
    ALPHA,
    200,
    { uid: numberedUuid(102), title: "Scratch Alpha Harbor" },
  ],
  ["GET", `/api/folders/${numberedUuid(102)}`, ALPHA],
  [
    "POST",
    "/api/folders",
    BRAVO,
    200,
    { uid: numberedUuid(103), title: "Scratch Bravo Meadow" },
  ],
  ["GET", `/api/folders/${numberedUuid(103)}`, BRAVO],
  [
    "PUT",
    `/api/folders/${numberedUuid(102)}`,
    RENAMED_ALPHA,
    200,
    { title: "Renamed Alpha Lantern" },
  ],
  ["GET", `/api/folders/${numberedUuid(102)}`, RENAMED_ALPHA],
  ["GET", "/api/folders", [SEED_FOLDER, RENAMED_ALPHA, BRAVO]],
];

const RENAMED_FIRST_TAG = {
  ...FIRST_TAG,
  name: "Fragile glass",
  updatedAt: goClock(3, "512345679"),
};
const RENAMED_SECOND_TAG = {
  ...SECOND_TAG,
  name: "Outdoor gear",
  updatedAt: goClock(5, "612345680"),
};

/** Two tag renames whose update clocks Go spells with nine and then eight fraction digits. */
export const TAG_UPDATE_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/tags", [FIRST_TAG, SECOND_TAG]],
  ["GET", `/api/tags/${numberedUuid(1)}`, FIRST_TAG],
  ["GET", `/api/tags/${numberedUuid(2)}`, SECOND_TAG],
  [
    "PATCH",
    `/api/tags/${numberedUuid(1)}`,
    RENAMED_FIRST_TAG,
    200,
    { name: "Fragile glass" },
  ],
  ["GET", `/api/tags/${numberedUuid(1)}`, RENAMED_FIRST_TAG],
  [
    "PATCH",
    `/api/tags/${numberedUuid(2)}`,
    RENAMED_SECOND_TAG,
    200,
    { name: "Outdoor gear" },
  ],
  ["GET", `/api/tags/${numberedUuid(2)}`, RENAMED_SECOND_TAG],
];

/** A book shelved as the application shelves it, on `general` when the call names no shelf. */
const shelved = (
  id: number,
  name: string,
  shelf: string,
  at: string,
): Entity => ({
  id,
  name,
  shelf,
  created_at: at,
});

const SHELVED_SEEDS = [
  shelved(1, "First Book", "general", "2026-10-01T09:00:00Z"),
  shelved(2, "Second Book", "general", "2026-10-01T10:00:00Z"),
];

/** Two book creates, one naming a shelf and one leaving it out, in the order given, each read back. */
export const shelvedRows = (
  first: { readonly name: string; readonly shelf?: string },
  second: { readonly name: string; readonly shelf?: string },
  stored: (sent: string) => string = (sent) => sent,
): TimedCaptureRow[] => {
  const third = shelved(
    3,
    first.name,
    first.shelf === undefined ? "general" : stored(first.shelf),
    bookClock(3),
  );
  const fourth = shelved(
    4,
    second.name,
    second.shelf === undefined ? "general" : stored(second.shelf),
    bookClock(5),
  );
  return [
    ["GET", "/api/books", SHELVED_SEEDS],
    ["GET", "/api/books/1", SHELVED_SEEDS[0]!],
    ["GET", "/api/books/2", SHELVED_SEEDS[1]!],
    ["POST", "/api/books", third, 201, first],
    ["GET", "/api/books/3", third],
    ["POST", "/api/books", fourth, 201, second],
    ["GET", "/api/books/4", fourth],
    ["GET", "/api/books", [...SHELVED_SEEDS, third, fourth]],
  ];
};
