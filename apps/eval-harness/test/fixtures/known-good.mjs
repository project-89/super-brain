// Synthetic oracle-validation fixture. Never label this authored implementation as a model attempt.
export function reduceDelivery(state, arrivals) {
  const max = 9223372036854775807n;
  function position(value, arrival = false) {
    if (typeof value !== 'string' || value.trim() !== value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('position');
    const number = BigInt(value);
    if (number > max || (arrival && number === 0n)) throw new Error('position');
    return number;
  }
  function json(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(json);
    return typeof value === 'object' && Object.values(value).every(json);
  }
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  function valid(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.id !== 'string' || event.id.length === 0 || !Number.isSafeInteger(event.t) || event.t < 0 || !Object.hasOwn(event,'payload') || !json(event.payload)) throw new Error('event');
  }
  if (!state || typeof state !== 'object' || !Array.isArray(state.events) || !Array.isArray(arrivals)) throw new Error('input');
  const initial = position(state.checkpoint);
  let checkpoint = initial;
  const retained = new Map(); const identities = new Map(); const positions = new Map();
  function remember(event) {
    valid(event);
    const immutable = canonical(event);
    if (identities.has(event.id) && identities.get(event.id) !== immutable) throw new Error('identity');
    identities.set(event.id, immutable);
    return immutable;
  }
  for (const event of state.events) { remember(event); retained.set(event.id,event); }
  for (const arrival of arrivals) {
    if (!arrival || typeof arrival !== 'object') throw new Error('arrival');
    const sequence = position(arrival.sequence, true);
    const immutable = remember(arrival.event);
    if (positions.has(arrival.sequence) && positions.get(arrival.sequence) !== immutable) throw new Error('sequence conflict');
    positions.set(arrival.sequence,immutable);
    if (sequence > initial) retained.set(arrival.event.id,arrival.event);
    if (sequence > checkpoint) checkpoint = sequence;
  }
  const events = [...retained.values()].sort((a,b)=>a.t-b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { checkpoint: checkpoint.toString(), events };
}
