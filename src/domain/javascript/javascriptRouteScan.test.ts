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
it.each([
  ["defineRoutes({reports:({_$:'reports'} as const)});", ["/reports"]],
  [
    "defineRoutes({reports:{_$:'reports',detail:({_$:'detail'} as const)}});",
    ["/reports", "/reports/detail"],
  ],
  [
    "const detail={_$:'detail'};defineRoutes({reports:{_$:'reports',detail:(detail as typeof detail)}});",
    ["/reports", "/reports/detail"],
  ],
] as const)(
  "resolves typed children through erased wrappers: %s",
  (source, paths) => {
    const facts = analyze(source);
    expect(facts.candidates.map(({ path }) => path)).toEqual(paths);
    expect(facts.unresolved).toEqual([]);
  },
);
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
it("invalidates fields before unknown computed keys while preserving exact empty keys", () => {
  const unknown = analyze(
    `createBrowserRouter([{path:'/before',[key]:'/after',children:[{path:'settings'}]}]);`,
  );
  expect(unknown.candidates).toEqual([]);
  expect(unknown.unresolved.length).toBeGreaterThan(0);
  const child = analyze(
    `createBrowserRouter([{path:'/before',[key]:{path:'/stale',element:View}}]);`,
  );
  expect(child.candidates).toEqual([]);
  expect(child.unresolved.length).toBeGreaterThan(0);
  const exact = analyze(
    `createBrowserRouter([{path:'/before',['']:true,children:[{path:'settings'}]}]);`,
  );
  expect(exact.candidates.map(({ path }) => path)).toEqual([
    "/before",
    "/before/settings",
  ]);
  expect(exact.unresolved).toEqual([]);
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
  ["app/reports/page-helpers.js", undefined],
  ["app/reports/page-deadbeef.js", undefined],
  ["https://example.test/app/reports/page-helpers.js", undefined],
  ["app/_components/page.tsx", undefined],
  ["app/blog/_draft/page.js", undefined],
  ["app/(group)/_private/nested/page.tsx", undefined],
  ["app/%5Fcomponents/page.tsx", "/_components"],
  ["app/blog/%5fdraft/page.js", "/blog/_draft"],
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
  expect(facts.unresolved).toEqual([
    expect.objectContaining({ mechanism: "navigation-target" }),
  ]);
});

it("retains dynamic destinations of recognized navigation calls without treating collection writes as navigation", () => {
  const facts = analyze(
    `router.navigate(target);router.push(path);history.replace(destination.href);const link={href:target};items.push(value);values.replace(value);`,
  );
  expect(facts.candidates).toEqual([]);
  expect(facts.unresolved).toHaveLength(4);
  expect(
    facts.unresolved.every(
      ({ mechanism }) => mechanism === "navigation-target",
    ),
  ).toBe(true);
});

