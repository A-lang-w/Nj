const read = "require('fs').readFileSync('result');";

export const opaqueMutatorCases = [
  ...[
    "let r={};const saved=r;eval('r=module');Reflect.set(module,'require',replacement,saved);",
    "let r={};Reflect.set(module,'require',replacement,r);eval('r=module');",
    "const r={};eval('void 0');Reflect.set(module,'require',replacement,r);",
    "let r={};const set=Reflect.set.bind(null,module,'require',replacement,r);eval('r=module');set();",
    "let key='x';const saved=key;eval('key=\"require\"');Reflect.set(module,saved,replacement);",
    "let key='x';Reflect.set(module,key,replacement);eval('key=\"require\"');",
    "const key='x';eval('void 0');Reflect.set(module,key,replacement);",
    "let key='x';const set=Reflect.set.bind(null,module,key,replacement);eval('key=\"require\"');set();",
  ].map((body) => ({ source: body + read, kept: true })),
  ...[
    ...[
      "{}",
      "[]",
      "()=>0",
      "class{}",
      "/x/",
      "new (class{})()",
      "Object.create(null)",
    ].map(
      (initial) =>
        `let r=${initial};eval('r=module');Reflect.set(module,'require',replacement,r);`,
    ),
    "let r={};eval('r=module');const alias=r;Reflect.set(module,'require',replacement,alias);",
    "let C=function(){};eval('C=function(){return module}');Reflect.set(module,'require',replacement,new C());",
    "let key='x';eval('key=\"require\"');Reflect.set(module,key,replacement);",
    "let key='x';eval('key=\"require\"');Object.defineProperty(module,key,{value:replacement});",
    "let key='x';eval('key=\"require\"');Reflect.defineProperty(module,key,{value:replacement});",
    "let key='x';eval('key=\"require\"');Reflect.set.call(null,module,key,replacement);",
    "let key='x';eval('key=\"require\"');Reflect.set.apply(null,[module,key,replacement]);",
    "let key='x';eval('key=\"require\"');const set=Reflect.set.bind(null,module,key,replacement);set();",
  ].map((body) => ({ source: body + read, kept: false })),
  ...["1", "'text'", "void 0", "{}", "{x:1}"].map((value) => ({
    source: `async function run(){Object.assign=(t,v)=>{if(v!=null)v.require=replacement};Object.assign({},await (${value}));${read}}run();`,
    kept: true,
  })),
  ...[
    "module",
    "Promise.resolve(module)",
    "{then(resolve){resolve(module)}}",
  ].map((value) => ({
    source: `async function run(){Object.assign=(t,v)=>{v.require=replacement};Object.assign({},await (${value}));${read}}run();`,
    kept: false,
  })),
  ...["1", "module"].map((value) => ({
    source: `function* run(){Object.assign=(t,v)=>{v.require=replacement};Object.assign({},yield ${value});${read}}const iterator=run();iterator.next();iterator.next(module);`,
    kept: false,
  })),
];
