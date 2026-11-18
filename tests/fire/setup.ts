// Global fast-check configuration for all tests (Requirements 14.11, 14.12).
// numRuns >= 100; verbose 1 makes a failure report the shrunk counterexample,
// the seed and the path, which can be replayed with fc.assert(..., { seed, path }).
import fc from "fast-check";

fc.configureGlobal({ numRuns: 100, verbose: 1 });