it("retains pathless grouping nodes in ordinary inferred route ancestry", () => {
  const facts = analyze(
    `const routes=[{path:'/a',children:[{children:[{path:'b',element:B}]}]}];unknown(routes);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual(["/a", "/a/b"]);
});
it("preserves inferred ancestry through stable child arrays and object aliases", () => {
  const facts = analyze(
    `const child={path:'b',element:B};const children=[child];const alias=children;const routes=[{path:'/a',children:alias}];unknown(routes);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual(["/a", "/a/b"]);
});
it("indexes only effective children when a shared child's former parent was overwritten", () => {
  for (const overwritten of [
    "children:[]",
    "get children(){return []}",
    "...unknown",
  ]) {
    const facts = analyze(
      `const child={path:'b',element:B};const routes=[{path:'/old',children:[child],${overwritten}},{path:'/new',children:[child]}];unknown(routes);`,
    );
    expect(facts.candidates.map(({ path }) => path)).toEqual([
      "/new",
      "/new/b",
    ]);
  }
});
it("keeps ambiguous or cyclic inferred ancestry unknown instead of shortening paths", () => {
  for (const code of [
    `const child={path:'b',element:B};const routes=[{path:'/a',children:[child]},{path:'/c',children:[child]}];unknown(routes);`,
    `const route={path:'b',element:B,children:[route]};unknown(route);`,
    `const child={path:'b',element:B};const children=[child];children[0].path='changed';const routes=[{path:'/a',children}];unknown(routes);`,
  ]) {
    const facts = analyze(code);
    expect(facts.candidates).toEqual([]);
    expect(facts.unresolved.length).toBeGreaterThan(0);
  }
});
it("does not attach an independent typed tree to ordinary children ancestry", () => {
  const facts = analyze(
    `const wrapper={children:[{_$:'typed',detail:{_$:'detail'}}]};unknown(wrapper);`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual([
    "/typed",
    "/typed/detail",
  ]);
  const ordinary = analyze(
    `const typed={_$:'typed',children:[{path:'/foreign',element:F}]};unknown(typed);`,
  );
  expect(ordinary.candidates.map(({ path }) => path).sort()).toEqual([
    "/foreign",
    "/typed",
  ]);
});

it("retains mixed ordinary and typed siblings independently of scan order and builder selection", () => {
  for (const children of [
    "{path:'/x',element:X},{_$:'typed'}",
    "{_$:'typed'},{path:'/x',element:X}",
  ]) {
    for (const consumer of ["unknown", "createBrowserRouter"]) {
      const facts = analyze(
        `const config={children:[${children}]};${consumer}(config);`,
      );
      expect(facts.candidates.map(({ path }) => path).sort()).toEqual([
        "/typed",
        "/x",
      ]);
      expect(
        facts.candidates.find(({ path }) => path === "/typed")?.mechanism,
      ).toBe("typed-route-tree");
    }
  }
});

it("withholds rejected mixed configuration data from every automatic interpretation", () => {
  for (const children of [
    "{path:'/x',element:X},{_$:'before',detail:{_$:'detail'}}",
    "{_$:'before',detail:{_$:'detail'}},{path:'/x',element:X}",
  ]) {
    for (const mutation of [
      "config.children[0].path='/after'",
      "const alias=config;alias.children[1]._$='after'",
      "config={children:[{_$:'replacement'}]}",
    ]) {
      const facts = analyze(
        `let config={children:[${children}]};${mutation};createBrowserRouter(config);`,
      );
      expect(facts.candidates).toEqual([]);
      expect(facts.unresolved.length).toBeGreaterThan(0);
    }
  }
});

it("does not recycle route-field initializers or writes as independent Next constants", () => {
  const facts = analyze(
    `globalThis.TURBOPACK=[];createBrowserRouter([{path:'/reports'}]);const mixed={children:[{path:'/reports/stale-ordinary',element:View},{_$:'/reports/stale-typed'}]};mixed.children[1]._$='/reports/changed';createBrowserRouter(mixed);const independent='/reports/help';`,
  );
  expect([...new Set(facts.candidates.map(({ path }) => path))]).toEqual([
    "/reports",
    "/reports/help",
  ]);
});

it("owns structured navigation fragments without leaking partial destinations", () => {
  const facts = analyze(
    `createBrowserRouter([{path:'/users'}]);router.push({pathname:'/users/' + id});router.navigate(['/users/',id]);router.push({path:suffix + ['/users/',id]});`,
  );
  expect([...new Set(facts.candidates.map(({ path }) => path))]).toEqual([
    "/users",
  ]);
  expect(
    facts.unresolved.filter(
      ({ mechanism }) => mechanism === "navigation-target",
    ),
  ).toHaveLength(3);
});
it("extracts effective local pathname literals while owning nested navigation data", () => {
  const facts = analyze(
    `globalThis.TURBOPACK=[];router.push({pathname:'/users',query:{href:'/not-a-route'}});router.replace({pathname:'/old',pathname:'/new'});router.push({pathname:'../edit'});router.push({pathname:'/users/' + id});`,
  );
  expect(facts.candidates.map(({ path }) => path)).toEqual(["/users", "/new"]);
  expect(facts.unresolved).toHaveLength(2);
  expect(facts.candidates[0]!.segments[0]).toMatchObject({
    value: "/users",
    origin: "literal",
  });
});
it("keeps navigation object authorities and unknown fields unresolved", () => {
  const facts = analyze(
    `router.push({pathname:'/users',host:'example.test'});router.push({pathname:'/users',protocol:'https:'});router.push({pathname:'/users',href:'/other'});router.push({...options,pathname:'/users'});router.push({get pathname(){return '/users'}});router.push({pathname:'//example.test/users'});router.push({pathname:'https://example.test/users'});`,
  );
  expect(facts.candidates).toEqual([]);
  expect(facts.unresolved).toHaveLength(7);
});
it("does not promote concatenation or template fragments into independent path or module constants", () => {
  const facts = analyze(
    `globalThis.TURBOPACK=[];createBrowserRouter([{path:'/users'}]);const computed='/users/' + id;items.push({pathname:'/users/fragment/' + id});const exact='/users/settings';const file='app/admin/page.js' + suffix;`,
  );
  expect([...new Set(facts.candidates.map(({ path }) => path))].sort()).toEqual(
    ["/users", "/users/settings"],
  );
  expect(facts.unresolved.map(({ mechanism }) => mechanism)).toEqual([
    "next-app-chunk",
  ]);
});
it("retains computed-expression ownership through erased TypeScript wrappers", () => {
  const facts = analyze(
    "globalThis.TURBOPACK=[];route('/users');const file=(('app/admin/page.js' as string)!) + suffix;const partial=(('/users/' as const) satisfies string) + id;const template=`prefix${('/users/' as string)}`;const exact=('app/reports/page.js' as const);const independent='/users/settings';",
  );
  expect([...new Set(facts.candidates.map(({ path }) => path))].sort()).toEqual(
    ["/reports", "/users", "/users/settings"],
  );
  expect(
    facts.unresolved.some(({ mechanism }) => mechanism === "next-app-chunk"),
  ).toBe(true);
});
it("retains relative navigation uncertainty and excludes known external URL literals", () => {
  const facts = analyze(
    `navigate('settings');router.push('../edit');const link={href:'#details'};items.push('value');text.replace('../not-navigation','x');router.push('https://elsewhere.test/users');const external={href:'mailto:a@example.test'};`,
  );
  expect(facts.candidates).toEqual([]);
  expect(facts.unresolved).toHaveLength(3);
  expect(
    facts.unresolved.every(
      ({ mechanism }) => mechanism === "navigation-target",
    ),
  ).toBe(true);
});

it.each([
  "router.addRoute('admin',{path:'settings',component:View});",
  "const child={path:'settings',component:View};router.addRoute('admin',child);",
  "router.addRoute('admin',({path:'settings',component:View} as const));",
] as const)("keeps named-parent addRoute ancestry unresolved: %s", (source) => {
  const facts = analyze(source);
  expect(facts.candidates).toEqual([]);
  expect(facts.unresolved.some(({ reason }) => reason.includes("parent"))).toBe(
    true,
  );
});
it.each([
  "router.push(({pathname:'/users'} as const));",
  "router.push(({pathname:'/users'} satisfies {pathname:string}));",
  "router.push(('/users' as const));",
] as const)("reads navigation through erased wrappers: %s", (source) => {
  const facts = analyze(source);
  expect(
    facts.candidates
      .filter(({ mechanism }) => mechanism === "navigation-target")
      .map(({ path }) => path),
  ).toEqual(["/users"]);
  expect(facts.unresolved).toEqual([]);
});

it("preserves literal route registration with an independent handler", () => {
  const facts = analyze(
    "router.addRoute('/ordinary',()=>render());router.route('/legacy',handler);",
  );
  expect(
    facts.candidates
      .filter(({ mechanism }) => mechanism === "router-call")
      .map(({ path }) => path),
  ).toEqual(["/legacy", "/ordinary"]);
  expect(facts.unresolved).toEqual([]);
});
