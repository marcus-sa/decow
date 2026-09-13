/**
 * The request the roadmap is authored for.
 *
 * Its own module because three things need it and one of them is a test: a
 * command script ends in `await main()`, so importing one to reach a constant
 * would run it. It is also the `roadmaps` row id — nWave keys a handover by its
 * request and so does this — which is why the deliver command reads it back out
 * of `run.json` rather than re-deriving it.
 *
 * Fixed rather than an argument. A roadmap is authored FOR something, and what
 * the todo target needs is not a judgement call: two stubs, four pending tests.
 */
export const REQUEST =
  "Implement the stubbed behaviours `complete` and `remove` in src/todo.ts so the pending " +
  "acceptance tests in test/todo.test.ts pass.";
