export interface VoicePacket {
  data: Buffer; userID: string; username: string; timestamp: number; arrival: bigint;
}
interface BufferedPacket extends VoicePacket { position: number }
interface SpeakerBuffer { pending: BufferedPacket[]; maximum: number; lastWritten?: number; lastArrival: bigint }

/** Small per-speaker reorder window, based on Craig's 16-packet buffering. */
export class PacketBuffer {
  readonly stats = { duplicatesDropped: 0, latePacketsDropped: 0 };
  private speakers = new Map<string, SpeakerBuffer>();
  private bytes = 0;
  constructor(private window = 16, private maxBytes = 16 * 1024 * 1024) {
    if (!Number.isInteger(window) || window < 1) throw new Error("Invalid packet window.");
  }

  push(packet: VoicePacket): VoicePacket[] {
    if (!packet.data.length || !packet.userID) return [];
    let speaker = this.speakers.get(packet.userID);
    const output: VoicePacket[] = [];
    // A new voice stream can reset RTP timestamps. Begin a fresh epoch after silence.
    if (speaker && packet.arrival - speaker.lastArrival > 2n * 48000n) {
      output.push(...this.drain(speaker));
      this.speakers.delete(packet.userID);
      speaker = undefined;
    }
    if (!speaker) {
      speaker = { pending: [], maximum: packet.timestamp >>> 0, lastArrival: packet.arrival };
      this.speakers.set(packet.userID,speaker);
    }
    const raw = packet.timestamp >>> 0;
    // Signed modular distance handles the 32-bit RTP timestamp rollover.
    const position = speaker.maximum + ((raw - (speaker.maximum >>> 0)) | 0);
    if (speaker.pending.some(item => item.position === position)) {
      this.stats.duplicatesDropped++; return output;
    }
    if (speaker.lastWritten !== undefined && position <= speaker.lastWritten) {
      this.stats.latePacketsDropped++; return output;
    }
    if (this.bytes + packet.data.length > this.maxBytes) throw new Error("Voice reorder buffer exceeded its memory budget.");
    speaker.lastArrival = packet.arrival;
    speaker.maximum = Math.max(speaker.maximum,position);
    speaker.pending.push({ ...packet, data: Buffer.from(packet.data), position });
    this.bytes += packet.data.length;
    speaker.pending.sort((a,b) => a.position-b.position);
    if (speaker.pending.length >= this.window) output.push(this.take(speaker));
    return output;
  }

  private take(speaker: SpeakerBuffer): VoicePacket {
    const packet = speaker.pending.shift()!;
    this.bytes -= packet.data.length;
    speaker.lastWritten = packet.position;
    return packet;
  }
  private drain(speaker: SpeakerBuffer): VoicePacket[] {
    const packets: VoicePacket[] = [];
    while (speaker.pending.length) packets.push(this.take(speaker));
    return packets;
  }
  flushAged(now: bigint): VoicePacket[] {
    const packets: VoicePacket[] = [];
    for (const speaker of this.speakers.values()) {
      if (speaker.pending.some(packet => now-packet.arrival >= 9600n)) packets.push(...this.drain(speaker));
    }
    return packets;
  }
  flush(): VoicePacket[] {
    const packets: VoicePacket[] = [];
    for (const speaker of this.speakers.values()) packets.push(...this.drain(speaker));
    return packets;
  }
}
