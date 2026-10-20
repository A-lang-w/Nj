export const callableScalarPropertyCases = [
  ...[
    "const label=function named(){};",
    "const label=(a,b)=>0;",
    "function label(a=0){}",
    "class label{}",
  ].flatMap((setup) =>
    ["label.name", "label.length", "label.name.length"].map(
      (value) =>
        `${setup}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});`,
    ),
  ),
  "const label=function named(){};const alias=label;Object.assign=(t,key)=>{t[key]=1};Object.assign({},alias.name);",
  "const label=function named(){};const {name:display}=label;Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=function named(){};const display=label.name;Object.defineProperty(label,'name',{value:module});Object.assign=(t,key)=>{t[key]=1};Object.assign({},display);",
  "const label=function named(){};Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);Object.defineProperty(label,'name',{value:module});",
  "class Base{static name=module}class label extends Base{}Object.assign=(t,key)=>{t[key]=1};Object.assign({},label.name);",
  ...[
    "class label{static unrelated=1}",
    "class label{static unrelated(){return module}}",
    "class label{static get unrelated(){return module}}",
  ].flatMap((setup) =>
    ["label.name", "label.length"].map(
      (value) =>
        `${setup}Object.assign=(t,key)=>{t[key]=1};Object.assign({},${value});`,
    ),
  ),
];

// Replaced bind targets have no complete argument-capture contract. Retain
// that existing uncertainty rather than infer a native bind from its spelling.
export const opaqueBoundCallablePropertyCase =
  "const label=function named(){};Object.assign=(t,key)=>{t[key]=1};const assign=Object.assign.bind(null,{},label.name);Object.defineProperty(label,'name',{value:module});assign();";

export const callableReferencePropertyCases = [
  ...["name", "length"].map(
    (key) =>
      `const label=function named(){};Object.defineProperty(label,'${key}',{value:module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.${key});`,
  ),
  "const label=function named(){};const alias=label;Object.defineProperty(alias,'name',{value:module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=function named(){};Object.defineProperty(label,'name',{get:()=>module});Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static name=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static length=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.length);",
  "class label{static get name(){return module}}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static name(){return module}}Object.assign=(t,get)=>{get().require=replacement};Object.assign({},label.name);",
  "const key='name';class label{static [key]=module}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "class label{static{Object.defineProperty(this,'name',{value:module})}}Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.name);",
  "const label=function named(){};label.owner=module;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.owner);",
  "const label=function named(){};label.prototype.owner=module;Object.assign=(t,v)=>{v.require=replacement};Object.assign({},label.prototype.owner);",
];
