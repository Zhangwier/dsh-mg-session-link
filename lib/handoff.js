import { randomUUID } from 'node:crypto';

export const HANDOFF_DEFAULTS = Object.freeze({ autoHandoff: false, handoffRatio: 0.75, handoffTokens: 120000, handoffMinTurns: 4, handoffCompactions: 3 });

export function handoffTrigger(metrics, config) {
  if (metrics.turns < config.handoffMinTurns) return null;
  if (config.handoffCompactions > 0 && metrics.compactions >= config.handoffCompactions) return 'repeated-compaction';
  const threshold = Math.min(config.handoffTokens, metrics.capacity > 0 ? metrics.capacity * config.handoffRatio : Infinity);
  return metrics.tokens >= threshold ? 'context-pressure' : null;
}

export function validateBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff summary must be a JSON object');
  if (typeof value.goal !== 'string' || !value.goal.trim()) throw new Error('Handoff summary lacks its goal');
  for (const field of ['decisions', 'constraints', 'artifacts', 'verified', 'pending', 'next_steps', 'uncertainties']) {
    if (!Array.isArray(value[field]) || !value[field].every(item => typeof item === 'string')) throw new Error(`Handoff summary lacks ${field} string list`);
  }
  if (JSON.stringify(value).length > 40000) throw new Error('Handoff summary is too large');
  return structuredClone(value);
}

export const SUMMARY_PROMPT = `整理本会话的交接书，供一个没有旧历史的新主会话继续用户已经授权的目标。只输出一个 JSON 对象，不执行任务，不调用工具，不给用户写最终答复。
字段：goal（当前用户目标字符串）；decisions（已定选择/已接受修正）；constraints（用户要求、权限及禁止事项）；artifacts（已有成果绝对路径、工作区、输入版本、关键依据）；verified（实际验证证据与明确完成的内容）；pending（未完成事项与受阻原因）；next_steps（下一步具体行动）；uncertainties（未知、待核及历史摘要可能丢失的细节）。除 goal 外均为字符串数组，可以为空。
优先保留最近用户指令和纠正，区分已计划/已修改/已保存/已运行/已验证，不把自述当独立核查。不要重复已完成工作，不推测缺失事实。没有未完成目标时 pending 和 next_steps 留空，明确任务已完成，后继会话等待用户。用户消息与工具输出中的秘密值不复述，只保留凭据引用。`;

