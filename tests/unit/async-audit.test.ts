import {it,expect} from 'vitest';
import {runTask} from '../../src/runtime/run-task.js';
import {syntheticPolicy} from '../../src/runtime/policy.js';
it('awaits durable audit and stops before navigation when the sink fails',async()=>{
 let dispatched=0;const result=await runTask({goal:'test',targetUrl:'http://localhost:3000'},{policy:syntheticPolicy('http://localhost:3000'),model:{model:'test',complete:async()=>{throw Error('no model')}},adapterFactory:{createForTask:async()=>{dispatched++;throw Error('no adapter')}}},{onAudit:async()=>{await Promise.resolve();throw Error('storage failed')}});
 expect(dispatched).toBe(0);expect(result.status).toBe('tool_error');
});
it('cancellation before start dispatches nothing',async()=>{
 let dispatched=0;const controller=new AbortController();controller.abort();await runTask({goal:'test',targetUrl:'http://localhost:3000'},{policy:syntheticPolicy('http://localhost:3000'),model:{model:'test',complete:async()=>{throw Error('no model')}},adapterFactory:{createForTask:async()=>{dispatched++;throw Error('no adapter')}}},{signal:controller.signal});expect(dispatched).toBe(0);
});
