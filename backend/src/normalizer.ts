/**
 * Deterministic concept normalization controlled by the approved synonym index.
 *
 * An unknown medication name is never assigned to a concept or class merely
 * because an extraction model believes it belongs there (spec §13.3). Ambiguous
 * aliases ("the pill", "contraception", class words) normalize to AMBIGUOUS with
 * an explicit missing-information message and can never trigger a match.
 */
import { EvidenceIndex } from './evidenceIndex.ts';
import {
  ExtractedMention,
  MentionCategory,
  NormalizationStatus,
  NormalizedMention,
  makeNormalizedMention,
} from './models.ts';

export class ConceptNormalizer {
  constructor(private index: EvidenceIndex) {}

  normalize(mentions: ExtractedMention[]): NormalizedMention[] {
    return mentions.map((m) => this.normalizeOne(m));
  }

  normalizeOne(mention: ExtractedMention): NormalizedMention {
    const ontology = this.index.ontology;
    const surface = (mention.normalized_candidate ?? mention.surface_text).toLowerCase().trim();
    const rawSurface = mention.surface_text.toLowerCase().trim();

    if (mention.category === MentionCategory.HORMONAL_PRODUCT) {
      const conceptId = this.index.alias_to_hormonal[surface] ?? this.index.alias_to_hormonal[rawSurface];
      if (conceptId) {
        return makeNormalizedMention({
          mention,
          concept_id: conceptId,
          canonical_name: ontology.canonicalName(conceptId),
          normalization_status: NormalizationStatus.NORMALIZED,
        });
      }
      const ambiguous = findAmbiguous(surface, rawSurface, ontology.ambiguous_hormonal_aliases);
      if (ambiguous) {
        return makeNormalizedMention({
          mention,
          normalization_status: NormalizationStatus.AMBIGUOUS,
          missing_information: ambiguous.missingInformation,
          candidate_concept_ids: [...(ambiguous.candidates ?? [])],
        });
      }
      return makeNormalizedMention({
        mention,
        normalization_status: NormalizationStatus.UNKNOWN,
        missing_information:
          'The stated hormonal product could not be normalized against the approved synonym index.',
      });
    }

    const conceptId = this.index.alias_to_medication[surface] ?? this.index.alias_to_medication[rawSurface];
    if (conceptId) {
      return makeNormalizedMention({
        mention,
        concept_id: conceptId,
        canonical_name: ontology.canonicalName(conceptId),
        normalization_status: NormalizationStatus.NORMALIZED,
      });
    }
    const ambiguous = findAmbiguous(surface, rawSurface, ontology.ambiguous_medication_aliases);
    if (ambiguous) {
      return makeNormalizedMention({
        mention,
        normalization_status: NormalizationStatus.AMBIGUOUS,
        missing_information: ambiguous.missingInformation,
        candidate_concept_ids: [...(ambiguous.candidates ?? [])],
      });
    }
    if (
      ontology.non_interacting_medications.includes(surface) ||
      ontology.non_interacting_medications.includes(rawSurface)
    ) {
      return makeNormalizedMention({
        mention,
        canonical_name: rawSurface,
        normalization_status: NormalizationStatus.NON_INTERACTING,
      });
    }
    return makeNormalizedMention({
      mention,
      normalization_status: NormalizationStatus.UNKNOWN,
      missing_information:
        'The stated medication could not be normalized against the approved synonym index.',
    });
  }
}

function findAmbiguous(
  surface: string,
  rawSurface: string,
  table: Record<string, { missingInformation: string; candidates?: string[] }>,
): { missingInformation: string; candidates?: string[] } | null {
  for (const key of [surface, rawSurface]) {
    if (key in table) return table[key];
  }
  return null;
}
