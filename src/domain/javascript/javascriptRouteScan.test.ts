import { expect, it } from "vitest";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps as complete,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { JavaScriptRouteScan } from "./javascriptRouteScan.js";
import {
  nextAppRoutePath,
  nextScriptBasePath,
  routePath,
} from "./javascriptRoutePaths.js";

const analyze = (source: string, budget?: number) => {
  const file = parseJavaScriptSource(source);
  if (file === null) throw new Error("fixture must parse");
  const index = complete(
    indexJavaScriptBindingsWithReceiversSteps(file.program),
  );
  complete(index.indexAmbientWritesSteps());
  const scan = new JavaScriptRouteScan(undefined, budget);
  traverseJavaScriptAst(file, {
    enter: (node, parent) => {
      scan.inspect(node, parent);
    },
  });
  return complete(scan.finishSteps(index));
};

it("joins router children and preserves each segment's source", () => {
  const facts = analyze(
    `createBrowserRouter([{path:'/reports',children:[{path:':id?',children:[{path:'settings'}]}]}]);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/:id?",
    "/reports/:id?/settings",
  ]);
  expect(facts.candidates[2]!.segments.map(({ value }) => value)).toEqual([
    "/reports",
    ":id?",
    "settings",
  ]);
  expect(facts.candidates[2]!.derivation).toBe("joined");
  expect(facts.unresolved).toEqual([]);
});
it("uses typed literal segments and marks property-name fallbacks inferred", () => {
  const facts = analyze(
    `const ROUTES=defineRoutes({reports:{_$:'reports',settings:{_$:'settings'},history:{}}});`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/settings",
    "/reports/history",
  ]);
  expect(facts.candidates[2]).toMatchObject({
    confidence: "low",
    derivation: "inferred",
  });
  expect(facts.candidates[2]!.segments[1]!.origin).toBe("property-name");
});
it("joins missing typed ancestor segments within a selected route-builder root", () => {
  const facts = analyze(`defineRoutes({reports:{settings:{_$:'settings'}}});`);
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/settings",
  ]);
  expect(facts.candidates[0]!.derivation).toBe("inferred");
  expect(facts.unresolved).toHaveLength(0);
});
it("does not reinterpret a typed descendant as a root after its parent was unresolved", () => {
  const facts = analyze(
    `defineRoutes({reports:{_$:prefix,settings:{_$:'settings'}}});`,
  );
  expect(facts.candidates).toEqual([]);
  expect(facts.unresolved).toHaveLength(1);
});
it("resolves stable route bindings without conflating shadowed variables", () => {
  const facts = analyze(
    `const routes=[{path:'/outer'}]; function f(){const routes=[{path:'/inner'}];useRoutes(routes)} createBrowserRouter(routes);`,
  );
  expect(facts.candidates.map(({ path }) => path).sort()).toEqual([
    "/inner",
    "/outer",
  ]);
});
it("does not turn dynamic parents or changed arrays into exact whole paths", () => {
  const dynamic = analyze(
    `createBrowserRouter([{path:prefix,children:[{path:'settings'}]}]);`,
  );
  expect(dynamic.candidates).toEqual([]);
  expect(dynamic.unresolved).toHaveLength(1);
  const mutated = analyze(
    `const routes=[{path:'/before'}];routes[0].path='/after';useRoutes(routes);`,
  );
  expect(mutated.candidates).toEqual([]);
  expect(mutated.unresolved).toHaveLength(1);
});
it("keeps repeated route objects under different parents", () => {
  const facts = analyze(
    `const shared={path:'settings'};createBrowserRouter([{path:'/a',children:[shared]},{path:'/b',children:[shared]}]);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/a",
    "/a/settings",
    "/b",
    "/b/settings",
  ]);
});
it("infers minified router configurations from view and children syntax", () => {
  const facts = analyze(
    `a([{path:'/reports',element:View,children:[{path:'settings',element:Settings}]}]);`,
  );
  expect(
    facts.candidates
      .filter(({ mechanism }) => mechanism === "nested-route-object")
      .map(({ path }) => path),
  ).toEqual(["/reports", "/reports/settings"]);
  expect(
    facts.candidates.every(({ derivation }) => derivation === "inferred"),
  ).toBe(true);
  expect(facts.unresolved).toHaveLength(1);
});
it("retains trailing slashes and optional route-pattern markers", () => {
  const facts = analyze(
    `createBrowserRouter([{path:'/reports/',children:[{path:':id?/'}]}]);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/reports/",
    "/reports/:id?/",
  ]);
});
it("bounds aliased route expansion before allocating unbounded full paths", () => {
  const routes = Array.from(
    { length: 30 },
    (_, index) => `{path:'/r${index}',children:[shared]}`,
  ).join(",");
  const source = `const shared={path:'settings'};createBrowserRouter([${routes}]);`;
  const facts = analyze(source, 4096);
  expect(facts.capacity).toMatchObject({
    kind: "route-work-or-facts",
    limit_bytes: 4096,
  });
  expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(4096);
  expect(facts.candidates.length).toBeLessThan(60);
});
it("preserves only fields established after an unknown spread", () => {
  const overwritten = analyze(
    `createBrowserRouter([{path:'/before',...unknown,children:[{path:'settings'}]}]);`,
  );
  expect(overwritten.candidates).toEqual([]);
  expect(overwritten.unresolved).toHaveLength(1);
  const restored = analyze(
    `createBrowserRouter([{...unknown,path:'/after',children:[{path:'settings'}]}]);`,
  );
  expect(restored.candidates.map(({ path }) => path)).toEqual([
    "/after",
    "/after/settings",
  ]);
  expect(restored.unresolved).toHaveLength(1);
});
it("keeps a getter-backed parent unknown without treating unrelated loader methods as route gaps", () => {
  const getter = analyze(
    `createBrowserRouter([{get path(){return '/dynamic'},children:[{path:'settings'}]}]);`,
  );
  expect(getter.candidates).toEqual([]);
  expect(getter.unresolved).toHaveLength(1);
  const loader = analyze(
    `createBrowserRouter([{path:'/reports',loader(){return fetch('/api/reports')}}]);`,
  );
  expect(loader.candidates.map(({ path }) => path)).toEqual(["/reports"]);
  expect(loader.unresolved).toEqual([]);
});
it("excludes generic config paths and SVG data while retaining navigation candidates", () => {
  const facts = analyze(
    `const v={path:'/state/items/0',d:'M16.0123 18.7087H0V34',route:'contact_email'};router.push('/reports?tab=recent');`,
  );
  expect(
    facts.candidates
      .filter(({ mechanism }) => mechanism !== "route-string-constant")
      .map(({ path }) => path),
  ).toEqual(["/reports"]);
  expect(
    facts.candidates.some(({ path }) => path.includes("state/items")),
  ).toBe(false);
});
it.each([
  ["/_next/static/chunks/app/page-123.js", "/"],
  ["https://example.test/app/_next/static/chunks/app/page.tsx", "/"],
  [
    "https://example.test/app/_next/static/chunks/app/reports/page.js",
    "/reports",
  ],
  [
    "https://example.test/app/_next/static/chunks/pages/reports/page.js",
    undefined,
  ],
  ["app/app/page.tsx", "/app"],
  ["static/chunks/app/(account)/reports/[id]/page-deadbeef.js", "/reports/:id"],
  ["app/docs/[...slug]/page.js", "/docs/:slug+"],
  ["app/(account)/reports/[id]/page.tsx", "/reports/:id"],
  ["app/reports/page.ts", "/reports"],
  ["app/docs/[[...slug]]/page", "/docs/:slug*"],
  ["app/@modal/(.)photo/[id]/page.js", undefined],
  ["/assets/app.js", undefined],
] as const)(
  "interprets Next App Router path %s without claiming reachability",
  (value, expected) => {
    expect(nextAppRoutePath(value)).toBe(expected);
  },
);
it("distinguishes route-pattern markers, navigation query strings and Next asset bases", () => {
  expect(routePath("/reports/:id?")).toBe("/reports/:id?");
  expect(routePath("/reports?tab=recent#summary", { navigation: true })).toBe(
    "/reports",
  );
  expect(
    nextScriptBasePath("https://example.test/app/_next/static/chunks/1.js"),
  ).toBe("/app");
  expect(
    nextScriptBasePath("https://example.test/_next/static/chunks/1.js"),
  ).toBe("");
});

it("keeps rejected mutated configurations owned instead of reviving stale automatic roots", () => {
  for (const code of [
    `const routes=[{path:'/before',element:View}];routes[0].path='/after';useRoutes(routes);`,
    `const routes=[{path:'/before',element:View}];const alias=routes;alias[0].path='/after';useRoutes(routes);`,
    `let routes=[{path:'/before',element:View}];routes=[{path:'/after',element:View}];useRoutes(routes);`,
  ]) {
    const facts = analyze(code);
    expect(facts.candidates).toEqual([]);
    expect(facts.unresolved.length).toBeGreaterThan(0);
  }
});
it("does not turn ordinary wrapper objects into route ancestry", () => {
  const standard = analyze(
    `const config={routes:[{path:'/reports',component:Reports}]};x(config);`,
  );
  expect(standard.candidates.map((row) => row.path)).toEqual(["/reports"]);
  const typed = analyze(
    `const config={ui:{routes:{reports:{_$:'reports',settings:{_$:'settings'}}}}};x(config);`,
  );
  expect(typed.candidates.map((row) => row.path)).toEqual([
    "/reports",
    "/reports/settings",
  ]);
  expect(typed.unresolved).toHaveLength(1);
});
it("leaves missing unbound typed ancestors unknown instead of inventing container segments", () => {
  const facts = analyze(
    `const config={reports:{settings:{_$:'settings'}}};x(config);`,
  );
  expect(facts.candidates.map((row) => row.path)).toEqual(["/settings"]);
  expect(facts.candidates[0]!.derivation).toBe("inferred");
  expect(facts.unresolved).toHaveLength(1);
});

it("keeps dynamic route and navigation fragments out of independent literal candidates", () => {
  const facts = analyze(`
    createBrowserRouter([{path:'/users'}, {path:'/users/' + id}]);
    router.push('/users/' + id);
    router.replace(ready ? '/users/ready' : '/users/pending');
    router.navigate(\`/users/\${id}\`);
    route('/users/registered/' + id);
    const link = {href: '/users/link/' + id};
    const typed = defineRoutes({entry: {_$: '/users/typed/' + id}});
    const independent = '/users/settings';
    values.push(value);
  `);
  expect([...new Set(facts.candidates.map(({ path }) => path))].sort()).toEqual(
    ["/users", "/users/settings"],
  );
  expect(
    facts.unresolved.filter(
      ({ mechanism }) => mechanism === "navigation-target",
    ),
  ).toHaveLength(4);
  expect(
    facts.unresolved.some(({ mechanism }) => mechanism === "router-call"),
  ).toBe(true);
  expect(
    facts.unresolved.some(
      ({ mechanism }) => mechanism === "nested-route-object",
    ),
  ).toBe(true);
  expect(
    facts.unresolved.some(({ mechanism }) => mechanism === "typed-route-tree"),
  ).toBe(true);
});

it.each([
  `const secondary=[{path:'/reports',element:Reports}];createBrowserRouter([{path:'/shell',element:jsx(Panel,{routes:secondary})}]);`,
  `createBrowserRouter([{path:'/shell',element:jsx(Panel,{routes:[{path:'/reports',element:Reports}]})}]);`,
])(
  "keeps independent component route tables outside configuration ownership: %s",
  (code) => {
    const facts = analyze(code);
    expect(
      [...new Set(facts.candidates.map(({ path }) => path))].sort(),
    ).toEqual(["/reports", "/shell"]);
    expect(
      facts.unresolved.some(({ reason }) =>
        reason.includes("without a bound route-builder"),
      ),
    ).toBe(true);
  },
);

it("does not let push registrations own independent module bodies or structured data", () => {
  const facts = analyze(`
    globalThis.TURBOPACK=[];
    globalThis.TURBOPACK.push([123, function module(){
      const paths=['/docs/a','/docs/b'];router.push('/docs');
    }]);
    router.push(build(function callback(){ const route = '/docs/c'; }));
  `);
  expect([...new Set(facts.candidates.map(({ path }) => path))].sort()).toEqual(
    ["/docs", "/docs/a", "/docs/b", "/docs/c"],
  );
  expect(facts.unresolved).toEqual([]);
});
