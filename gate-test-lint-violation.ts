// TEMPORARY: Gate effectiveness test for CI lint check.
// This file contains a deliberate Biome lint violation (unused variable).
// It will be reverted immediately after CI confirms the gate catches it.
// See PHASE-001-T5 gate validation requirement.
const _unusedVariable = "this will trigger biome noUnusedVariables";
var x = 1; // var usage is also flagged by biome noVar rule
