/**
 * Append-only encounter event log (spec §10).
 *
 * Nothing in the encounter is ever mutated in place without a log entry that
 * explains how the change happened. The derived graph snapshot is rebuilt from
 * this log, so every state the UI ever showed can be reconstructed and audited.
 */
import {
  EncounterEvent,
  EventType,
  IsoDateTime,
  SCHEMA_VERSION,
  Speaker,
  newId,
  utcnow,
} from './models.ts';

export class EncounterEventStore {
  private eventsList: EncounterEvent[] = [];
  private nextSeq = 1;
  private seenEventIds = new Set<string>();
  private seenProviderItemIds = new Set<string>();

  constructor(public encounterId: string) {}

  get events(): EncounterEvent[] {
    return [...this.eventsList];
  }

  nextSequence(): number {
    return this.nextSeq;
  }

  hasEventId(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  hasProviderItem(providerItemId: string): boolean {
    return this.seenProviderItemIds.has(providerItemId);
  }

  append(
    eventType: EventType,
    payload: Record<string, unknown> = {},
    options: {
      eventId?: string;
      providerItemId?: string | null;
      speaker?: Speaker | null;
      sequence?: number;
      occurredAt?: IsoDateTime;
    } = {},
  ): EncounterEvent {
    const event: EncounterEvent = {
      event_id: options.eventId ?? newId('evt'),
      encounter_id: this.encounterId,
      event_type: eventType,
      occurred_at: options.occurredAt ?? utcnow(),
      sequence: options.sequence ?? this.nextSeq,
      provider_item_id: options.providerItemId ?? null,
      speaker: options.speaker ?? null,
      payload,
      schema_version: SCHEMA_VERSION,
    };
    this.eventsList.push(event);
    this.seenEventIds.add(event.event_id);
    if (event.provider_item_id) {
      this.seenProviderItemIds.add(event.provider_item_id);
    }
    this.nextSeq = Math.max(this.nextSeq, event.sequence) + 1;
    return event;
  }

  eventsOf(...types: EventType[]): EncounterEvent[] {
    const wanted = new Set<string>(types);
    return this.eventsList.filter((e) => wanted.has(e.event_type));
  }
}
