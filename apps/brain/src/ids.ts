export interface EventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}

let lastTimestamp = -1;
let eventSequence = 0;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("UUIDv7 timestamp must be a non-negative 48-bit integer");
  }
  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function localWorldDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function nextEventStamp(now = Date.now()): EventStamp {
  const timestamp = Math.max(now, lastTimestamp);
  if (timestamp === lastTimestamp) eventSequence += 1;
  else {
    lastTimestamp = timestamp;
    eventSequence = 0;
  }
  return {
    id: `brain-${timestamp.toString().padStart(13, "0")}-${eventSequence.toString().padStart(4, "0")}`,
    t: timestamp,
    worldDate: localWorldDate(timestamp),
  };
}
