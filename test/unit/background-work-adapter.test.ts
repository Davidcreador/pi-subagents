import assert from "node:assert/strict";
import test from "node:test";
import { executeDetachableSubagent } from "../../src/extension/background-work-adapter.ts";

function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }

for (const [name, params] of [
 ["single", {agent:"worker"}],
 ["parallel", {tasks:[{agent:"a"},{agent:"b"}]}],
 ["chain", {chain:[{agent:"a"},{parallel:[{agent:"b"},{agent:"c"}]}]}],
] as const) {
 test(`top-level ${name} promotion preserves the original executor exactly once`, async () => {
  let registration:any, runs=0;
  const work=deferred<any>();
  const pi={events:{emit(event:string,payload:unknown){if(event.endsWith(":register"))registration=payload}}} as any;
  const ctx={sessionManager:{getSessionFile:()=>"/tmp/session.jsonl"}} as any;
  const returned=executeDetachableSubagent({pi,id:`call-${name}`,params,signal:new AbortController().signal,ctx,execute:async()=>{runs++;return work.promise}});
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(registration.promote().promoted,true);
  const placeholder=await returned;
  assert.equal(placeholder.details.backgroundWork.state,"background");
  work.resolve({content:[{type:"text",text:`${name} done`}],details:{mode:name,results:[{exitCode:0}]}});
  const completion=await registration.completion;
  assert.equal(completion.status,"succeeded");
  assert.equal(runs,1);
  assert.equal(registration.promote().promoted,false);
 });
}

test("outer abort propagates before promotion but not after promotion", async () => {
 for (const promoteFirst of [false,true]) {
  let registration:any, observedAbort=false;
  const outer=new AbortController(), work=deferred<any>();
  const returned=executeDetachableSubagent({pi:{events:{emit(event:string,payload:unknown){if(event.endsWith(":register"))registration=payload}}} as any,id:`abort-${promoteFirst}`,params:{agent:"worker"},signal:outer.signal,ctx:{sessionManager:{getSessionFile:()=>"/tmp/s.jsonl"}} as any,execute:async signal=>{signal.addEventListener("abort",()=>{observedAbort=true});return work.promise}});
  await new Promise<void>(r=>setImmediate(r));
  if(promoteFirst) registration.promote();
  outer.abort();
  assert.equal(observedAbort,!promoteFirst);
  work.resolve({content:[{type:"text",text:"done"}],details:{mode:"single",results:[{exitCode:0}]}});
  if(promoteFirst) await returned; else await registration.completion;
 }
});

test("advisor mission participates in stable job identity and hard cancellation reason",async()=>{
 const previous=process.env.AGENT_HARNESS_MISSION_ID;
 const ids:string[]=[];
 try {
  for(const mission of ["mission-a","mission-b"]){
   process.env.AGENT_HARNESS_MISSION_ID=mission;let registration:any,reason:any;const work=deferred<any>();
   const returned=executeDetachableSubagent({pi:{events:{emit(event:string,payload:unknown){if(event.endsWith(":register"))registration=payload}}} as any,id:"same-call",params:{agent:"worker"},signal:new AbortController().signal,ctx:{sessionManager:{getSessionFile:()=>"/tmp/same.jsonl"}} as any,execute:async signal=>{signal.addEventListener("abort",()=>{reason=signal.reason});return work.promise}});
   await new Promise<void>(r=>setImmediate(r));ids.push(registration.jobId);registration.promote();await returned;registration.cancel();assert.equal(reason.backgroundWorkHardCancel,true);work.resolve({content:[{type:"text",text:"cancelled"}],details:{mode:"single",results:[]}});await registration.completion;
  }
  assert.notEqual(ids[0],ids[1]);
 }finally{if(previous===undefined)delete process.env.AGENT_HARNESS_MISSION_ID;else process.env.AGENT_HARNESS_MISSION_ID=previous}
});

test("coordinator absence leaves execution in foreground",async()=>{
 const work=deferred<any>();
 const returned=executeDetachableSubagent({pi:{events:{emit(){}}} as any,id:"plain",params:{agent:"worker"},signal:new AbortController().signal,ctx:{sessionManager:{getSessionFile:()=>"/tmp/s.jsonl"}} as any,execute:async()=>work.promise});
 work.resolve({content:[{type:"text",text:"ordinary"}],details:{mode:"single",results:[{exitCode:0}]}});
 const result=await returned;
 assert.equal(result.content[0].type,"text");
 assert.equal((result.content[0] as any).text,"ordinary");
});