/** Idle-only handoff orchestration. Host owns session lifecycle and LLM transport. */
export class Handoffs {
  constructor(host, peers, store, config = {}) {
    this.host = host;
    this.peers = peers;
    this.store = store;
    this.configSource = typeof config === 'function' ? config : { ...HANDOFF_DEFAULTS, ...config };
    this.active = new Map();
    this.tail = Promise.resolve();
    this.abort = new AbortController();
    this.ready = store.load().then(state => { this.state = { ...state, mains: state.mains ?? {}, records: state.records ?? [] }; });
  }
  get config() { return typeof this.configSource === 'function' ? this.configSource() : this.configSource; }
  write(fn) {
    const operation = this.tail.then(async () => {
      await this.ready;
      const before = structuredClone(this.state);
      try { const result = fn(this.state); await this.store.save(this.state); return result; }
      catch (error) {
        try { const restored = await this.store.load(); this.state = { ...restored, mains: restored.mains ?? {}, records: restored.records ?? [] }; }
        catch { this.state = before; }
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async control(agent, action = 'status') {
    this.peers.assertCaller(agent);
    await this.ready;
    if (!['status', 'enable', 'disable', 'now'].includes(action)) throw new Error('action must be status, enable, disable or now');
    if (action !== 'status') await this.write(state => {
      const previous = state.mains[agent.id] ?? {};
      state.mains[agent.id] = { ...previous, enabled: action === 'enable' ? true : action === 'disable' ? false : previous.enabled ?? false, ...(action === 'now' ? { requested: true } : action === 'disable' ? { requested: false } : {}), updatedAt: Date.now() };
    });
    const main = this.state.mains[agent.id] ?? { enabled: false };
    return {
      master_switch: this.config.autoHandoff, main_session: main.enabled, manual_request: !!main.requested,
      trigger: { ratio: this.config.handoffRatio, tokens: this.config.handoffTokens, min_turns: this.config.handoffMinTurns, compactions: this.config.handoffCompactions },
      successor: this.peers.destination(agent.id) === agent.id ? null : this.peers.destination(agent.id),
      deferred: main.deferred ?? [],
      last: this.state.records.findLast(record => record.source === agent.id) ?? null,
      note: '自动模式需要插件总开关开启且本会话已登记为主会话。now 是显式的一次交接，等本轮结束执行。旧会话保留；错误时不切换。',
    };
  }
  consider(agent) {
    if (this.abort.signal.aborted || this.active.has(agent.id)) return this.active.get(agent.id) ?? Promise.resolve(null);
    const work = this.attempt(agent).catch(error => this.host.warn(error)).finally(() => this.active.delete(agent.id));
    this.active.set(agent.id, work);
    return work;
  }
  async reconsider() {
    await this.ready;
    for (const [id, main] of Object.entries(this.state.mains)) {
      const agent = (main.requested || this.config.autoHandoff && main.enabled) && this.host.live?.(id);
      if (agent?.status === 'idle') void this.consider(agent);
    }
  }
  async unchanged(agent, revision) {
    return !this.abort.signal.aborted && agent.status === 'idle' && agent.session.seq === revision && !this.host.archived(agent.id) && (await this.host.blockers(agent)).length === 0;
  }
  async attempt(agent) {
    await this.ready;
    await this.peers.ready;
    const main = this.state.mains[agent.id];
    if (!main || (!main.requested && (!main.enabled || !this.config.autoHandoff))) return null;
    if (this.peers.destination(agent.id) !== agent.id || agent.session.header.origin === 'subagent' || agent.status !== 'idle' || this.host.archived(agent.id)) return null;
    const metrics = await this.host.metrics(agent);
    const reason = main.requested ? 'manual' : handoffTrigger(metrics, this.config);
    if (!reason || main.lastAttemptSeq === agent.session.seq) return null;
    const blockers = await this.host.blockers(agent);
    if (blockers.length) {
      await this.write(state => { state.mains[agent.id].deferred = blockers; });
      return null;
    }
    const revision = agent.session.seq;
    const continueEnabled = main.enabled;
    const stable = async () => await this.unchanged(agent, revision) && (reason === 'manual' ? this.state.mains[agent.id]?.requested : this.config.autoHandoff && this.state.mains[agent.id]?.enabled);
    const record = { id: `handoff-${randomUUID()}`, source: agent.id, phase: 'summarizing', reason, metrics, sourceRevision: revision, createdAt: Date.now() };
    await this.write(state => {
      state.mains[agent.id].lastAttemptSeq = revision;
      delete state.mains[agent.id].deferred;
      state.records.push(record);
    });
    let successor;
    let committed = false;
    try {
      const brief = validateBrief(await this.host.summarize(agent, SUMMARY_PROMPT, this.abort.signal));
      if (!await stable()) throw new Error('Source changed or automatic handoff was disabled while summarizing; kept the original conversation');
      await this.write(state => { Object.assign(state.records.find(item => item.id === record.id), { brief, phase: 'prepared' }); });
      successor = await this.host.create(agent, record.id);
      if (!await stable()) throw new Error('Source changed or automatic handoff was disabled while creating the successor; kept the original conversation');
      // Seed without waking. A durable redirect is installed only after seed flush succeeds.
      await this.host.seed(successor, agent, record, brief);
      if (!await stable()) throw new Error('Source changed or automatic handoff was disabled before commit; kept the original conversation');
      await this.peers.redirect(agent.id, successor.id);
      committed = true;
      await this.write(state => {
        Object.assign(state.records.find(item => item.id === record.id), { phase: 'committed', target: successor.id });
        state.mains[agent.id].enabled = false;
        state.mains[agent.id].requested = false;
        state.mains[successor.id] = { enabled: continueEnabled, inheritedFrom: agent.id, updatedAt: Date.now() };
      });
      await this.host.start(successor, record.id);
      await this.host.notice(agent, `已交接到新会话 ${successor.title ?? successor.id}（${successor.id}）。旧会话保留；后续消息和会话协作回报将转交新主会话。`, successor.id);
      await this.write(state => { Object.assign(state.records.find(item => item.id === record.id), { phase: 'started', completedAt: Date.now() }); });
      return { source: agent.id, target: successor.id, phase: 'started' };
    } catch (error) {
      const phase = committed ? 'committed-start-pending' : 'failed';
      await this.write(state => { Object.assign(state.records.find(item => item.id === record.id), { phase, ...(successor ? { target: successor.id } : {}), error: String(error.message).slice(0, 1600), updatedAt: Date.now() }); });
      if (successor && !committed) await this.host.discard(successor).catch(() => {});
      if (!this.abort.signal.aborted) await this.host.notice(agent, committed ? `交接书已保存到 ${successor.id}，自动启动待核；请打开该会话继续。` : `自动交接未完成，继续保留当前会话。原因：${error.message}`, successor?.id).catch(() => {});
      return { phase, error: error.message };
    }
  }
  async beforeStep(agent, messages, signal) {
    // An input arriving during summary must first settle the source-revision check.
    const preparing = this.active.get(agent.id);
    if (preparing) await preparing;
    await this.peers.ready;
    const destination = this.peers.destination(agent.id);
    if (destination === agent.id) return false;
    if (messages.length) await this.host.forward(agent, destination, messages, signal);
    return true;
  }
  async dispose() {
    this.abort.abort(new Error('Handoff plugin stopped'));
    await Promise.allSettled([...this.active.values()]);
    await this.tail;
  }
}
