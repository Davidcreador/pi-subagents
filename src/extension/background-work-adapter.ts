import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details } from "../shared/types.ts";

const REGISTER="background-work:v1:register", UNREGISTER="background-work:v1:unregister", VERSION=1 as const;
const adapterInstanceId=randomUUID();
const hash=(s:string,n:number)=>createHash("sha1").update(s).digest("hex").slice(0,n);
const text=(r:AgentToolResult<Details>)=>r.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");

/** Promote only top-level foreground orchestration; the original executor promise remains authoritative. */
export async function executeDetachableSubagent(input:{pi:ExtensionAPI;id:string;params:{agent?:unknown;tasks?:unknown[];chain?:unknown[]};signal:AbortSignal;onUpdate?:((r:AgentToolResult<Details>)=>void);ctx:ExtensionContext;execute:(signal:AbortSignal,onUpdate:(r:AgentToolResult<Details>)=>void)=>Promise<AgentToolResult<Details>>}):Promise<AgentToolResult<Details>> {
 const startedAt=Date.now();
 const file=input.ctx.sessionManager.getSessionFile();
 const sessionId=file?hash(file,16):`ephemeral-${process.pid}`;
 // Group isolation id: generic env first, harness advisor alias second.
 const groupId=process.env.PI_BACKGROUND_WORK_GROUP_ID??process.env.AGENT_HARNESS_MISSION_ID;
 const jobId=`bg-${hash(`${sessionId}:${groupId??"ordinary"}:${input.id}`,8)}`;
 const controller=new AbortController();
 const backgroundSignal=Object.assign(controller.signal,{backgroundWorkSessionId:sessionId}) as AbortSignal&{backgroundWorkPromoted?:boolean;backgroundWorkSessionId:string};
 let phase:"foreground"|"promoted"|"completed"="foreground", release!:()=>void;
 let latestOutput:string|undefined;
 const promoted=new Promise<void>(r=>release=r);
 const outerAbort=()=>{if(phase==="foreground")controller.abort(input.signal.reason)};
 if(input.signal.aborted)outerAbort();else input.signal.addEventListener("abort",outerAbort,{once:true});
 const outcome=input.execute(controller.signal,r=>{latestOutput=text(r).slice(-50*1024);if(phase==="foreground")input.onUpdate?.(r)}).then(result=>({ok:true as const,result}),error=>({ok:false as const,error}));
 const mode=Array.isArray(input.params.chain)?"chain":Array.isArray(input.params.tasks)?"parallel":"single";
 const label=mode==="single"?String(input.params.agent??"subagent"):`${mode} (${Array.isArray(input.params.chain)?input.params.chain.length:(input.params.tasks as unknown[]).length})`;
 const completion=outcome.then(done=>{const finishedAt=Date.now();if(!done.ok)return{jobId,status:controller.signal.aborted?"cancelled" as const:"failed" as const,finishedAt,durationMs:finishedAt-startedAt,summary:`Subagent ${mode} failed.`,error:done.error instanceof Error?done.error.message:String(done.error)};const failed=done.result.details.results.some(r=>typeof r.exitCode==="number"&&r.exitCode!==0);return{jobId,status:controller.signal.aborted?"cancelled" as const:done.result.details.timedOut?"timed-out" as const:failed?"failed" as const:"succeeded" as const,finishedAt,durationMs:finishedAt-startedAt,summary:`Subagent ${mode} completed (${done.result.details.results.length} result(s)).`,output:text(done.result),artifactPath:done.result.details.truncation?.artifactPath??done.result.details.artifacts?.dir}});
 const inspect=()=>({jobId,sessionId,groupId,toolCallId:input.id,toolName:"subagent",kind:"subagent" as const,label,startedAt,state:phase==="promoted"?"background-running" as const:"foreground-running" as const,mutationRisk:"unknown" as const,latestOutput});
 input.pi.events.emit(REGISTER,{protocolVersion:VERSION,adapterInstanceId,...inspect(),promote(){if(phase!=="foreground")return{promoted:false,jobId};phase="promoted";backgroundSignal.backgroundWorkPromoted=true;input.signal.removeEventListener("abort",outerAbort);release();return{promoted:true,jobId}},cancel(){const reason=Object.assign(new Error("Background subagent hard cancelled"),{backgroundWorkHardCancel:true});controller.abort(reason)},inspect,completion});
 const winner=await Promise.race([outcome.then(value=>({type:"outcome" as const,value})),promoted.then(()=>({type:"promoted" as const}))]);
 if(winner.type==="promoted")return{content:[{type:"text",text:`Backgrounded top-level subagent run as ${jobId}. Inspect with /background-jobs.`}],details:{mode:"management",results:[],backgroundWork:{jobId,state:"background"}}};
 phase="completed";input.signal.removeEventListener("abort",outerAbort);input.pi.events.emit(UNREGISTER,{protocolVersion:VERSION,jobId,adapterInstanceId});if(!winner.value.ok)throw winner.value.error;return winner.value.result;
}
