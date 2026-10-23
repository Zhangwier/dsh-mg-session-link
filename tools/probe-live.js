// Read-only inspection of the actual running host, mounted briefly by check-live.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { PROJECT } from './paths.mjs';

export const name = 'mg-session-link-live-probe';
export const inject = ['tools', 'agents', 'sessionController', 'systemPrompt'];
export async function apply(ctx) {
  const expected = ['mg_session_list', 'mg_session_delegate', 'mg_session_send', 'mg_session_status', 'mg_session_tasks', 'mg_session_report', 'mg_session_handoff'];
  const observations = [];
  try {
    const agents = ctx.agents.list().filter(agent => agent.session.header.origin !== 'subagent');
    for (const agent of agents) {
      let names, prompt, readinessRetries = 0;
      // The probe and bundle are mounted by the same asynchronous hot reload.
      // Bound the registration wait and keep the retries visible in the evidence.
      for (;;) {
        names = ctx.tools.schemas(agent).map(tool => tool.name);
        prompt = await ctx.systemPrompt.assemble({ scope: agent });
        if (expected.every(name => names.includes(name)) && prompt.sections.some(section => section.name === 'mg-session-link:policy')) break;
        if (readinessRetries >= 10) break;
        readinessRetries++;
        await setTimeout(100);
      }
      observations.push({ sessionId: agent.id, status: agent.status, visiblePeerTools: expected.filter(name => names.includes(name)), toolsCount: names.length, peerPolicyPresent: prompt.sections.some(section => section.name === 'mg-session-link:policy'), readinessRetries });
    }
    const snapshot = await ctx.sessionController.list({});
    await writeFile(join(PROJECT, 'verification-live.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, readOnly: true, noMessagesSent: true, existingSessionsInspected: observations.length, sessionListCount: snapshot.items.length, expectedTools: expected, observations, ok: observations.length > 0 && observations.every(row => row.visiblePeerTools.length === expected.length && row.peerPolicyPresent) }, null, 2));
  } catch (error) {
    await writeFile(join(PROJECT, 'verification-live.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ok: false, error: error.stack }, null, 2));
  }
}
