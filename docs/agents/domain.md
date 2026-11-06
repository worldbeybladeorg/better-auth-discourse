# Domain docs

## Before exploring

Read `GLOSSARY.md` at the repository root and relevant ADRs under
`docs/adr/`.

If these files do not exist, proceed silently. The domain-modeling
skill creates them lazily when terms or decisions are resolved.

## Layout

Single-context:
- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architectural decision records.

## Vocabulary

Use the glossary's terms when naming domain concepts in issues,
proposals, hypotheses, and tests. Respect explicitly avoided synonyms.

If a needed concept is missing, reconsider whether it belongs to the
domain; note genuine gaps for domain-modeling.

## ADR conflicts

Explicitly flag proposals that contradict an existing ADR, identifying
the ADR and explaining why its decision should be reopened.
