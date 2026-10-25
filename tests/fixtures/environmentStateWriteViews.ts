import type { TimedCaptureRow } from "./analysisView.js";
import { bookClock } from "./environmentStateWrites.js";

const tag = (id: number, name: string, slug: string, created: string) => ({
  id,
  slug,
  name,
  document_count: id === 1 ? 2 : 0,
  created,
});

const SEED_TAGS = [
  tag(1, "Lamp Oil", "lamp-oil", "2026-10-01T09:00:00Z"),
  tag(2, "Tide Tables", "tide-tables", "2026-10-01T10:00:00Z"),
];

/** A tag as a create answers it: without the document count reads show, and with its clock to the nanosecond. */
const answered = (id: number, name: string, slug: string, at: number) => ({
  id,
  slug,
  name,
  created: bookClock(at).replace("Z", ".123456789Z"),
});

/** Two tag creates whose answers lack the document count, and spell the clock otherwise, than the item read after each. */
export const READ_BACK_TAG_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/tags", SEED_TAGS],
  ["GET", "/api/tags/1", SEED_TAGS[0]!],
  ["GET", "/api/tags/2", SEED_TAGS[1]!],
  [
    "POST",
    "/api/tags",
    answered(3, "Harbour Notices", "harbour-notices", 3),
    201,
    { name: "Harbour Notices" },
  ],
  [
    "GET",
    "/api/tags/3",
    tag(3, "Harbour Notices", "harbour-notices", bookClock(3)),
  ],
  [
    "GET",
    "/api/tags",
    [...SEED_TAGS, tag(3, "Harbour Notices", "harbour-notices", bookClock(3))],
  ],
  [
    "POST",
    "/api/tags",
    answered(4, "Quarry Notes", "quarry-notes", 6),
    201,
    { name: "Quarry Notes" },
  ],
  ["GET", "/api/tags/4", tag(4, "Quarry Notes", "quarry-notes", bookClock(6))],
  [
    "GET",
    "/api/tags",
    [
      ...SEED_TAGS,
      tag(3, "Harbour Notices", "harbour-notices", bookClock(3)),
      tag(4, "Quarry Notes", "quarry-notes", bookClock(6)),
    ],
  ],
];

const label = (id: number, title: string, posts: number) => ({
  id,
  title,
  count: { posts },
});

/** Two label creates whose answers lack the post count only the list shows; no item read follows them. */
export const LISTED_LABEL_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/labels", [label(1, "Ferry", 3), label(2, "Pier", 1)]],
  [
    "POST",
    "/api/labels",
    { id: 3, title: "Mooring" },
    201,
    { title: "Mooring" },
  ],
  [
    "GET",
    "/api/labels",
    [label(1, "Ferry", 3), label(2, "Pier", 1), label(3, "Mooring", 0)],
  ],
  ["POST", "/api/labels", { id: 4, title: "Buoy" }, 201, { title: "Buoy" }],
  [
    "GET",
    "/api/labels",
    [
      label(1, "Ferry", 3),
      label(2, "Pier", 1),
      label(3, "Mooring", 0),
      label(4, "Buoy", 0),
    ],
  ],
];

/** Two renames that send the tag whole, its old slug included, which the application slugs anew from the name. */
export const STALE_SLUG_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/tags", SEED_TAGS],
  ["GET", "/api/tags/1", SEED_TAGS[0]!],
  ["GET", "/api/tags/2", SEED_TAGS[1]!],
  [
    "PUT",
    "/api/tags/1",
    {
      ...SEED_TAGS[0]!,
      name: "Lamp Oil Deliveries",
      slug: "lamp-oil-deliveries",
    },
    200,
    { ...SEED_TAGS[0]!, name: "Lamp Oil Deliveries" },
  ],
  [
    "GET",
    "/api/tags/1",
    {
      ...SEED_TAGS[0]!,
      name: "Lamp Oil Deliveries",
      slug: "lamp-oil-deliveries",
    },
  ],
  [
    "PUT",
    "/api/tags/2",
    {
      ...SEED_TAGS[1]!,
      name: "Spring Tide Tables",
      slug: "spring-tide-tables",
    },
    200,
    { ...SEED_TAGS[1]!, name: "Spring Tide Tables" },
  ],
  [
    "GET",
    "/api/tags/2",
    {
      ...SEED_TAGS[1]!,
      name: "Spring Tide Tables",
      slug: "spring-tide-tables",
    },
  ],
  [
    "GET",
    "/api/tags",
    [
      {
        ...SEED_TAGS[0]!,
        name: "Lamp Oil Deliveries",
        slug: "lamp-oil-deliveries",
      },
      {
        ...SEED_TAGS[1]!,
        name: "Spring Tide Tables",
        slug: "spring-tide-tables",
      },
    ],
  ],
];

const POST = {
  id: 1,
  title: "Winter rota",
  updated_at: "2026-10-01T09:00:00Z",
};

/** Two edits that send back the modification time they read, which the application stamps anew. */
export const RESTAMPED_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/posts", [POST]],
  ["GET", "/api/posts/1", POST],
  [
    "PUT",
    "/api/posts/1",
    { ...POST, title: "Winter rota v2", updated_at: bookClock(2) },
    200,
    { ...POST, title: "Winter rota v2" },
  ],
  [
    "GET",
    "/api/posts/1",
    { ...POST, title: "Winter rota v2", updated_at: bookClock(2) },
  ],
  [
    "PUT",
    "/api/posts/1",
    { ...POST, title: "Winter rota v3", updated_at: bookClock(4) },
    200,
    { ...POST, title: "Winter rota v3", updated_at: bookClock(2) },
  ],
  [
    "GET",
    "/api/posts/1",
    { ...POST, title: "Winter rota v3", updated_at: bookClock(4) },
  ],
  [
    "GET",
    "/api/posts",
    [{ ...POST, title: "Winter rota v3", updated_at: bookClock(4) }],
  ],
];
