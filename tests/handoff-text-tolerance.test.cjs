"use strict";

// Source-only cases: the two pure matchers run in isolated VM contexts when
// this suite is explicitly invoked. No browser, worker startup or messages.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const root=path.join(__dirname,"..");
const handoffSource=fs.readFileSync(path.join(root,"handoff.js"),"utf8");
const contentSource=fs.readFileSync(path.join(root,"content.js"),"utf8").replace(/\r\n/g,"\n");
const plain=value=>JSON.parse(JSON.stringify(value));

function matchers() {
  const worker=vm.createContext({URL});
  vm.runInContext(handoffSource,worker);
  const backend=vm.runInContext("(expected, observed) => CQHandoff.textMatch(expected,observed)",worker);
  // The production frontend helper is intentionally standalone. Extracting
  // only this function keeps DOM initialization and queue execution disabled.
  const body=contentSource.match(/function handoffTextMatch\(expected,\s*observed\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(body,"Standalone frontend handoff matcher moved");
  const frontend=vm.runInNewContext(`(${body[0]})`);
  return {backend,frontend};
}

function compare(backend,frontend,expected,observed,matches,extraChars) {
  const result=plain(backend(expected,observed));
  assert.deepEqual(plain(frontend(expected,observed)),result,"Frontend and backend must use identical decisions");
  assert.equal(result.matches,matches);
  assert.equal(typeof result.extraChars,"number");
  assert.equal(typeof result.usedTolerance,"boolean");
  if(matches) {
    assert.equal(result.extraChars,extraChars);
    assert.equal(result.usedTolerance,extraChars>0);
  } else assert.equal(result.usedTolerance,false);
  assert.deepEqual(Object.keys(result).sort(),["extraChars","matches","usedTolerance"],
    "Matcher decisions must not expose either document");
  return result;
}

test("交接容差前后台一致：原文完整、只允许新增 0/3/100 字符，101 字符拒绝",()=>{
  const {backend,frontend}=matchers();
  const expected="任务主题：保持原文的目标、约束和下一步。";
  compare(backend,frontend,expected,expected,true,0);
  compare(backend,frontend,expected,expected+"XYZ",true,3);
  compare(backend,frontend,expected,"X".repeat(100)+expected,true,100);
  compare(backend,frontend,expected,expected+"X".repeat(101),false);
});

test("按 Unicode 字符计数，接受中间新增，空白规范化不占新增额度",()=>{
  const {backend,frontend}=matchers();
  compare(backend,frontend,"甲乙丙丁","甲XY乙🙂丙丁",true,3);
  compare(backend,frontend,"甲乙丙丁","🙂".repeat(100)+"甲乙丙丁",true,100);
  compare(backend,frontend,"甲乙丙丁","甲乙丙丁"+"🙂".repeat(101),false);
  compare(backend,frontend,"任务 A B"," \n任务\t A\r\n B \n",true,0);
  compare(backend,frontend,"甲🙂乙","甲X🙂Y乙",true,2);
});

test("缺字、替换、乱序和不同正文拒绝，不能仅凭总长度接近放行",()=>{
  const {backend,frontend}=matchers();
  for(const [expected,observed] of [
    ["甲乙丙丁","甲乙丁"],
    ["甲乙丙丁","甲乙X丁"],
    ["甲乙丙丁","丁丙乙甲"],
    ["ABCD","AXYD"],
    ["原任务目标","不同的正文"],
    ["甲乙丙丁","X".repeat(100)+"甲乙丁"],
    ["甲🙂乙","甲🙃乙"],
  ]) compare(backend,frontend,expected,observed,false);
});

test("空原文始终拒绝，不用容差把空任务绑定到任意正文",()=>{
  const {backend,frontend}=matchers();
  for(const [expected,observed] of [["",""],["","XYZ"],[" \n\t","甲乙"],[null,"甲乙"],[undefined,"甲乙"]]) {
    compare(backend,frontend,expected,observed,false);
  }
});
